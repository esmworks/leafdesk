/**
 * What the MCP tools (mcp/tools.ts) and the REST API (api/) both do with pages, databases, rows
 * and comments: input schemas, checks and output. Each operation acts as `ctx.userId` with that
 * user's own page access (see access.ts); the caller checks what its credentials allow (OAuth or
 * token scopes, a token's workspace) before calling. Outputs use snake_case keys and carry an app
 * `url` for everything they name.
 */
import * as z from "zod";
import { commentText, MAX_COMMENT_LENGTH } from "@/lib/comments";
import { markdownReferences } from "@/lib/embed-blocks";
import { env } from "@/lib/env";
import { FILTER_COMBINATORS, MAX_FILTER_DEPTH, MAX_RELATIVE_DAYS, RELATIVE_DATE_RANGES } from "@/lib/filters";
import { pageLabel } from "@/lib/labels";
import {
  BACKGROUND_COLORS,
  backgroundFileId,
  backgroundText,
  MAX_BACKGROUND_URL_LENGTH,
  parseBackgroundText,
  parsePageBackground,
} from "@/lib/page-background";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import * as comments from "@/server/comments";
import * as databases from "@/server/databases";
import { resolveEmbeds } from "@/server/embeds";
import * as forms from "@/server/forms";
import * as groups from "@/server/groups";
import { labelPageLinks, listBacklinks } from "@/server/mentions";
import * as pageMeta from "@/server/page-meta";
import * as pages from "@/server/pages";
import * as propertyAccess from "@/server/property-access";
import * as teamspaces from "@/server/teamspaces";
import * as workspaces from "@/server/workspaces";
import * as templates from "@/server/templates";
import { isBuiltinTemplateKey } from "@/lib/builtin-templates";
import { mapFilterRules } from "@/lib/filters";
import { atLeast, PROPERTY_LEVELS } from "@/lib/property-access";
import { pageUrl, sliceText, ToolInputError } from "./mcp/format";
import {
  describeAccessSettings,
  describeChartSeries,
  describeProperty,
  describeRowAccess,
  describeViewConfig,
  displayProperties,
  FILTER_OPS,
  resolvePropertyKey,
  toFilterEntries,
  toSortRule,
  type PropertyAccessNote,
  type PropertyDef,
} from "./mcp/query";

/** Who an operation acts for: their user id, and how their writes are attributed. */
export type OperationContext = { userId: string; actor: WriteActor };

export const MAX_BULK_ROWS = 100;

// ---------------------------------------------------------------------------- input schemas

export const id = (what: string) => z.string().min(1).describe(`The ${what} id (a UUID from another tool's output).`);

const checklistItem = z.object({ text: z.string(), checked: z.boolean().optional() });
const fileItem = z.object({ url: z.string(), name: z.string().optional() });
export const rowValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), checklistItem, fileItem])),
  z.null(),
]);
export const rowProperties = z
  .record(z.string(), rowValue)
  .describe(
    'Property values keyed by property name (case-insensitive) or id. Use option names for select / multi_select / status (an array for multi_select), ISO dates (YYYY-MM-DD) for date, true/false for checkbox, an email address for email, a phone number for phone, an array of item texts or {text, checked} objects for checklist, an array of row ids (or exact row titles) of the related database for relation, an array of user ids, emails, names or "me" for person, an array of files already uploaded to this workspace (their /api/files/<id> paths or urls, or the {name, url} objects query_database returns; upload new ones with attach_file and its property option) for files, and null to clear a value. Setting a relation, person, checklist or files replaces its values. created_by, created_time, last_edited_by, last_edited_time and formula properties are read-only. Example: {"Status": "In progress", "Tags": ["urgent"], "Due": "2026-10-01", "Customer": ["Acme Ltd"], "Assignee": ["me"]}',
  );

const filterRuleInput = z.object({
  property: z.string().min(1).describe("Property name or id, or title / created_at / updated_at."),
  op: z.enum(FILTER_OPS),
  value: z
    .union([z.string(), z.number(), z.boolean()])
    .optional()
    .describe(`Comparison value; omit for is_empty / is_not_empty. For is_within: ${RELATIVE_DATE_RANGES.join(", ")}.`),
  days: z
    .number()
    .int()
    .min(1)
    .max(MAX_RELATIVE_DAYS)
    .optional()
    .describe("is_within with past_n_days / next_n_days only: how many days back or ahead of today."),
});
const combinatorInput = z.enum(FILTER_COMBINATORS);
const filterGroupInput = <T extends z.ZodType>(rules: T) =>
  z.object({
    type: z.literal("group"),
    combinator: combinatorInput.default("and").describe("How the group's rules combine."),
    rules: z.array(rules).min(1),
  });
/**
 * A rule or a group. When neither fits, the error names what is wrong with the one the input was
 * meant to be (a plain union only says "Invalid input"), e.g. an unknown op.
 */
const ruleOrGroup = <G extends z.ZodType>(group: G) =>
  z.union([filterRuleInput, group], {
    error: (issue) => {
      if (issue.code !== "invalid_union" || !issue.errors.length) return undefined;
      const input = issue.input as { type?: unknown } | null | undefined;
      const branch = issue.errors[input?.type === "group" ? 1 : 0] ?? [];
      return branch.map((e) => `${e.path.length ? `${e.path.join(".")}: ` : ""}${e.message}`).join("; ") || undefined;
    },
  });
// Spelled out level by level (instead of a recursive schema) so every MCP client can read it. A
// group nested deeper than MAX_FILTER_DEPTH still parses at the innermost level and is then
// rejected by toFilterEntries with a message saying so.
const deepestGroup = z.object({ type: z.literal("group") }).loose();
export const filtersInput = z
  .array(ruleOrGroup(filterGroupInput(ruleOrGroup(filterGroupInput(ruleOrGroup(deepestGroup))))))
  .describe(
    `Filter rules and groups. A rule is {property, op, value}; a group is {type: "group", combinator: "and" | "or", rules: [...]}; groups may hold groups, at most ${MAX_FILTER_DEPTH} levels deep. A plain list of rules keeps working.`,
  );
