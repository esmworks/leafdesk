import { eq } from "drizzle-orm";
import * as z from "zod";
import { db } from "@/db";
import { page, user, workspaceAgent } from "@/db/schema";
import type { ApiTokenScope } from "@/lib/api-scopes";
import type { AgentView } from "@/lib/agents";
import { AccessError } from "@/server/access";
import { helperIdsOf } from "@/server/agents/helpers";
import * as agents from "@/server/agents/manage";
import { requestAgentRun } from "@/server/agents/requests";
import { agentSharing, removeAgentShare, setAgentShare } from "@/server/agents/sharing";
import { listAgentSchedules, removeAgentSchedule, setAgentSchedule } from "@/server/agents/schedules";
import { usageMonthsOf } from "@/server/agents/usage";
import {
  agentInputs,
  describeAgent,
  describeAgentRun,
  describeAgentSchedule,
  describeAgentSummary,
  describeSharing,
  describeUsageMonth,
  toAgentPatch,
  toScheduleInput,
} from "@/server/mcp/agents";
import { getPage } from "@/server/pages";
import * as ops from "@/server/operations";
import { MAX_ACTIVITY_PAGE } from "@/server/row-activity-feed";
import { voiceAudioType } from "@/lib/voice-notes";
import { AiError, sttLimits } from "@/server/ai";
import { pageUrl } from "@/server/mcp/format";
import { createVoiceNote } from "@/server/voice-notes";
import { ApiError, missingScope } from "./errors";
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
  /** The files of a multipart request (see ApiRoute.form), by field name. */
  files: Record<string, File>;
  /** Aborted when the client goes away. */
  signal: AbortSignal;
};

type Schema = z.ZodObject;

export type ApiRoute<Q extends Schema = Schema, B extends Schema = Schema> = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Relative to /api/v1, with `{name}` path parameters. */
  path: string;
  operationId: string;
  tag: "Account" | "Workspaces" | "Pages" | "Databases" | "Rows" | "Comments" | "Agents";
  summary: string;
  description?: string;
  /** What the token needs to call it; null for any token (GET /me). */
  scope: ApiTokenScope | null;
  query?: Q;
  body?: B;
  /**
   * Takes multipart form data instead of JSON: `body` checks its text fields, and `files` names its
   * file fields (with their descriptions) and `maxBytes` how large the whole body may be. It runs
   * before the body is read, so it may also throw to refuse the request (an ApiError).
   */
  form?: { files: Record<string, { description: string; required?: boolean }>; maxBytes: () => number };
  /** 201 for endpoints that create something. */
  status?: 200 | 201;
  /** It may answer 409 when what it acts on can't do it now (see API_ERROR_CODES). */
  conflict?: boolean;
  /** Name of the response schema in the OpenAPI components. */
  response: string;
  handler: (call: ApiCall<z.infer<Q>, z.infer<B>>) => Promise<unknown>;
};

export const defineRoute = <Q extends Schema = Schema, B extends Schema = Schema>(def: ApiRoute<Q, B>) => def as unknown as ApiRoute;

// ---------------------------------------------------------------------------- workspace-bound tokens

/** For what only some calls of an endpoint do (a voice note into a database): refused without the scope. */
function requireScope(principal: ApiPrincipal, scope: ApiTokenScope) {
  if (!principal.scopes.includes(scope)) throw missingScope(scope);
}

/** A token bound to a workspace sees nothing outside it: other workspaces read as not found. */
function requireWorkspace(principal: ApiPrincipal, workspaceId: string) {
  if (principal.workspaceId && principal.workspaceId !== workspaceId) throw new AccessError();
}

/** The agent, for someone it is shared with (refused for a token of another workspace); each route's own call checks the level it needs. */
async function ownedAgentFor(principal: ApiPrincipal, agentId: string) {
  if (principal.workspaceId) {
    const [row] = await db.select({ workspaceId: workspaceAgent.workspaceId }).from(workspaceAgent).where(eq(workspaceAgent.id, agentId)).limit(1);
    if (!row || row.workspaceId !== principal.workspaceId) throw new AccessError();
  }
  return agents.getAgent(principal.userId, agentId);
}

