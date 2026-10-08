import { eq } from "drizzle-orm";
import * as z from "zod";
import { db } from "@/db";
import { page, user, type ApiTokenScope } from "@/db/schema";
import { AccessError } from "@/server/access";
import { getPage } from "@/server/pages";
import * as ops from "@/server/operations";
import { ApiError } from "./errors";
import { cursorInput, decodeCursor, nextCursor, paginate } from "./pagination";
import type { ApiPrincipal } from "./tokens";

/**
 * The REST API's endpoints. Each one names the scope it needs and its query and body schemas; the
 * handler (api/handler.ts) checks the token, the scope and the input, and the OpenAPI document
 * (api/openapi.ts) is built from this same table. Handlers call the operations the MCP tools use
 * (server/operations.ts), so both surfaces check and answer alike.
 */

export type ApiCall<Q, B> = {
  principal: ApiPrincipal;
  ctx: ops.OperationContext;
  params: Record<string, string>;
  query: Q;
  body: B;
};

type Schema = z.ZodObject;

export type ApiRoute<Q extends Schema = Schema, B extends Schema = Schema> = {
  method: "GET" | "POST" | "PATCH";
  /** Relative to /api/v1, with `{name}` path parameters. */
  path: string;
  operationId: string;
  tag: "Account" | "Workspaces" | "Pages" | "Databases" | "Rows" | "Comments";
  summary: string;
  description?: string;
  scope: ApiTokenScope;
  query?: Q;
  body?: B;
  /** 201 for endpoints that create something. */
  status?: 200 | 201;
  /** Name of the response schema in the OpenAPI components. */
  response: string;
  handler: (call: ApiCall<z.infer<Q>, z.infer<B>>) => Promise<unknown>;
};

export const defineRoute = <Q extends Schema = Schema, B extends Schema = Schema>(def: ApiRoute<Q, B>) => def as unknown as ApiRoute;

// ---------------------------------------------------------------------------- workspace-bound tokens

/** A token bound to a workspace sees nothing outside it: other workspaces read as not found. */
function requireWorkspace(principal: ApiPrincipal, workspaceId: string) {
  if (principal.workspaceId && principal.workspaceId !== workspaceId) throw new AccessError();
}

async function requirePageInWorkspace(principal: ApiPrincipal, pageId: string) {
  if (!principal.workspaceId) return;
  const [row] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, pageId)).limit(1);
  if (!row || row.workspaceId !== principal.workspaceId) throw new AccessError();
}

/** Drops the hints meant for AI assistants (they name MCP tools); REST clients read the fields. */
function withoutNote<T extends object>(value: T): Omit<T, "note"> {
  const { note: _note, ...rest } = value as T & { note?: unknown };
  return rest;
}

const limitInput = (max: number, fallback: number) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(max)
    .default(fallback)
    .describe(`How many items to return (1-${max}, default ${fallback}).`);

/** Search reads matches up to this position; beyond it the query needs narrowing. */
const MAX_SEARCH_WINDOW = 500;

const pageBodies = {
  updatePage: ops.inputs.updatePage.omit({ page_id: true }).extend({
    icon: z.string().max(16).nullable().optional().describe("A single emoji used as the page icon; null removes it."),
  }),
  movePage: ops.inputs.movePage.omit({ page_id: true }),
  addComment: ops.inputs.addComment.omit({ page_id: true }),
};

const listQuery = z.object({ limit: limitInput(100, 50), cursor: cursorInput });