export const filterCombinatorInput = combinatorInput
  .optional()
  .describe('How the top-level filters combine: "and" (default, all must match) or "or" (any may match).');
export const sortsInput = z.array(
  z.object({ property: z.string().min(1), direction: z.enum(["asc", "desc"]).default("asc") }),
);

/** Arguments of each shared operation, as the MCP tools take them (REST puts ids in the path). */
export const inputs = {
  search: z.object({
    query: z.string().min(1).describe("Words to look for."),
    workspace_id: z.string().optional().describe("Only search this workspace."),
    limit: z.number().int().min(1).max(50).default(10).describe("Maximum results (1-50, default 10)."),
  }),
  listPages: z.object({
    workspace_id: id("workspace"),
    parent_id: z.string().optional().describe("Parent page id. Omit for the workspace's top-level pages."),
    teamspace_id: z
      .string()
      .optional()
      .describe('Top level only: just this teamspace\'s pages (from list_teamspaces), or "private" for the user\'s private pages.'),
    favorites: z
      .boolean()
      .optional()
      .describe("List the pages the user starred in this workspace instead (oldest star first). Not with parent_id or teamspace_id."),
  }),
  listTeamspaces: z.object({
    workspace_id: id("workspace"),
    include_archived: z.boolean().default(false).describe("Also list archived teamspaces."),
  }),
  listGroups: z.object({ workspace_id: id("workspace") }),
  getPage: z.object({
    page_id: id("page"),
    offset: z.number().int().min(0).default(0).describe("Character offset into the Markdown body, for long pages."),
  }),
  createPage: z.object({
    workspace_id: z.string().optional().describe("Workspace for a top-level page. Ignored when parent_id is set."),
    parent_id: z.string().optional().describe("Page to nest the new page under."),
    teamspace_id: z
      .string()
      .optional()
      .describe(
        'Top-level pages: the teamspace to add it to (from list_teamspaces; the user must be in it), or "private" (the default) for a page only the user sees. Ignored when parent_id is set.',
      ),
    title: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Page title. Required unless template_id is given (the template's title is used then)."),
    markdown: z.string().optional().describe("Initial page body in Markdown. With template_id it replaces the template's body."),
    icon: z.string().max(16).optional().describe("A single emoji used as the page icon."),
    template_id: z
      .string()
      .optional()
      .describe('A page template of the workspace, or a built-in one ("builtin:<key>"), from list_templates.'),
  }),
  updatePage: z.object({
    page_id: id("page"),
    title: z.string().min(1).max(500).optional().describe("New title."),
    markdown: z.string().optional().describe("Markdown to write into the body."),
    mode: z
      .enum(["replace", "append"])
      .default("replace")
      .describe('"replace" (default) overwrites the body; "append" adds to the end.'),
    background: z
      .string()
      .max(MAX_BACKGROUND_URL_LENGTH)
      .nullable()
      .optional()
      .describe(
        `What fills the page behind its title and body: an image uploaded to the workspace (its /api/files/<id> URL, e.g. from attach_file) or an https link to an image, with the text on a plain surface over it; or a color as "color:<name>" (${BACKGROUND_COLORS.join(", ")}), light in the light theme and dark in the dark one. null removes it.`,
      ),
  }),
  pageId: z.object({ page_id: id("page") }),
  movePage: z.object({
    page_id: id("page"),
    parent_id: z.string().min(1).nullable().describe("New parent page id, or null for the top level."),
    teamspace_id: z
      .string()
      .optional()
      .describe('With parent_id null: the teamspace to move it to (from list_teamspaces), or "private". Ignored under a parent.'),
  }),
  databaseId: z.object({ database_id: id("database") }),
  queryDatabase: z.object({
    database_id: id("database"),
    filters: filtersInput.optional(),
    filter_combinator: filterCombinatorInput,
    sorts: sortsInput.optional(),
    view_id: z
      .string()
      .optional()
      .describe("Apply a saved view's filters and sorts first (ids from get_database); rows must match both the view's filters and yours."),
    limit: z.number().int().min(1).max(200).default(50).describe("Maximum rows to return (1-200, default 50)."),
  }),
  createDatabaseRow: z.object({
    database_id: id("database"),
    title: z.string().min(1).max(500).describe("Row title."),
    properties: rowProperties.optional(),
    markdown: z.string().optional().describe("Optional Markdown body for the row's page. With a template it replaces the template's body."),
    template_id: z
      .string()
      .optional()
      .describe('A row template of this database from list_templates, or "none" for a blank row even when the database has a default template.'),
  }),
  createDatabaseRows: z.object({
    database_id: id("database"),
    rows: z
      .array(
        z.object({
          title: z.string().min(1).max(500).describe("Row title."),
          properties: rowProperties.optional(),
          markdown: z.string().optional().describe("Optional Markdown body for the row's page."),
        }),
      )
      .min(1)
      .max(MAX_BULK_ROWS)
      .describe(`The rows to add (1-${MAX_BULK_ROWS}).`),
  }),
  updateDatabaseRow: z.object({
    row_id: id("row"),
    title: z.string().min(1).max(500).optional().describe("New row title."),
    properties: rowProperties.optional(),
  }),
  updateDatabaseRows: z.object({
    database_id: id("database"),
    row_ids: z.array(z.string().min(1)).min(1).max(MAX_BULK_ROWS).describe(`Ids of the rows to change (1-${MAX_BULK_ROWS}).`),
    properties: rowProperties,
  }),
  setPropertyAccess: z.object({
    database_id: id("database"),
    property: z.string().min(1).describe("Property name or id."),
    everyone: z
      .enum([...PROPERTY_LEVELS, "inherit"])
      .describe(
        'What everyone with access to the database may do with the property: "none" (it doesn\'t show at all), "view_property" (it shows, its values don\'t), "view" (values read-only), "edit_values" (values can be changed) or "edit" (the property itself too). "inherit" removes the restriction, exceptions included: the property follows the database\'s access again.',
      ),
    exceptions: z
      .array(
        z.object({
          user: z.string().min(1).optional().describe("A person of the workspace, by user id or email (see list_users)."),
          group: z.string().min(1).optional().describe("A member group, by id or name (see list_groups)."),
          person_property: z
            .string()
            .min(1)
            .optional()
            .describe(
              "A person or created_by property of this database, by name or id: the people each row names get the level on that row (view_property, view or edit_values only).",
            ),
          level: z.enum(PROPERTY_LEVELS),
        }),
      )
      .max(100)
      .default([])
      .describe("Who gets more than everyone: each names exactly one of user, group or person_property. The widest level that applies wins; nobody gets more than their access to the database allows."),
  }),
  listComments: z.object({
    page_id: id("page"),
    include_resolved: z.boolean().default(false).describe("Also list resolved threads."),
  }),
  addComment: z.object({
    page_id: id("page"),
    text: z.string().min(1).max(MAX_COMMENT_LENGTH).describe("The comment."),
    quote: z.string().min(1).max(1000).optional().describe("Start a new thread on this exact text of the page."),
    thread_id: z.string().min(1).optional().describe("Reply in this thread instead."),
  }),
};

type Args<K extends keyof typeof inputs> = z.infer<(typeof inputs)[K]>;

// ---------------------------------------------------------------------------- helpers

/** Loads a page with its parent, when the user can see it, and its database, if it is a row. */
export async function loadPage(ctx: OperationContext, pageId: string) {
  const page = await pages.getPage(ctx.userId, pageId);
  const parent = page.parentId ? await pages.getPage(ctx.userId, page.parentId).catch(() => null) : null;
  return { page, parent, parentDatabase: parent?.kind === "database" ? parent : null };
}

/**
 * A row's values as `ctx.userId` may see them (databases.getRow leaves out what property access
 * keeps from them), by property name, with the properties it leaves out or shows read-only.
 */
/** A database row's values as the person may see them, and which ones they may not edit. */
export async function rowFields(ctx: OperationContext, rowId: string) {
  const { properties, row, relations, people } = await databases.getRow(ctx.userId, rowId);
  return {
    properties: displayProperties(properties, row.properties, { relations, people }, env.appUrl),
    ...describeRowAccess(properties, row),
  };
}

export async function rowOutput(ctx: OperationContext, databaseId: string, rowId: string) {
  const [fields, row] = await Promise.all([rowFields(ctx, rowId), pages.getPage(ctx.userId, rowId)]);
  return {
    id: row.id,
    title: pageLabel(row.title),
    database_id: databaseId,
    ...fields,
    url: pageUrl(row.workspaceId, row.id),
  };
}

/**
 * Where a new page goes: under `parentId` when given (in the parent's teamspace), else at the top
 * of `workspaceId`, in the teamspace `teamspaceId` names (see spaceOf; private when missing). The
 * workspace comes from the teamspace when only that is given.
 */
export async function resolveLocation(ctx: OperationContext, workspaceId?: string, parentId?: string, teamspaceId?: string) {
  if (parentId) {
    const parent = await pages.getPage(ctx.userId, parentId);
    if (parent.archivedAt) throw new ToolInputError("The parent page is in the trash. Choose another parent.");
    return { workspaceId: parent.workspaceId, parentId, parentKind: parent.kind, teamspaceId: undefined };
  }
  const space = spaceOf(teamspaceId);
  if (!workspaceId && space) {
    const teamspace = await teamspaces.getTeamspace(ctx.userId, space).catch(() => null);
    if (!teamspace) throw new ToolInputError("Unknown teamspace_id. Call list_teamspaces for the ids.");
    workspaceId = teamspace.workspaceId;
  }
  if (!workspaceId) {
    throw new ToolInputError("Provide workspace_id (to create at the top level) or parent_id (to nest under a page).");
  }
  return { workspaceId, parentId: null, parentKind: null, teamspaceId: space ?? null };
}

/** A teamspace_id argument: an id, or "private" (null) for the user's private pages. */
export const spaceOf = (value?: string | null) => (value === undefined || value === null ? undefined : value === "private" ? null : value);

/** The teamspace a page is in, as outputs show it: its id and name, or null and "Private". */
export async function teamspaceOf(ctx: OperationContext, teamspaceId: string | null) {
  if (!teamspaceId) return { teamspace_id: null, teamspace: "Private" };
  const label = await teamspaces.teamspaceLabel(ctx.userId, teamspaceId);
  return { teamspace_id: teamspaceId, teamspace: label?.name ?? null };
}

// ---------------------------------------------------------------------------- operations

export async function listWorkspaces(ctx: OperationContext) {
  const workspaces = await pages.listWorkspaces(ctx.userId);
  return { workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role })) };
}