/** An agent as GET and PATCH answer it: its settings, and what its runs used this month. */
async function agentWithUsage(agent: AgentView) {
  const [month] = await usageMonthsOf(agent.id);
  const helpers = await helperIdsOf([agent.id]);
  return { ...describeAgent(agent), helper_agent_ids: helpers.get(agent.id) ?? [], usage_this_month: describeUsageMonth(month) };
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
  watchPage: ops.inputs.watchPage.omit({ page_id: true }),
  setPageArchived: ops.inputs.setPageArchived.omit({ page_id: true }),
};

/** The workspace a page or database is in (AccessError when there is none). */
async function workspaceOfPage(pageId: string) {
  const [row] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, pageId)).limit(1);
  if (!row) throw new AccessError();
  return row.workspaceId;
}

const voiceNoteBody = z.object({
  workspace_id: z
    .string()
    .max(100)
    .optional()
    .describe("The workspace the note goes into, as a private page. Needed unless database_id is given or the token is limited to a workspace."),
  database_id: z
    .string()
    .max(100)
    .optional()
    .describe("A database to add the note to as a row instead; its select and multi-select properties are filled from their options."),
});

const listQuery = z.object({ limit: limitInput(100, 50), cursor: cursorInput });

export const API_ROUTES: ApiRoute[] = [
  defineRoute({
    method: "GET",
    path: "/me",
    operationId: "getMe",
    tag: "Account",
    summary: "The token's user and settings",
    description:
      "Who the token acts for, its scopes, the workspace it is limited to (if any) and when it expires. Any token may call it. A token made before scopes were per resource has `legacy_scopes: true`, and its `scopes` list what its `pages:read` (every read scope) or `pages:write` (every scope) stands for.",
    scope: null,
    response: "Me",
    handler: async ({ principal }) => {
      const [row] = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.id, principal.userId));
      return {
        user: row,
        token: {
          id: principal.tokenId,
          scopes: principal.scopes,
          legacy_scopes: principal.legacyScopes,
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
    scope: "workspaces:read",
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
      "The pages at the top of a workspace's tree (with parent_id: the pages directly under that page), in sidebar order. Trashed pages and templates are left out, and archived pages unless include_archived is true.",
    scope: "pages:read",
    query: listQuery.extend({
      parent_id: z.string().optional().describe("List the pages under this page instead."),
      teamspace_id: z
        .string()
        .optional()
        .describe('Top level only: just this teamspace\'s pages, or "private" for the user\'s private pages.'),
      include_archived: z
        .stringbool()
        .default(false)
        .describe("Also include archived pages (out of date but kept; not the trash), marked archived: true (true or false)."),
    }),
    response: "PageList",
    handler: async ({ principal, ctx, params, query }) => {
      requireWorkspace(principal, params.workspace_id);
      const { pages } = await ops.listPages(ctx, {
        workspace_id: params.workspace_id,
        parent_id: query.parent_id,
        teamspace_id: query.teamspace_id,
        include_archived: query.include_archived,
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
    scope: "workspaces:read",
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
    scope: "workspaces:read",
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
      "Search over page titles and bodies (database rows included), best matches first: full-text, merged with semantic search (by meaning) when the server has an embeddings model. `match` says how each result was found. Archived pages are left out unless include_archived is true.",
    scope: "search:read",
    query: z.object({
      query: z.string().min(1).describe("Words to look for."),
      workspace_id: z.string().optional().describe("Only search this workspace."),
      include_archived: z
        .stringbool()
        .default(false)
        .describe("Also include archived pages (out of date but kept; not the trash), marked archived: true (true or false)."),
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
        include_archived: query.include_archived,
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
    path: "/workspaces/{workspace_id}/daily-notes",
    operationId: "listDailyNotes",
    tag: "Pages",
    summary: "List daily notes",
    description:
      "The user's daily notes in a workspace, newest first, optionally from one day to another (YYYY-MM-DD). Each is a private page of the user's; read it with the page endpoint.",
    scope: "pages:read",
    query: z.object({
      from: ops.inputs.listDailyNotes.shape.from,
      to: ops.inputs.listDailyNotes.shape.to,
      limit: z.coerce.number().int().min(1).max(366).default(31).describe("Maximum notes (1-366, default 31)."),
    }),
    response: "DailyNoteList",
    handler: async ({ principal, ctx, params, query }) => {
      requireWorkspace(principal, params.workspace_id);
      return ops.listDailyNotes(ctx, { workspace_id: params.workspace_id, ...query });
    },
  }),
  defineRoute({
    method: "POST",
    path: "/workspaces/{workspace_id}/daily-notes",
    operationId: "getOrCreateDailyNote",
    tag: "Pages",
    summary: "Open a daily note",
    description:
      "The user's note for a day (today in time_zone when date is left out, UTC without one), made when they have none: a private page under their journal, started the way they chose in the app. `created` says whether it is new; calling again for the same day returns the same page.",
    scope: "pages:write",
    body: ops.inputs.dailyNote.omit({ workspace_id: true }),
    response: "DailyNote",
    handler: async ({ principal, ctx, params, body }) => {
      requireWorkspace(principal, params.workspace_id);
      return ops.getOrCreateDailyNote(ctx, { ...body, workspace_id: params.workspace_id });
    },
  }),
  defineRoute({
    method: "POST",
    path: "/voice-notes",
    operationId: "createVoiceNote",
    tag: "Pages",
    summary: "Create a note from a recording",
    description:
      "Takes a recording as multipart form data (`audio`: WebM, Ogg, M4A/MP4, MP3, WAV or FLAC), has it transcribed and written up by AI as a clean note with a title, and saves it as a private page of the workspace or a row of `database_id` (which needs `rows:write` as well), with the transcript in a toggle under it. Answers once the note is saved, which can take a while for a long recording. The audio isn't stored. Without a chat model, or when the AI fails, the note is the transcript itself (`rewritten` false).\n\nOnly where the server has speech to text set up and the workspace allows AI; otherwise 409 `voice_notes_unavailable`. The largest recording is the server's `STT_MAX_MB` (25 MB unless set), not the 5 MB of JSON bodies. Transcription and writing up count toward the server's AI rate limits as well as the token's.",
    scope: "pages:write",
    body: voiceNoteBody,
    form: {
      files: { audio: { description: "The recording.", required: true } },
      maxBytes: () => {
        const limits = sttLimits();
        if (!limits) throw new ApiError(409, "voice_notes_unavailable", "Speech to text is not set up on this server.");
        return limits.maxBytes;
      },
    },
    status: 201,
    conflict: true,
    response: "VoiceNoteCreated",
    handler: async ({ principal, body, files, signal }) => {
      if (body.database_id) requireScope(principal, "rows:write");
      if (body.workspace_id) requireWorkspace(principal, body.workspace_id);
      if (body.database_id) await requirePageInWorkspace(principal, body.database_id);
      const workspaceId = body.workspace_id ?? (body.database_id ? await workspaceOfPage(body.database_id) : principal.workspaceId);
      if (!workspaceId) {
        throw new ApiError(
          400,
          "validation_error",
          "The request body is invalid.",
          [{ path: "workspace_id", message: "Say which workspace the note goes into." }],
          { param: "workspace_id" },
        );
      }
      const audio = files.audio;
      const type = voiceAudioType(audio.type, audio.name);
      if (!type) throw new ApiError(415, "unsupported_media_type", "This kind of audio file isn't supported: send WebM, Ogg, M4A/MP4, MP3, WAV or FLAC.");
      if (!audio.size) throw new ApiError(400, "invalid_request", "The audio file is empty.");
      const note = await createVoiceNote(principal.userId, { workspaceId, databaseId: body.database_id ?? null }, { bytes: audio, type }, { signal }).catch(
        (error: unknown) => {
          if (error instanceof AiError && error.code === "disabled") throw new ApiError(409, "voice_notes_unavailable", `${error.message}.`);
          throw error;
        },
      );
      return {
        id: note.id,
        title: note.draft.title,
        workspace_id: note.workspaceId,
        database_id: note.databaseId,
        rewritten: note.draft.rewritten,
        transcript: note.draft.transcript,
        properties: note.properties,
        url: pageUrl(note.workspaceId, note.id),
      };
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
    query: z.object({
      with_block_ids: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true")
        .describe('Put a line "<!-- block <id> -->" before each block of the body, for the block modes of updating a page.'),
    }),
    response: "Page",
    handler: async ({ principal, ctx, params, query }) => {
      await requirePageInWorkspace(principal, params.page_id);
      return withoutNote(
        await ops.getPage(ctx, { page_id: params.page_id, offset: 0, with_block_ids: query.with_block_ids }, { maxMarkdownChars: Infinity }),
      );
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/pages/{page_id}",
    operationId: "updatePage",
    tag: "Pages",
    summary: "Update a page",
    description:
      'Changes the title, icon, background and/or body. mode "replace" overwrites the body with the Markdown given, "append" adds it to the end; with `block_id` (from a read with `with_block_ids`), "replace_block" puts the Markdown in place of that block, "insert_after" adds it after the block and "delete_block" removes it. With `expected_version` (the `version` a read of the page returned) the page changes only while its body still has that version; otherwise nothing is written and the answer is 409 `version_conflict`. The previous body is saved to page history first, and open editors update live.',
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
    description:
      "The pages directly under a page, in order. Archived ones are left out unless include_archived is true (under a page that is archived itself, its pages are listed either way). For the rows of a database, query the database instead.",
    scope: "pages:read",
    query: listQuery.extend({
      include_archived: z
        .stringbool()
        .default(false)
        .describe("Also include archived pages (out of date but kept; not the trash), marked archived: true (true or false)."),
    }),
    response: "PageList",
    handler: async ({ principal, ctx, params, query }) => {
      await requirePageInWorkspace(principal, params.page_id);
      const parent = await getPage(ctx.userId, params.page_id);
      const { pages } = await ops.listPages(ctx, { workspace_id: parent.workspaceId, parent_id: parent.id, include_archived: query.include_archived });
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
    description:
      "Moves a page with its sub-pages (or a database with its rows) to the trash. Restoring brings it back. To archive an outdated page instead, which keeps it out of the trash, see /pages/{page_id}/archived.",
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
    method: "POST",
    path: "/pages/{page_id}/archived",
    operationId: "setPageArchived",
    tag: "Pages",
    summary: "Archive or unarchive a page",
    description:
      "With `archived: true` the page is archived: out of date but kept (an old price list, a superseded offer). Its sub-pages, or a database's rows, are archived with it. Archived pages stay readable, editable and linked, but leave the sidebar, search, pickers and database views; search, page lists and row queries return them with include_archived. `false` unarchives it. Not the trash (/pages/{page_id}/archive). Needs full access to the page; templates can't be archived, and a page in the trash is restored first. Reading the page shows `archived`.",
    scope: "pages:write",
    body: pageBodies.setPageArchived,
    response: "PageArchiveState",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.page_id);
      return withoutNote(await ops.setPageArchived(ctx, { page_id: params.page_id, archived: body.archived }));
    },
  }),
  defineRoute({
    method: "POST",
    path: "/pages/{page_id}/watch",
    operationId: "watchPage",
    tag: "Pages",
    summary: "Watch or mute a page",
    description:
      "With `watching: true` the user hears about others' edits to the page and new comment threads on it (in the inbox, by email and as push notifications, as they chose); `false` mutes it. Its creator and the people who edit a page watch it until they mute it, and so does anyone watching its teamspace. For a database row this follows it or stops. Reading the page shows `watching`.",
    scope: "pages:write",
    body: pageBodies.watchPage,
    response: "PageWatch",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.page_id);
      return ops.watchPage(ctx, { page_id: params.page_id, watching: body.watching });
    },
  }),
  defineRoute({
    method: "GET",
    path: "/pages/{page_id}/comments",
    operationId: "listComments",
    tag: "Comments",
    summary: "List comments",
    description: "The page's comment threads, oldest first, with the text each is about. Resolved threads only with include_resolved.",
    scope: "comments:read",
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
    scope: "comments:write",
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
    scope: "databases:read",
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
      'Rows matching filters, in the order of sorts (or a saved view\'s), a page at a time: pass next_cursor as cursor with the same filters, sorts and view_id to read on. Pages follow on from the last row returned, so rows added or removed in between neither repeat nor go missing. Filters name properties (or "title", "created_at", "updated_at") and use option names as values; ops: contains, does_not_contain, equals, not_equals, is_any_of, is_none_of (with a list of values), is_empty, is_not_empty, gt, gte, lt, lte, is_within. properties limits the values each row returns. The first page of a chart view also returns what it plots.',
    scope: "rows:read",
    body: ops.inputs.queryDatabase.omit({ database_id: true }),
    response: "QueryResult",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.database_id);
      return withoutNote(await ops.queryDatabase(ctx, { ...body, database_id: params.database_id }));
    },
  }),
  defineRoute({
    method: "POST",
    path: "/databases/{database_id}/rows",
    operationId: "createRow",
    tag: "Rows",
    summary: "Add a row",
    description:
      "Adds a row with a title, property values (by property name, options by name) and an optional Markdown body. Without properties and body it starts from the database's default row template; template_id picks one. With match_by it upserts: a row whose value of that property equals the given one is updated instead (action says which happened).",
    scope: "rows:write",
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
    description: `Adds up to ${ops.MAX_BULK_ROWS} rows in order. All values are checked first: if one is invalid, nothing is created and the error names the row. With match_by it upserts: each row whose value of that property matches an existing row's updates that row instead, and each row says which happened in action.`,
    scope: "rows:write",
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
    description: `Sets the same property values on up to ${ops.MAX_BULK_ROWS} rows. Values are checked first; rows the user can't edit are skipped and listed in skipped_row_ids. expect refuses the call, writing nothing, unless exactly that many rows would change; dry_run reports which rows would change without writing.`,
    scope: "rows:write",
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
    scope: "rows:read",
    response: "Row",
    handler: async ({ principal, ctx, params }) => {
      await requirePageInWorkspace(principal, params.row_id);
      return ops.getDatabaseRow(ctx, { row_id: params.row_id });
    },
  }),
  defineRoute({
    method: "GET",
    path: "/rows/{row_id}/activity",
    operationId: "listRowActivity",
    tag: "Rows",
    summary: "List a row's activity",
    description:
      "Who created the row and who changed its title or a property value, from what to what, newest first. Quick changes by the same actor to the same value are one entry. Entries about properties the token's user can't see in the row are left out.",
    scope: "rows:read",
    query: z.object({ limit: limitInput(MAX_ACTIVITY_PAGE, 20), cursor: cursorInput }),
    response: "RowActivity",
    handler: async ({ principal, ctx, params, query }) => {
      await requirePageInWorkspace(principal, params.row_id);
      const offset = decodeCursor(query.cursor);
      const { has_more: _more, ...result } = await ops.listRowActivity(ctx, { row_id: params.row_id, limit: query.limit, offset });
      const next = nextCursor(offset, query.limit, result.total);
      return { ...result, next_cursor: next, has_more: next !== null };
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/rows/{row_id}",
    operationId: "updateRow",
    tag: "Rows",
    summary: "Update a row",
    description: "Changes a row's title and/or property values; null clears a value and properties not given keep theirs.",
    scope: "rows:write",
    body: ops.inputs.updateDatabaseRow.omit({ row_id: true }),
    response: "Row",
    handler: async ({ principal, ctx, params, body }) => {
      await requirePageInWorkspace(principal, params.row_id);
      return ops.updateDatabaseRow(ctx, { ...body, row_id: params.row_id });
    },
  }),
  defineRoute({
    method: "GET",
    path: "/workspaces/{workspace_id}/agents",
    operationId: "listAgents",
    tag: "Agents",
    summary: "List agents",
    description:
      "The agents of a workspace: AI helpers with instructions of their own, each acting as a user of its own (`user_id`, what its changes and comments show). Owners list every agent; members the agents shared with them, with their access to each (`your_access`); guests can't.",
    scope: "agents:read",
    query: z.object({
      include_archived: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true")
        .describe("Also list archived agents."),
    }),
    response: "AgentList",
    handler: async ({ principal, params, query }) => {
      requireWorkspace(principal, params.workspace_id);
      const list = await agents.listAgents(principal.userId, params.workspace_id, { archived: query.include_archived });
      const helpers = await helperIdsOf(list.map((a) => a.id));
      return { workspace_id: params.workspace_id, agents: list.map((a) => describeAgentSummary(a, helpers.get(a.id) ?? [])) };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/agents/{agent_id}",
    operationId: "getAgent",
    tag: "Agents",
    summary: "Read an agent",
    description: "An agent's settings, instructions and monthly token limit, what its runs used this month, and the token's user's access to it (`your_access`). Workspace owners read every agent; others those shared with them.",
    scope: "agents:read",
    response: "Agent",
    handler: async ({ principal, params }) => {
      return agentWithUsage(await ownedAgentFor(principal, params.agent_id));
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/agents/{agent_id}",
    operationId: "updateAgent",
    tag: "Agents",
    summary: "Update an agent",
    description:
      "Changes an agent's name, icon, description, instructions, whether it is enabled (false pauses it: its queued runs end without doing anything), whether it may read the web (`web_access`), its monthly token limit (null removes it), the model its runs use (`main`, or `fast` for the server's cheaper fast model) or the other agents it can hand part of a task to (`helper_agent_ids`, the whole list; `[]` clears it); fields left out keep their values. Needs edit access to the agent (workspace owners always have it); only owners change the monthly token limit (403 otherwise). An archived agent can't change.",
    scope: "agents:write",
    body: agentInputs.update.omit({ agent_id: true }),
    response: "Agent",
    handler: async ({ principal, params, body }) => {
      await ownedAgentFor(principal, params.agent_id);
      return agentWithUsage(await agents.updateAgent(principal.userId, params.agent_id, toAgentPatch(body)));
    },
  }),
  defineRoute({
    method: "POST",
    path: "/agents/{agent_id}/runs",
    operationId: "startAgentRun",
    tag: "Agents",
    summary: "Start a run",
    description:
      "Asks the agent to do a task now. The run is queued and done in the background, held to what the token's user can open as well as what is shared with the agent: on a row (`row_id`) it may change and comment on that row; on none it only reads and answers. Read how it went with the run's endpoint. Needs edit access to the agent (workspace owners always have it). Answers 409 when the agent is paused or archived or AI is off (`agent_unavailable`), when it used its monthly token limit (`limit_reached`), or when too many runs asked of it still wait (`too_many_runs`). Each run uses the workspace's AI allowance.",
    scope: "agents:write",
    body: agentInputs.run.omit({ agent_id: true }),
    status: 201,
    conflict: true,
    response: "AgentRun",
    handler: async ({ principal, params, body }) => {
      const agent = await ownedAgentFor(principal, params.agent_id);
      const run = await requestAgentRun(principal.userId, params.agent_id, { task: body.task, rowId: body.row_id ?? null, via: "api" });
      return describeAgentRun(agent.workspaceId, run);
    },
  }),
  defineRoute({
    method: "GET",
    path: "/agents/{agent_id}/runs",
    operationId: "listAgentRuns",
    tag: "Agents",
    summary: "List an agent's runs",
    description:
      "An agent's latest runs, newest first (finished ones are kept 30 days): what started each, its status and failure code, its steps, final answer and the tokens it used. What a run read and wrote on a row the user can't open is left out. For anyone the agent is shared with; someone who can only interact with it gets only the runs they started.",
    scope: "agents:read",
    query: z.object({ limit: limitInput(100, 20) }),
    response: "AgentRunList",
    handler: async ({ principal, params, query }) => {
      const agent = await ownedAgentFor(principal, params.agent_id);
      const runs = await agents.listAgentRuns(principal.userId, params.agent_id, query.limit);
      return { agent_id: agent.id, runs: runs.map((run) => describeAgentRun(agent.workspaceId, run)) };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/agents/{agent_id}/runs/{run_id}",
    operationId: "getAgentRun",
    tag: "Agents",
    summary: "Read a run",
    description: "One of an agent's runs, as the list shows it: poll it after starting a run until its status is done or failed. For anyone the agent is shared with, as the list shows runs to them.",
    scope: "agents:read",
    response: "AgentRun",
    handler: async ({ principal, params }) => {
      const agent = await ownedAgentFor(principal, params.agent_id);
      const run = await agents.getAgentRun(principal.userId, params.agent_id, params.run_id);
      return describeAgentRun(agent.workspaceId, run);
    },
  }),
  defineRoute({
    method: "GET",
    path: "/agents/{agent_id}/usage",
    operationId: "getAgentUsage",
    tag: "Agents",
    summary: "An agent's usage",
    description:
      "The tokens, cost and runs an agent used by calendar month (UTC), this month first, for the last 12 months it ran in. `cost_usd` is 0 where the AI provider names no price. For anyone the agent is shared with.",
    scope: "agents:read",
    response: "AgentUsage",
    handler: async ({ principal, params }) => {
      const agent = await ownedAgentFor(principal, params.agent_id);
      const months = await usageMonthsOf(agent.id);
      return { agent_id: agent.id, monthly_token_limit: agent.monthlyTokenLimit, months: months.map(describeUsageMonth) };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/agents/{agent_id}/schedules",
    operationId: "listAgentSchedules",
    tag: "Agents",
    summary: "List an agent's schedules",
    description:
      "When the agent runs on its own: each schedule's repeat rule and time zone, its task, the database it looks after (with the agent's access to it), when it runs next and who set it. A paused schedule says why in `note`. For anyone the agent is shared with.",
    scope: "agents:read",
    response: "AgentScheduleList",
    handler: async ({ principal, params }) => {
      const agent = await ownedAgentFor(principal, params.agent_id);
      const schedules = await listAgentSchedules(principal.userId, agent.id);
      return { agent_id: agent.id, schedules: schedules.map((s) => describeAgentSchedule(agent.workspaceId, s)) };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/agents/{agent_id}/schedules",
    operationId: "addAgentSchedule",
    tag: "Agents",
    summary: "Add a schedule",
    description:
      "Makes the agent run on its own on a repeat rule, with a task and optionally a database it looks after: each run reads that database first and may change and comment on its rows; without one it only reads. Runs are held to what the token's user can open as well as what is shared with the agent, and each ends with a report in the user's inbox. Needs edit access to the agent (workspace owners always have it).",
    scope: "agents:write",
    body: agentInputs.schedule.omit({ agent_id: true }),
    status: 201,
    response: "AgentSchedule",
    handler: async ({ principal, params, body }) => {
      const agent = await ownedAgentFor(principal, params.agent_id);
      const schedule = await setAgentSchedule(principal.userId, agent.id, null, toScheduleInput(body));
      return describeAgentSchedule(agent.workspaceId, schedule);
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/agents/{agent_id}/schedules/{schedule_id}",
    operationId: "updateAgentSchedule",
    tag: "Agents",
    summary: "Change a schedule",
    description:
      "Changes a schedule's repeat rule, time zone, task or database (null: none); fields left out keep their values. Its runs are held to the token's user from now on, and a paused schedule turns back on. Needs edit access to the agent (workspace owners always have it).",
    scope: "agents:write",
    body: agentInputs.scheduleUpdate.omit({ agent_id: true, schedule_id: true }),
    response: "AgentSchedule",
    handler: async ({ principal, params, body }) => {
      const agent = await ownedAgentFor(principal, params.agent_id);
      const schedule = await setAgentSchedule(principal.userId, agent.id, params.schedule_id, toScheduleInput(body));
      return describeAgentSchedule(agent.workspaceId, schedule);
    },
  }),
  defineRoute({
    method: "DELETE",
    path: "/agents/{agent_id}/schedules/{schedule_id}",
    operationId: "deleteAgentSchedule",
    tag: "Agents",
    summary: "Delete a schedule",
    description: "The agent no longer runs on this schedule; a run it already started goes on. Needs edit access to the agent (workspace owners always have it).",
    scope: "agents:write",
    response: "AgentScheduleDeleted",
    handler: async ({ principal, params }) => {
      const agent = await ownedAgentFor(principal, params.agent_id);
      await removeAgentSchedule(principal.userId, agent.id, params.schedule_id);
      return { agent_id: agent.id, deleted: params.schedule_id };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/agents/{agent_id}/sharing",
    operationId: "getAgentSharing",
    tag: "Agents",
    summary: "Who an agent is shared with",
    description:
      "The people, groups and everyone in the workspace the agent is shared with, each at a level (`full`, `edit` or `interact`), and the token's user's own access (`your_access`). Workspace owners always have full access, listed or not. For anyone the agent is shared with.",
    scope: "agents:read",
    response: "AgentSharing",
    handler: async ({ principal, params }) => {
      const agent = await ownedAgentFor(principal, params.agent_id);
      return { agent_id: agent.id, ...describeSharing(await agentSharing(principal.userId, agent.id)) };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/agents/{agent_id}/sharing",
    operationId: "shareAgent",
    tag: "Agents",
    summary: "Share an agent",
    description:
      "Shares the agent with one person (`user_id`, an owner or member of the workspace, never a guest), group (`group_id`) or everyone in the workspace (`everyone: true`) at a level, or takes them off its list (`level: \"remove\"`). `full` can do everything a workspace owner can with the agent, sharing and archiving it too; `edit` changes and runs it; `interact` sees it, chats with it and mentions it. A person's own entry decides for them; without one, the highest of their groups'; without those, everyone's. Needs full access to the agent; each change goes to the audit log.",
    scope: "agents:write",
    body: agentInputs.share.omit({ agent_id: true }),
    response: "AgentSharing",
    handler: async ({ principal, params, body }) => {
      const agent = await ownedAgentFor(principal, params.agent_id);
      const named = [body.user_id, body.group_id, body.everyone ? "everyone" : undefined].filter(Boolean);
      if (named.length !== 1) throw new ApiError(400, "invalid_request", "Name exactly one of user_id, group_id or everyone: true.");
      const target = body.user_id
        ? { kind: "person" as const, userId: body.user_id }
        : body.group_id
          ? { kind: "group" as const, groupId: body.group_id }
          : { kind: "everyone" as const };
      const sharing =
        body.level === "remove" ? await removeAgentShare(principal.userId, agent.id, target) : await setAgentShare(principal.userId, agent.id, target, body.level);
      return { agent_id: agent.id, ...describeSharing(sharing) };
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