export const API_ROUTES: ApiRoute[] = [
  defineRoute({
    method: "GET",
    path: "/me",
    operationId: "getMe",
    tag: "Account",
    summary: "The token's user and settings",
    description: "Who the token acts for, its scopes, the workspace it is limited to (if any) and when it expires.",
    scope: "pages:read",
    response: "Me",
    handler: async ({ principal }) => {
      const [row] = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.id, principal.userId));
      return {
        user: row,
        token: {
          id: principal.tokenId,
          scopes: principal.scopes,
          workspace_id: principal.workspaceId,
          expires_at: principal.expiresAt?.toISOString() ?? null,
        },
      };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/workspaces",
    operationId: "listWorkspaces",
    tag: "Workspaces",
    summary: "List workspaces",
    description: "The workspaces the user belongs to (only the token's workspace for a workspace-bound token), with the user's role.",
    scope: "pages:read",
    response: "WorkspaceList",
    handler: async ({ principal, ctx }) => {
      const { workspaces } = await ops.listWorkspaces(ctx);
      return { workspaces: workspaces.filter((w) => !principal.workspaceId || w.id === principal.workspaceId) };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/workspaces/{workspace_id}/pages",
    operationId: "listWorkspacePages",
    tag: "Workspaces",
    summary: "List top-level pages",
    description:
      "The pages at the top of a workspace's tree (with parent_id: the pages directly under that page), in sidebar order. Trashed pages and templates are left out.",
    scope: "pages:read",
    query: listQuery.extend({
      parent_id: z.string().optional().describe("List the pages under this page instead."),
      teamspace_id: z
        .string()
        .optional()
        .describe('Top level only: just this teamspace\'s pages, or "private" for the user\'s private pages.'),
    }),
    response: "PageList",
    handler: async ({ principal, ctx, params, query }) => {
      requireWorkspace(principal, params.workspace_id);
      const { pages } = await ops.listPages(ctx, {
        workspace_id: params.workspace_id,
        parent_id: query.parent_id,
        teamspace_id: query.teamspace_id,
      });
      const { items, ...more } = paginate(pages, query.cursor, query.limit);
      return { pages: items, ...more };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/workspaces/{workspace_id}/teamspaces",
    operationId: "listTeamspaces",
    tag: "Workspaces",
    summary: "List teamspaces",
    description:
      'The teamspaces of a workspace the user can see (all but private ones they aren\'t in), oldest first. Pages at the top of a workspace belong to a teamspace or are private to the user who made them: pass teamspace_id (or "private") when creating or moving top-level pages.',
    scope: "pages:read",
    query: z.object({
      include_archived: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true")
        .describe("Also list archived teamspaces."),
    }),
    response: "TeamspaceList",
    handler: async ({ principal, ctx, params, query }) => {
      requireWorkspace(principal, params.workspace_id);
      return withoutNote(await ops.listTeamspaces(ctx, { workspace_id: params.workspace_id, include_archived: query.include_archived }));
    },
  }),
  defineRoute({
    method: "GET",
    path: "/workspaces/{workspace_id}/groups",
    operationId: "listGroups",
    tag: "Workspaces",
    summary: "List groups",
    description:
      "The member groups of a workspace, by name: named sets of its owners and members that pages are shared with and teamspaces joined by, with who is in each and the teamspaces each joined (among those the user can see). Guests can't list them.",
    scope: "pages:read",
    response: "GroupList",
    handler: async ({ principal, ctx, params }) => {
      requireWorkspace(principal, params.workspace_id);
      return ops.listGroups(ctx, { workspace_id: params.workspace_id });
    },
  }),
  defineRoute({
    method: "GET",
    path: "/search",
    operationId: "search",
    tag: "Pages",
    summary: "Search pages",
    description:
      "Search over page titles and bodies (database rows included), best matches first: full-text, merged with semantic search (by meaning) when the server has an embeddings model. `match` says how each result was found.",
    scope: "pages:read",
    query: z.object({
      query: z.string().min(1).describe("Words to look for."),
      workspace_id: z.string().optional().describe("Only search this workspace."),
      limit: limitInput(50, 10),
      cursor: cursorInput,
    }),
    response: "SearchResults",
    handler: async ({ principal, ctx, query }) => {
      if (query.workspace_id) requireWorkspace(principal, query.workspace_id);
      const offset = decodeCursor(query.cursor);
      if (offset + query.limit > MAX_SEARCH_WINDOW) {
        throw new ApiError(400, "invalid_request", `Search returns the first ${MAX_SEARCH_WINDOW} matches; narrow the query.`);
      }
      const { results } = await ops.search(ctx, {
        query: query.query,
        workspace_id: query.workspace_id ?? principal.workspaceId ?? undefined,
        limit: offset + query.limit + 1,
      });
      const next = results.length > offset + query.limit ? nextCursor(offset, query.limit, results.length) : null;
      return { results: results.slice(offset, offset + query.limit), next_cursor: next, has_more: next !== null };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/pages",
    operationId: "createPage",
    tag: "Pages",
    summary: "Create a page",
    description:
      "Creates a page at the top of a workspace (workspace_id; in the teamspace teamspace_id names, else private to the user) or under another page (parent_id), with an optional Markdown body, or copies a page template. To add a row to a database, use the rows endpoint.",
    scope: "pages:write",
    body: ops.inputs.createPage,
    status: 201,
    response: "PageCreated",
    handler: async ({ principal, ctx, body }) => {
      if (body.parent_id) await requirePageInWorkspace(principal, body.parent_id);
      else if (body.workspace_id) requireWorkspace(principal, body.workspace_id);
      const workspaceId = body.parent_id ? body.workspace_id : (body.workspace_id ?? principal.workspaceId ?? undefined);
      return ops.createPage(ctx, { ...body, workspace_id: workspaceId });
    },
  }),
  defineRoute({
    method: "GET",
    path: "/pages/{page_id}",
    operationId: "getPage",
    tag: "Pages",
    summary: "Read a page",
    description:
      "Title, icon, breadcrumb path and the whole body as Markdown, with sub-pages, databases shown in the body and pages linking here. A database row also has its property values; a database has its property list instead of a body.",
    scope: "pages:read",
    response: "Page",
    handler: async ({ principal, ctx, params }) => {
      await requirePageInWorkspace(principal, params.page_id);
      return withoutNote(await ops.getPage(ctx, { page_id: params.page_id, offset: 0 }, { maxMarkdownChars: Infinity }));
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/pages/{page_id}",
    operationId: "updatePage",
    tag: "Pages",
    summary: "Update a page",
    description:
      'Changes the title, icon, background and/or body. mode "replace" overwrites the body with the Markdown given, "append" adds it to the end. The previous body is saved to page history first, and open editors update live.',
    scope: "pages:write",
    body: pageBodies.updatePage,
    response: "PageChanged",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.page_id);
      return ops.updatePage(ctx, { ...body, page_id: params.page_id });
    },
  }),
  defineRoute({
    method: "GET",
    path: "/pages/{page_id}/children",
    operationId: "listChildPages",
    tag: "Pages",
    summary: "List sub-pages",
    description: "The pages directly under a page, in order. For the rows of a database, query the database instead.",
    scope: "pages:read",
    query: listQuery,
    response: "PageList",
    handler: async ({ principal, ctx, params, query }) => {
      await requirePageInWorkspace(principal, params.page_id);
      const parent = await getPage(ctx.userId, params.page_id);
      const { pages } = await ops.listPages(ctx, { workspace_id: parent.workspaceId, parent_id: parent.id });
      const { items, ...more } = paginate(pages, query.cursor, query.limit);
      return { pages: items, ...more };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/pages/{page_id}/move",
    operationId: "movePage",
    tag: "Pages",
    summary: "Move a page",
    description:
      "Moves a page with its sub-pages under another page of the same workspace, or to the top level with parent_id null (of the teamspace teamspace_id names, of the user's private pages with \"private\", or of its current teamspace). A page that lands in another teamspace takes that teamspace's access. Moving a page into a database makes it a row; moving a row out makes it a page.",
    scope: "pages:write",
    body: pageBodies.movePage,
    response: "PageMoved",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.page_id);
      if (body.parent_id) await requirePageInWorkspace(principal, body.parent_id);
      return withoutNote(
        await ops.movePage(ctx, { page_id: params.page_id, parent_id: body.parent_id, teamspace_id: body.teamspace_id }),
      );
    },
  }),
  defineRoute({
    method: "POST",
    path: "/pages/{page_id}/archive",
    operationId: "archivePage",
    tag: "Pages",
    summary: "Move a page to the trash",
    description: "Moves a page with its sub-pages (or a database with its rows) to the trash. Restoring brings it back.",
    scope: "pages:write",
    response: "PageTrashState",
    handler: async ({ principal, ctx, params }) => {
      await requirePageInWorkspace(principal, params.page_id);
      return withoutNote(await ops.archivePage(ctx, { page_id: params.page_id }));
    },
  }),
  defineRoute({
    method: "POST",
    path: "/pages/{page_id}/restore",
    operationId: "restorePage",
    tag: "Pages",
    summary: "Restore a page from the trash",
    description: "Brings a trashed page back with its sub-pages. If its parent is still in the trash, it returns to the top level.",
    scope: "pages:write",
    response: "PageTrashState",
    handler: async ({ principal, ctx, params }) => {
      await requirePageInWorkspace(principal, params.page_id);
      return withoutNote(await ops.restorePage(ctx, { page_id: params.page_id }));
    },
  }),
  defineRoute({
    method: "GET",
    path: "/pages/{page_id}/comments",
    operationId: "listComments",
    tag: "Comments",
    summary: "List comments",
    description: "The page's comment threads, oldest first, with the text each is about. Resolved threads only with include_resolved.",
    scope: "pages:read",
    query: z.object({ include_resolved: z.stringbool().default(false).describe("Also list resolved threads (true or false).") }),
    response: "CommentThreads",
    handler: async ({ principal, ctx, params, query }) => {
      await requirePageInWorkspace(principal, params.page_id);
      return ops.listComments(ctx, { page_id: params.page_id, include_resolved: query.include_resolved });
    },
  }),
  defineRoute({
    method: "POST",
    path: "/pages/{page_id}/comments",
    operationId: "addComment",
    tag: "Comments",
    summary: "Comment on a page",
    description:
      "Starts a thread on text of the page (quote: copied exactly from the body, within one paragraph) or replies in a thread (thread_id). People in the thread are notified.",
    scope: "pages:write",
    body: pageBodies.addComment,
    status: 201,
    response: "CommentCreated",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.page_id);
      return ops.addComment(ctx, { ...body, page_id: params.page_id });
    },
  }),
  defineRoute({
    method: "GET",
    path: "/databases/{database_id}",
    operationId: "getDatabase",
    tag: "Databases",
    summary: "Get a database's schema",
    description: "Properties (name, type, options), views with their settings, filters and sorts, and the row count.",
    scope: "pages:read",
    response: "Database",
    handler: async ({ principal, ctx, params }) => {
      await requirePageInWorkspace(principal, params.database_id);
      return ops.getDatabase(ctx, { database_id: params.database_id });
    },
  }),
  defineRoute({
    method: "POST",
    path: "/databases/{database_id}/query",
    operationId: "queryDatabase",
    tag: "Databases",
    summary: "Query rows",
    description:
      'Rows matching filters, in the order of sorts (or a saved view\'s), a page at a time. Filters name properties (or "title", "created_at", "updated_at") and use option names as values; ops: contains, equals, not_equals, is_empty, is_not_empty, gt, lt, is_within. A chart view also returns what it plots.',
    scope: "pages:read",
    body: ops.inputs.queryDatabase.omit({ database_id: true }).extend({ cursor: cursorInput }),
    response: "QueryResult",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.database_id);
      const { cursor, ...args } = body;
      const offset = decodeCursor(cursor);
      const result = withoutNote(await ops.queryDatabase(ctx, { ...args, database_id: params.database_id }, { offset }));
      const next = nextCursor(offset, args.limit, result.total);
      return { ...result, next_cursor: next, has_more: next !== null };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/databases/{database_id}/rows",
    operationId: "createRow",
    tag: "Rows",
    summary: "Add a row",
    description:
      "Adds a row with a title, property values (by property name, options by name) and an optional Markdown body. Without properties and body it starts from the database's default row template; template_id picks one.",
    scope: "pages:write",
    body: ops.inputs.createDatabaseRow.omit({ database_id: true }),
    status: 201,
    response: "Row",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.database_id);
      return ops.createDatabaseRow(ctx, { ...body, database_id: params.database_id });
    },
  }),
  defineRoute({
    method: "POST",
    path: "/databases/{database_id}/rows/bulk",
    operationId: "createRows",
    tag: "Rows",
    summary: "Add many rows",
    description: `Adds up to ${ops.MAX_BULK_ROWS} rows in order. All values are checked first: if one is invalid, nothing is created and the error names the row.`,
    scope: "pages:write",
    body: ops.inputs.createDatabaseRows.omit({ database_id: true }),
    status: 201,
    response: "RowsCreated",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.database_id);
      return ops.createDatabaseRows(ctx, { ...body, database_id: params.database_id });
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/databases/{database_id}/rows",
    operationId: "updateRows",
    tag: "Rows",
    summary: "Update many rows",
    description: `Sets the same property values on up to ${ops.MAX_BULK_ROWS} rows. Values are checked first; rows the user can't edit are skipped and listed in skipped_row_ids.`,
    scope: "pages:write",
    body: ops.inputs.updateDatabaseRows.omit({ database_id: true }),
    response: "RowsUpdated",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.database_id);
      return ops.updateDatabaseRows(ctx, { ...body, database_id: params.database_id });
    },
  }),
  defineRoute({
    method: "GET",
    path: "/rows/{row_id}",
    operationId: "getRow",
    tag: "Rows",
    summary: "Read a row",
    description: "A row's title and property values. Read its body with the page endpoint.",
    scope: "pages:read",
    response: "Row",
    handler: async ({ principal, ctx, params }) => {
      await requirePageInWorkspace(principal, params.row_id);
      return ops.getDatabaseRow(ctx, { row_id: params.row_id });
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/rows/{row_id}",
    operationId: "updateRow",
    tag: "Rows",
    summary: "Update a row",
    description: "Changes a row's title and/or property values; null clears a value and properties not given keep theirs.",
    scope: "pages:write",
    body: ops.inputs.updateDatabaseRow.omit({ row_id: true }),
    response: "Row",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.row_id);
      return ops.updateDatabaseRow(ctx, { ...body, row_id: params.row_id });
    },
  }),
];

/** The route for a method and path (relative to /api/v1), with its path parameters. */
export function matchRoute(routes: ApiRoute[], method: string, path: string) {
  const segments = path.split("/").filter(Boolean);
  const allowed = new Set<string>();
  for (const candidate of routes) {
    const pattern = candidate.path.split("/").filter(Boolean);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matches = true;
    for (const [i, part] of pattern.entries()) {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      if (name) {
        let value: string;
        try {
          value = decodeURIComponent(segments[i]);
        } catch {
          matches = false;
          break;
        }
        params[name] = value;
      } else if (part !== segments[i]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (candidate.method === method) return { route: candidate, params, allowed: [candidate.method] };
    allowed.add(candidate.method);
  }
  return { route: null, params: {}, allowed: [...allowed] };
}