export async function listTeamspaces(ctx: OperationContext, { workspace_id, include_archived }: Args<"listTeamspaces">) {
  const list = await teamspaces.listTeamspaces(ctx.userId, workspace_id, { archived: include_archived ? "all" : "active" });
  return {
    teamspaces: list.map((t) => ({
      id: t.id,
      name: t.name,
      icon: t.icon,
      description: t.description || undefined,
      access: t.access,
      member_access: t.memberLevel,
      archived: Boolean(t.archivedAt),
      member_count: t.memberCount,
      owners: t.owners.map((o) => o.name),
      joined: t.joined,
      role: t.role,
      can_add_pages: t.joined && !t.archivedAt,
    })),
    note: 'Pages outside every teamspace are private: create_page / move_page with teamspace_id "private".',
  };
}

export async function listGroups(ctx: OperationContext, { workspace_id }: Args<"listGroups">) {
  const list = await groups.listGroups(ctx.userId, workspace_id);
  return {
    groups: list.map((g) => ({
      id: g.id,
      name: g.name,
      member_count: g.memberCount,
      members: g.members.map((m) => ({ id: m.userId, name: m.name, email: m.email })),
      teamspaces: g.teamspaces.map((t) => ({ id: t.id, name: t.name })),
    })),
  };
}

/**
 * Full-text search, merged with semantic search where the server has an embeddings model (see
 * pages.searchPages). `match` says how a result was found: "semantic" when only by meaning.
 * `withinPageId` keeps to a page and its subpages; `passages` adds the best matching passage of
 * each page (as far as semantic search found one) and the block it starts at (AI chat). `anyWord`:
 * pages with any of the query's words, not all (AI chat, which searches with whole questions).
 */
export async function search(
  ctx: OperationContext,
  { query, workspace_id, limit }: Args<"search">,
  { withinPageId, passages = false, anyWord = false }: { withinPageId?: string; passages?: boolean; anyWord?: boolean } = {},
) {
  const hits = await pages.searchPages(ctx.userId, query, { workspaceId: workspace_id, limit, withinPageId, anyWord });
  return {
    results: hits.map((h) => ({
      id: h.id,
      title: pageLabel(h.title),
      kind: h.kind,
      workspace_id: h.workspaceId,
      teamspace_id: h.teamspaceId,
      parent_id: h.parentId,
      snippet: h.snippet,
      match: h.match ?? ("text" as const),
      updated_at: h.updatedAt.toISOString(),
      url: pageUrl(h.workspaceId, h.id),
      ...(passages ? { passage: h.passage ?? null, block_id: h.blockId ?? null } : {}),
    })),
  };
}

export async function listPages(ctx: OperationContext, { workspace_id, parent_id, teamspace_id, favorites }: Args<"listPages">) {
  if (favorites && (parent_id || teamspace_id)) throw new ToolInputError("favorites lists the starred pages of the whole workspace: leave out parent_id and teamspace_id.");
  const children = favorites
    ? await pageMeta.listFavorites(ctx.userId, workspace_id)
    : await pages.listChildren(ctx.userId, workspace_id, parent_id ?? null, { teamspaceId: spaceOf(teamspace_id) });
  return {
    pages: children.map((c) => ({
      id: c.id,
      title: pageLabel(c.title),
      kind: c.kind,
      icon: c.icon,
      teamspace_id: c.teamspaceId,
      updated_at: c.updatedAt.toISOString(),
      url: pageUrl(workspace_id, c.id),
    })),
  };
}

/** `maxMarkdownChars` bounds the body returned (MCP keeps it to what a model reads at once). */
export async function getPage(
  ctx: OperationContext,
  { page_id, offset }: Args<"getPage">,
  { maxMarkdownChars }: { maxMarkdownChars?: number } = {},
) {
  const { userId } = ctx;
  const { page, parent, parentDatabase } = await loadPage(ctx, page_id);
  const [crumbs, content, workspaces, favorite] = await Promise.all([
    pages.getBreadcrumbs(userId, page_id),
    getCollab().readPage(page_id),
    pages.listWorkspaces(userId),
    pageMeta.isFavorite(userId, page_id),
  ]);
  const workspace = workspaces.find((w) => w.id === page.workspaceId);
  // Mentioned pages read as their current title, as far as the user can see them.
  const body = sliceText(await labelPageLinks(userId, content.markdown), offset, maxMarkdownChars);
  const out: Record<string, unknown> = {
    id: page.id,
    title: pageLabel(content.title || page.title),
    kind: page.kind,
    icon: page.icon,
    ...backgroundField(page.background),
    workspace_id: page.workspaceId,
    ...(await teamspaceOf(ctx, page.teamspaceId)),
    // A parent they can't see stays unnamed, id included.
    parent_id: parent?.id ?? null,
    path: [workspace?.name ?? "Workspace", ...crumbs.map((c) => pageLabel(c.title))].join(" / "),
    in_trash: Boolean(page.archivedAt),
    favorite,
    updated_at: page.updatedAt.toISOString(),
    url: pageUrl(page.workspaceId, page.id),
  };
  if (page.isTemplate) out.template = parentDatabase ? "row_template" : "page_template";
  else if (page.inTemplate) out.template = "inside_template";
  if (parentDatabase) {
    out.database_id = parentDatabase.id;
    Object.assign(out, await rowFields(ctx, page.id));
  }
  if (page.kind === "database") {
    const { properties, access, propertyAccess: levels } = await databases.getDatabase(userId, page.id);
    const lookups = await databases.getLookups(userId, properties);
    out.database_properties = properties.map((p) =>
      describeProperty(p, lookups, properties, { access: levels?.[p.id], restricted: !access.open }),
    );
    out.note = "This is a database. Use query_database to list its rows and get_database for its full schema.";
  } else {
    out.markdown = body.text;
    if (body.truncated) {
      out.markdown_truncated = true;
      out.markdown_total_chars = body.totalChars;
      if ("note" in body) out.note = body.note;
    }
    const embeds = await resolveEmbeds(userId, markdownReferences(content.markdown));
    if (embeds.length) {
      out.embedded_databases = embeds.map((e) => ({
        database_id: e.databaseId,
        kind: e.type === "database" ? "inline_database" : "linked_view",
        // Seeing the page doesn't mean seeing the database: its title stays private then.
        title: e.database ? pageLabel(e.database.title) : null,
        accessible: Boolean(e.database),
        in_trash: e.database?.inTrash ?? false,
        url: e.database ? pageUrl(e.database.workspaceId, e.database.id) : null,
      }));
    }
    const children = await pages.listChildren(userId, page.workspaceId, page.id);
    out.child_pages = children.slice(0, 100).map((c) => ({ id: c.id, title: pageLabel(c.title), kind: c.kind }));
    if (children.length > 100) out.child_pages_truncated = children.length;
    const backlinks = await listBacklinks(userId, page.id);
    if (backlinks.length) {
      out.linked_from = backlinks.map((b) => ({ id: b.id, title: pageLabel(b.title), url: pageUrl(b.workspaceId, b.id) }));
    }
  }
  return out;
}

export async function createPage(
  ctx: OperationContext,
  { workspace_id, parent_id, teamspace_id, title, markdown, icon, template_id }: Args<"createPage">,
) {
  const { userId, actor } = ctx;
  const location = await resolveLocation(ctx, workspace_id, parent_id, teamspace_id);
  if (location.parentKind === "database") {
    throw new ToolInputError("parent_id is a database. Use create_database_row to add rows to it.");
  }
  if (template_id) {
    let createdId: string;
    if (template_id.startsWith("builtin:")) {
      const key = template_id.slice("builtin:".length);
      if (!isBuiltinTemplateKey(key)) throw new ToolInputError(`Unknown built-in template "${key}". Call list_templates for the keys.`);
      createdId = (
        await templates.createFromBuiltin(actor, location.workspaceId, key, { parentId: location.parentId, teamspaceId: location.teamspaceId })
      ).id;
    } else {
      const template = await pages.getPage(userId, template_id);
      if (!template.isTemplate || template.parentId) {
        throw new ToolInputError("template_id is not a page template. Call list_templates; row templates go to create_database_row.");
      }
      if (template.workspaceId !== location.workspaceId) {
        throw new ToolInputError("template_id is a template of another workspace. Call list_templates for the templates of this one.");
      }
      createdId = (await templates.createFromTemplate(actor, template_id, { parentId: location.parentId, teamspaceId: location.teamspaceId })).id;
    }
    if (title !== undefined) await pages.renamePage(actor, createdId, title);
    if (icon !== undefined) await pages.setPageIcon(userId, createdId, icon);
    if (markdown !== undefined) await getCollab().replaceContent(createdId, markdown, actor);
    const created = await pages.getPage(userId, createdId);
    return {
      id: created.id,
      title: pageLabel(created.title),
      workspace_id: created.workspaceId,
      ...(await teamspaceOf(ctx, created.teamspaceId)),
      parent_id: created.parentId,
      from_template: template_id,
      url: pageUrl(created.workspaceId, created.id),
    };
  }
  if (title === undefined) throw new ToolInputError("Provide title (or template_id).");
  const created = await pages.createPage(actor, {
    workspaceId: location.workspaceId,
    parentId: location.parentId,
    teamspaceId: location.teamspaceId,
    title,
    icon: icon ?? null,
    markdown,
  });
  return {
    id: created.id,
    title: pageLabel(created.title),
    workspace_id: created.workspaceId,
    ...(await teamspaceOf(ctx, created.teamspaceId)),
    parent_id: created.parentId,
    url: pageUrl(created.workspaceId, created.id),
  };
}

/** A page's background as MCP and REST show it: one string (lib/page-background backgroundText), files as full URLs. */
function backgroundField(stored: unknown) {
  const background = parsePageBackground(stored);
  if (!background) return { background: null };
  const text = backgroundText(background);
  return { background: backgroundFileId(background) ? `${env.appUrl}${text}` : text };
}

/** The background update_page asks for: a new one, or none (null). */
function backgroundFromInput(background: string | null) {
  if (background === null) return null;
  const parsed = parseBackgroundText(background);
  if (!parsed) {
    throw new ToolInputError(
      `background must be an image URL (/api/files/<id> or an https link) or "color:<name>" with one of: ${BACKGROUND_COLORS.join(", ")}.`,
    );
  }
  return parsed;
}

/** `icon` (null clears it) is REST only: the MCP tool doesn't take it. */
export async function updatePage(
  ctx: OperationContext,
  { page_id, title, markdown, mode, icon, background }: Args<"updatePage"> & { icon?: string | null },
) {
  const { userId, actor } = ctx;
  if (title === undefined && markdown === undefined && icon === undefined && background === undefined) {
    throw new ToolInputError("Provide title, markdown and/or background.");
  }
  const { page } = await loadPage(ctx, page_id);
  if (page.archivedAt) throw new ToolInputError("This page is in the trash. Restore it in Leafdesk before editing.");
  const changed: string[] = [];
  if (markdown !== undefined) {
    if (page.kind === "database") {
      throw new ToolInputError("Databases have no text body. Use create_database_row or update_database_row.");
    }
    const collab = getCollab();
    if (mode === "append") await collab.appendContent(page_id, markdown, actor, true);
    else await collab.replaceContent(page_id, markdown, actor, true);
    changed.push(mode === "append" ? "body (appended)" : "body (replaced)");
  }
  if (title !== undefined) {
    await pages.renamePage(actor, page_id, title);
    changed.push("title");
  }
  if (icon !== undefined) {
    await pages.setPageIcon(userId, page_id, icon);
    changed.push("icon");
  }
  if (background !== undefined) {
    await pages.setPageBackground(userId, page_id, backgroundFromInput(background));
    changed.push("background");
  }
  return {
    id: page.id,
    changed,
    ...(markdown !== undefined ? { snapshot: "Saved the previous version to page history before writing." } : {}),
    url: pageUrl(page.workspaceId, page.id),
  };
}

export async function archivePage(ctx: OperationContext, { page_id }: Args<"pageId">) {
  const page = await pages.getPage(ctx.userId, page_id);
  if (!page.archivedAt) await pages.archivePage(ctx.userId, page_id);
  return {
    id: page.id,
    title: pageLabel(page.title),
    in_trash: true,
    note: page.archivedAt
      ? "The page was already in the trash."
      : "Moved to the trash with its sub-pages. It can be restored from the trash in Leafdesk.",
  };
}

export async function restorePage(ctx: OperationContext, { page_id }: Args<"pageId">) {
  const before = await pages.getPage(ctx.userId, page_id);
  if (before.archivedAt) await pages.restorePage(ctx.userId, page_id);
  const after = before.archivedAt ? await pages.getPage(ctx.userId, page_id) : before;
  return {
    id: after.id,
    title: pageLabel(after.title),
    parent_id: after.parentId,
    in_trash: false,
    ...(before.archivedAt
      ? after.parentId !== before.parentId
        ? { note: "Its old parent is still in the trash, so it was restored to the top level." }
        : {}
      : { note: "The page was not in the trash." }),
    url: pageUrl(after.workspaceId, after.id),
  };
}

export async function movePage(ctx: OperationContext, { page_id, parent_id, teamspace_id }: Args<"movePage">) {
  const { userId } = ctx;
  const { page, parentDatabase } = await loadPage(ctx, page_id);
  if (page.archivedAt) throw new ToolInputError("This page is in the trash. Restore it with restore_page first.");
  const parent = parent_id ? await pages.getPage(userId, parent_id) : null;
  if (parent) {
    if (parent.archivedAt) throw new ToolInputError("The new parent is in the trash. Choose another parent.");
    if (parent.workspaceId !== page.workspaceId) throw new ToolInputError("Pages cannot be moved to another workspace.");
    if (parent.kind === "database" && page.kind === "database") {
      throw new ToolInputError("A database cannot be moved into another database.");
    }
    const ancestors = await pages.getBreadcrumbs(userId, parent.id);
    if (ancestors.some((a) => a.id === page.id)) {
      throw new ToolInputError("A page cannot be moved inside itself or one of its sub-pages.");
    }
  }
  const space = parent ? undefined : spaceOf(teamspace_id);
  if ((parent?.id ?? null) !== page.parentId || (space !== undefined && space !== page.teamspaceId)) {
    await pages.movePage(userId, page_id, parent?.id ?? null, undefined, space);
  }
  const moved = await pages.getPage(userId, page_id).catch(() => null);
  const note =
    parent?.kind === "database" && parentDatabase?.id !== parent.id
      ? "The page is now a row of this database; set its properties with update_database_row."
      : parentDatabase && parent?.id !== parentDatabase.id
        ? "The page is no longer a database row."
        : undefined;
  return {
    id: page.id,
    title: pageLabel(page.title),
    parent_id: parent?.id ?? null,
    ...(moved ? await teamspaceOf(ctx, moved.teamspaceId) : {}),
    ...(note ? { note } : {}),
    url: pageUrl(page.workspaceId, page.id),
  };
}

/**
 * Who may do what with each restricted property, for someone with full access to the database
 * (the only people who may see or change it); an empty map for everyone else.
 */
async function accessSettingsOf(userId: string, databaseId: string, access: propertyAccess.PropertyAccess) {
  const settings = new Map<string, ReturnType<typeof describeAccessSettings>>();
  if (access.viewer?.databaseLevel !== "full") return settings;
  const rules = await propertyAccess.loadPropertyRules([databaseId]);
  for (const propertyId of rules.keys()) {
    settings.set(propertyId, describeAccessSettings(await propertyAccess.getPropertyAccessSettings(userId, propertyId)));
  }
  return settings;
}

export async function getDatabase(ctx: OperationContext, { database_id }: Args<"databaseId">) {
  const { userId } = ctx;
  const [{ database, properties, views, access, propertyAccess: levels }, rows] = await Promise.all([
    databases.getDatabase(userId, database_id),
    databases.listRows(userId, database_id),
  ]);
  const [lookups, settings] = await Promise.all([
    databases.getLookups(userId, properties),
    accessSettingsOf(userId, database_id, access),
  ]);
  const links = await forms.formPublicationsOf(views.filter((v) => v.type === "form").map((v) => v.id));
  return {
    id: database.id,
    title: pageLabel(database.title),
    workspace_id: database.workspaceId,
    in_trash: Boolean(database.archivedAt),
    row_count: rows.length,
    properties: [
      { name: "title", type: "title", note: 'Every row\'s title; filter and sort on it with property "title".' },
      ...properties.map((p) => {
        const own = settings.get(p.id);
        return {
          ...describeProperty(p, lookups, properties, { access: levels?.[p.id], restricted: !access.open }),
          ...(own ? { access_settings: own } : {}),
        };
      }),
    ],
    views: views.map((v) => ({
      id: v.id,
      name: v.name,
      type: v.type,
      ...describeViewConfig(properties, v.config, lookups, v.type),
      ...formLinkOutput(v.type, links.get(v.id)),
    })),
    url: pageUrl(database.workspaceId, database.id),
  };
}

/** How a form view is shared, for tool output. */
export function formLinkOutput(type: string, link: { url: string; anonymous: boolean } | null | undefined) {
  if (type !== "form") return {};
  return link ? { public_url: `${env.appUrl}${link.url}`, anonymous: link.anonymous } : { public_url: null };
}

/**
 * Rows matching the filters, `limit` of them from `offset` on (REST pages through them; MCP reads
 * the first ones). A chart view also returns what it plots, over every matching row.
 */
export async function queryDatabase(
  ctx: OperationContext,
  { database_id, filters, filter_combinator, sorts, view_id, limit }: Args<"queryDatabase">,
  { offset = 0 }: { offset?: number } = {},
) {
  const { userId } = ctx;
  const { database, properties, views, propertyAccess: levels } = await databases.getDatabase(userId, database_id);
  const props: PropertyDef[] = properties;
  const lookups = await databases.getLookups(userId, properties);
  const view = view_id ? views.find((v) => v.id === view_id) : undefined;
  if (view_id && !view) throw new ToolInputError(`No view with id "${view_id}" in this database.`);
  // The view's filters and the caller's each keep their own combinator; rows must match both.
  const ownRules = toFilterEntries(props, filters ?? [], lookups);
  const ownSorts = sorts?.length ? sorts.map((s) => toSortRule(props, s)) : null;
  const used = (ownSorts ?? []).map((s) => s.propertyId);
  mapFilterRules(ownRules, (rule) => {
    used.push(rule.propertyId);
    return rule;
  });
  refuseHiddenValues(props, levels, used);
  const own = { type: "group", combinator: filter_combinator ?? "and", rules: ownRules } as const;
  const saved = { type: "group", combinator: view?.config.filterCombinator ?? "and", rules: view?.config.filters ?? [] } as const;
  // Filters and sorts run on the values the caller may see (databases.listRows): rows whose values
  // are kept from them count as empty there, so neither the rows returned nor total say anything
  // about those values.
  const rows = await databases.listRows(userId, database_id, {
    filters: [saved, own].filter((g) => g.rules.length),
    sorts: ownSorts ?? view?.config.sorts ?? [],
  });
  const window = rows.slice(offset, offset + limit);
  return {
    database_id: database.id,
    title: pageLabel(database.title),
    total: rows.length,
    returned: window.length,
    rows: window.map((r) => ({
      id: r.id,
      title: pageLabel(r.title),
      properties: displayProperties(props, r.properties, lookups, env.appUrl),
      ...describeRowAccess(props, r),
      url: pageUrl(database.workspaceId, r.id),
    })),
    ...(rows.length > offset + limit ? { note: `Only the first ${limit} rows are shown; narrow the filters or raise limit.` } : {}),
    ...(view?.type === "chart"
      ? {
          chart: {
            ...describeViewConfig(props, { ...view.config, filters: undefined, sorts: undefined }, lookups, "chart"),
            ...describeChartSeries(props, view.config, rows, lookups),
          },
        }
      : {}),
  };
}

/**
 * Refuses filters and sorts the caller gives on properties whose values they may not see in any
 * row: they would run on nothing (see queryDatabase) and only mislead. Properties rows decide
 * (a person property exception) run on each row's visible values instead.
 */
export function refuseHiddenValues(
  props: PropertyDef[],
  levels: Record<string, PropertyAccessNote> | undefined,
  propertyIds: string[],
) {
  if (!levels) return;
  for (const id of new Set(propertyIds)) {
    const info = levels[id];
    if (!info || info.perRow || atLeast(info.level, "view")) continue;
    const name = props.find((p) => p.id === id)?.name ?? id;
    throw new ToolInputError(`You can't see the values of "${name}", so rows can't be filtered or sorted by it.`);
  }
}

export async function createDatabaseRow(
  ctx: OperationContext,
  { database_id, title, properties, markdown, template_id }: Args<"createDatabaseRow">,
) {
  const { userId, actor } = ctx;
  const { database } = await databases.getDatabase(userId, database_id);
  if (database.archivedAt) throw new ToolInputError("This database is in the trash.");
  const blank = template_id === "none";
  const noValues = !Object.keys(properties ?? {}).length && markdown === undefined;
  if (!blank && (template_id || noValues)) {
    const created = await templates.createRow(actor, database.id, {
      title,
      properties: properties ?? {},
      templateId: template_id ?? null,
      useDefault: noValues,
    });
    if (markdown !== undefined) await getCollab().replaceContent(created.id, markdown, actor);
    const output = await rowOutput(ctx, database.id, created.id);
    return created.templateId ? { ...output, from_template: created.templateId } : output;
  }
  const created = await pages.createPage(actor, {
    workspaceId: database.workspaceId,
    parentId: database.id,
    title,
    properties: properties ?? {},
    markdown,
  });
  return rowOutput(ctx, database.id, created.id);
}

export async function createDatabaseRows(ctx: OperationContext, { database_id, rows }: Args<"createDatabaseRows">) {
  const { userId, actor } = ctx;
  const { database } = await databases.getDatabase(userId, database_id);
  if (database.archivedAt) throw new ToolInputError("This database is in the trash.");
  const created = await databases.createRows(userId, database.id, rows);
  const collab = getCollab();
  for (const [i, row] of created.entries()) {
    const markdown = rows[i].markdown;
    if (markdown?.trim()) await collab.replaceContent(row.id, markdown, actor);
  }
  return {
    database_id: database.id,
    created: created.length,
    rows: created.map((r) => ({ id: r.id, title: pageLabel(r.title), url: pageUrl(database.workspaceId, r.id) })),
    url: pageUrl(database.workspaceId, database.id),
  };
}

/** A database row with its property values (REST only; MCP reads rows with get_page). */
export async function getDatabaseRow(ctx: OperationContext, { row_id }: { row_id: string }) {
  const { parentDatabase } = await loadPage(ctx, row_id);
  if (!parentDatabase) throw new ToolInputError("This page is not a database row.");
  return rowOutput(ctx, parentDatabase.id, row_id);
}

export async function updateDatabaseRow(ctx: OperationContext, { row_id, title, properties }: Args<"updateDatabaseRow">) {
  const { userId, actor } = ctx;
  if (title === undefined && !properties) throw new ToolInputError("Provide title and/or properties.");
  const { page, parentDatabase } = await loadPage(ctx, row_id);
  if (!parentDatabase) throw new ToolInputError("This page is not a database row. Use update_page for regular pages.");
  if (page.archivedAt) throw new ToolInputError("This row is in the trash.");
  if (properties && Object.keys(properties).length) await databases.updateRowProperties(userId, row_id, properties);
  if (title !== undefined) await pages.renamePage(actor, row_id, title);
  const out = await rowOutput(ctx, parentDatabase.id, row_id);
  // The rename lands in the live document first; report the new title right away.
  return title !== undefined ? { ...out, title } : out;
}

export async function updateDatabaseRows(
  ctx: OperationContext,
  { database_id, row_ids, properties }: Args<"updateDatabaseRows">,
) {
  if (!Object.keys(properties).length) throw new ToolInputError("Provide at least one property value.");
  const { database } = await databases.getDatabase(ctx.userId, database_id);
  if (database.archivedAt) throw new ToolInputError("This database is in the trash.");
  const { done, skipped } = await databases.updateRowsProperties(ctx.userId, database.id, row_ids, properties);
  return {
    database_id: database.id,
    updated: done.length,
    ...(skipped.length ? { skipped_row_ids: skipped } : {}),
    url: pageUrl(database.workspaceId, database.id),
  };
}

/**
 * Replaces who may see and change a database property (see server/property-access). Needs full
 * access to the database. People are named by user id or email, groups by id or name, person
 * properties by name or id.
 */
export async function setPropertyAccess(
  ctx: OperationContext,
  { database_id, property, everyone, exceptions }: Args<"setPropertyAccess">,
) {
  const { userId } = ctx;
  const { database, properties } = await databases.getDatabase(userId, database_id);
  const { prop } = resolvePropertyKey(properties, property);
  if (!prop) throw new ToolInputError(`"${property}" is a built-in field, not a database property; it can't be restricted.`);
  const needsPeople = exceptions.some((e) => e.user);
  const needsGroups = exceptions.some((e) => e.group);
  const [members, groupList] = await Promise.all([
    needsPeople ? workspaces.listMembers(userId, database.workspaceId) : Promise.resolve([]),
    needsGroups ? groups.listGroups(userId, database.workspaceId) : Promise.resolve([]),
  ]);
  const resolved = exceptions.map((e) => {
    const named = [e.user, e.group, e.person_property].filter((v) => v !== undefined);
    if (named.length !== 1) throw new ToolInputError("Each exception names exactly one of user, group or person_property.");
    if (e.user !== undefined) {
      const needle = e.user.trim().toLowerCase();
      const member = members.find((m) => m.userId === e.user) ?? members.find((m) => m.email?.toLowerCase() === needle);
      if (!member) throw new ToolInputError(`"${e.user}" is not a person of this workspace. Call list_users for ids and emails.`);
      return { userId: member.userId, level: e.level };
    }
    if (e.group !== undefined) {
      const needle = e.group.trim().toLowerCase();
      const byName = groupList.filter((g) => g.name.trim().toLowerCase() === needle);
      if (byName.length > 1) throw new ToolInputError(`"${e.group}" matches ${byName.length} groups; use a group id.`);
      const group = groupList.find((g) => g.id === e.group) ?? byName[0];
      if (!group) throw new ToolInputError(`"${e.group}" is not a group of this workspace. Call list_groups for their ids.`);
      return { groupId: group.id, level: e.level };
    }
    const { prop: person } = resolvePropertyKey(properties, e.person_property!);
    if (!person || (person.type !== "person" && person.type !== "created_by")) {
      throw new ToolInputError(`person_property must be a person or created_by property of this database; "${e.person_property}" isn't.`);
    }
    return { personPropertyId: person.id, level: e.level };
  });
  await propertyAccess.setPropertyAccess(userId, prop.id, { everyone, exceptions: resolved });
  const settings = await propertyAccess.getPropertyAccessSettings(userId, prop.id);
  return {
    database_id: database.id,
    property: prop.name,
    property_id: prop.id,
    ...describeAccessSettings(settings),
    url: pageUrl(database.workspaceId, database.id),
  };
}

export async function listComments(ctx: OperationContext, { page_id, include_resolved }: Args<"listComments">) {
  const { userId } = ctx;
  const page = await pages.getPage(userId, page_id);
  const threads = (await comments.listComments(userId, page_id)).filter((t) => include_resolved || !t.resolved);
  const people = await comments.commentUsers(
    userId,
    page_id,
    threads.flatMap((t) => t.comments.map((c) => c.userId)),
  );
  const names = new Map(people.map((p) => [p.id, p.username]));
  return {
    page_id: page.id,
    title: pageLabel(page.title),
    threads: threads.map((t) => ({
      id: t.id,
      quote: t.quote ?? null,
      ...(t.page ? { about_page: true } : {}),
      resolved: t.resolved,
      comments: t.comments.map((c) => ({
        id: c.id,
        author: names.get(c.userId) ?? "Unknown",
        author_id: c.userId,
        created_at: c.createdAt,
        ...(c.updatedAt !== c.createdAt ? { edited_at: c.updatedAt } : {}),
        text: commentText(c.body),
        ...(c.reactions.length ? { reactions: c.reactions.map((r) => ({ emoji: r.emoji, count: r.userIds.length })) } : {}),
      })),
    })),
    url: pageUrl(page.workspaceId, page.id),
  };
}

export async function addComment(ctx: OperationContext, { page_id, text, quote, thread_id }: Args<"addComment">) {
  const { userId } = ctx;
  if (!quote === !thread_id) throw new ToolInputError("Pass either quote (to start a thread) or thread_id (to reply), not both.");
  const page = await pages.getPage(userId, page_id);
  const result = thread_id
    ? await comments.changeComments(userId, page_id, { type: "addComment", threadId: thread_id, body: text })
    : await comments.changeComments(userId, page_id, { type: "createThread", body: text, anchor: { quote: quote! } }).catch((error) => {
        if (error instanceof Error && error.message.includes("quoted text")) {
          throw new ToolInputError(
            "The page doesn't have that exact text within one paragraph. Copy a short passage from get_page's markdown, without formatting characters.",
          );
        }
        throw error;
      });
  return {
    thread_id: result.thread?.id,
    comment_id: result.comment?.id,
    url: pageUrl(page.workspaceId, page.id),
  };
}
