/**
 * What the MCP tools (mcp/tools.ts) and the REST API (api/) both do with pages, databases, rows
 * and comments: input schemas, checks and output. Each operation acts as `ctx.userId` with that
 * user's own page access (see access.ts); the caller checks what its credentials allow (OAuth or
 * token scopes, a token's workspace) before calling. Outputs use snake_case keys and carry an app
 * `url` for everything they name.
 */
import { createHash } from "node:crypto";
import * as z from "zod";
import type { Locale } from "@/i18n/config";
import { commentText, MAX_COMMENT_LENGTH, type CommentOp } from "@/lib/comments";
import { blockMarker, stripBlockMarkers } from "@/lib/block-edits";
import { markdownReferences } from "@/lib/embed-blocks";
import { env } from "@/lib/env";
import { asFiles, blockTypeFor } from "@/lib/files";
import { ICON_INPUT, ICON_RULE, parseIcon } from "@/lib/icon";
import { FILTER_COMBINATORS, MAX_FILTER_DEPTH, MAX_RELATIVE_DAYS } from "@/lib/filters";
import { pageLabel } from "@/lib/labels";
import { diffToText, wordsToText } from "@/lib/page-diff";
import { isPageLocked, PAGE_LOCKED_MESSAGE } from "@/lib/page-lock";
import {
  BACKGROUND_COLORS,
  BACKGROUND_PATTERNS,
  PAGE_COVERS,
  backgroundText,
  parseBackgroundText,
  parsePageBackground,
} from "@/lib/page-background";
import { AccessError, requirePageAccess } from "@/server/access";
import type { ImportWarning } from "@/lib/import/result";
import { calloutStylesOfWorkspaces } from "@/server/callout-styles";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import * as comments from "@/server/comments";
import { markedAmong, setThreadMarked } from "@/server/thread-state";
import * as databases from "@/server/databases";
import type { StoredFile } from "@/server/files";
import { resolveEmbeds } from "@/server/embeds";
import * as forms from "@/server/forms";
import * as groups from "@/server/groups";
import * as journal from "@/server/journal";
import * as journalDays from "@/lib/journal";
import { isTimeZone } from "@/lib/time-zone";
import { LINK_PLACEHOLDER } from "@/lib/link-context";
import { countBacklinks, labelPageLinks, listBacklinks, MAX_BACKLINKS } from "@/server/mentions";
import type { ChatScopeRef } from "@/server/semantic-search";
import { expandSyncedMarkdown } from "@/server/synced-blocks";
import * as pageMeta from "@/server/page-meta";
import { OutdatedError, outdatedState, setPageOutdated, type OutdatedState } from "@/server/page-outdated";
import { activeVerifications, setPageVerification, VerificationError, verificationOf } from "@/server/verification";
import { verificationUntil, type VerificationView } from "@/lib/verification";
import { isWatching, setWatching } from "@/server/page-watch";
import { isFollowing, setFollowing } from "@/server/row-follow";
import * as pages from "@/server/pages";
import { saveWebPage as saveWebPageOp, WebClipError } from "@/server/web-clip";
import * as propertyAccess from "@/server/property-access";
import * as rowActivityFeed from "@/server/row-activity-feed";
import { mergeRows as mergeRowsOp } from "@/server/merge-rows";
import { completeSprint as completeSprintOp } from "@/server/sprints";
import { COMBINE, MAX_MERGE_ROWS, MERGE_TITLE, MIN_MERGE_ROWS, type MergeChoices } from "@/lib/merge-rows";
import * as skills from "@/server/skills";
import * as snippets from "@/server/snippets";
import { parseSearchQuery } from "@/lib/search-query";
import { skillSlug } from "@/lib/skills";
import { MAX_ACTIVITY_PAGE } from "@/server/row-activity-feed";
import { valueText } from "@/lib/row-activity";
import * as teamspaces from "@/server/teamspaces";
import * as workspaces from "@/server/workspaces";
import * as templates from "@/server/templates";
import { builtinTemplate, isBuiltinTemplateKey } from "@/lib/builtin-templates";
import { mapFilterRules } from "@/lib/filters";
import { atLeast, PROPERTY_LEVELS } from "@/lib/property-access";
import { normalizeValue } from "@/lib/properties";
import { idFromLink, pageUrl, sliceText, ToolInputError, VersionConflictError } from "./mcp/format";
import { dashboardsOutput } from "./mcp/dashboards";
import { markdownDashboards } from "@/lib/dashboard";
import { withViewSorts } from "@/lib/views";
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
/**
 * Who an operation runs as. `timeZone`: theirs when the caller knows it (the AI chat has the
 * browser's), for a row template's "today" (lib/template-values); UTC otherwise (MCP, the API).
 */
export type OperationContext = { userId: string; actor: WriteActor; timeZone?: string };

export const MAX_BULK_ROWS = 100;

// ---------------------------------------------------------------------------- input schemas

export const id = (what: string) => z.string().min(1).describe(`The ${what} id (a UUID from another tool's output).`);

const checklistItem = z.object({ text: z.string(), checked: z.boolean().optional() });
const fileItem = z.object({ url: z.string(), name: z.string().optional() });
/** A date range (or a single date, without `end`), as an alternative to the "start/end" string. */
const dateRange = z.object({ start: z.string(), end: z.string().nullable().optional() });
export const rowValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  dateRange,
  z.array(z.union([z.string(), checklistItem, fileItem])),
  z.null(),
]);
export const rowProperties = z
  .record(z.string(), rowValue)
  .describe(
    'Property values keyed by name (case-insensitive) or id. select / multi_select / status: option name (array for multi_select). date: a day (YYYY-MM-DD), a time with its zone (2026-10-12T14:30:00Z or +03:00; stored in UTC), or a range of either as \"start/end\" or {start, end}. checkbox: true/false. email / phone: a string. checklist: item texts or {text, checked}. relation: row ids or exact row titles. person: user ids, emails, names or "me". files: /api/files/<id> paths, urls or {name, url} (upload with attach_file). null clears. relation, person, checklist and files are replaced, not merged. created_by, created_time, last_edited_by, last_edited_time and formula properties are read-only. Example: {"Status": "In progress", "Tags": ["urgent"], "Due": "2026-10-01", "Customer": ["Acme Ltd"], "Assignee": ["me"]}',
  );

// Rules inside groups take the same fields as top-level rules; only the top level describes them,
// because every level is spelled out in the tool list and each description would be sent again.
const filterRule = (described: boolean) => {
  const text = <T extends z.ZodType>(schema: T, description: string) => (described ? schema.describe(description) : schema);
  return z.object({
    property: text(z.string().min(1), "Property name or id, or title / created_at / updated_at."),
    op: z.enum(FILTER_OPS),
    value: text(
      z.union([z.string(), z.number(), z.boolean(), z.array(z.string()).min(1)]).optional(),
      "Value to compare; omit for is_empty / is_not_empty. is_within: today, {this,last,next}_{week,month,year}, {past,next}_n_days. is_any_of / is_none_of: option names, people or related rows.",
    ),
    days: text(
      z.number().int().min(1).max(MAX_RELATIVE_DAYS).optional(),
      "is_within {past,next}_n_days: days back or ahead of today.",
    ),
  });
};
const filterRuleInput = filterRule(true);
const nestedFilterRuleInput = filterRule(false);
const combinatorInput = z.enum(FILTER_COMBINATORS);
const filterGroupInput = <T extends z.ZodType>(rules: T) =>
  z.object({
    type: z.literal("group"),
    combinator: combinatorInput.default("and"),
    rules: z.array(rules).min(1),
  });
/**
 * A rule or a group. When neither fits, the error names what is wrong with the one the input was
 * meant to be (a plain union only says "Invalid input"), e.g. an unknown op.
 */
const ruleOrGroup = <G extends z.ZodType>(group: G, rule: typeof filterRuleInput = nestedFilterRuleInput) =>
  z.union([rule, group], {
    error: (issue) => {
      if (issue.code !== "invalid_union" || !issue.errors.length) return undefined;
      const input = issue.input as { type?: unknown } | null | undefined;
      const branch = issue.errors[input?.type === "group" ? 1 : 0] ?? [];
      return branch.map((e) => `${e.path.length ? `${e.path.join(".")}: ` : ""}${e.message}`).join("; ") || undefined;
    },
  });
// Spelled out level by level (instead of a recursive schema) so every MCP client can read it. The
// innermost group isn't spelled out again (each level is sent once more with every tool that takes
// filters): toFilterEntries checks it, and refuses a group nested deeper than MAX_FILTER_DEPTH
// with a message saying so.
const deepestGroup = z.object({ type: z.literal("group") }).loose();
export const filtersInput = z
  .array(ruleOrGroup(filterGroupInput(ruleOrGroup(filterGroupInput(ruleOrGroup(deepestGroup)))), filterRuleInput))
  .describe(
    `Filter rules and groups. A rule is {property, op, value}; a group is {type: "group", combinator: "and" (default) | "or", rules: [...]} whose rules are rules or groups, at most ${MAX_FILTER_DEPTH} levels deep. A plain list of rules keeps working.`,
  );
export const filterCombinatorInput = combinatorInput
  .optional()
  .describe('How the top-level filters combine: "and" (default, all must match) or "or" (any may match).');
/** The property create_database_row(s) match existing rows by, to update them instead of adding. */
export const MATCH_TYPES = ["text", "number", "email", "phone", "url", "select", "status"] as const;
const matchByInput = z
  .string()
  .min(1)
  .describe(
    `Upsert by this property (a name or id, or "title"): a row of the database whose value equals the one given is updated instead of a new one being added, and only when none does is the row added. Works with the title and ${MATCH_TYPES.join(", ")} properties (text and title compare trimmed, emails ignoring case); every row must give a value for it. When more than one existing row has the value, or two given rows share one, nothing is written and the error says so. An updated row gets the given title, properties and markdown (which replaces its body); template_id only applies to rows that are added.`,
  );
export const sortsInput = z.array(
  z.object({ property: z.string().min(1), direction: z.enum(["asc", "desc"]).default("asc") }),
);

/** Arguments of each shared operation, as the MCP tools take them (REST puts ids in the path). */
export const inputs = {
  search: z.object({
    query: z.string().min(1).describe("Words to look for."),
    workspace_id: z.string().optional().describe("Only search this workspace."),
    limit: z.number().int().min(1).max(50).default(10).describe("Maximum results (1-50, default 10)."),
    include_archived: z
      .boolean()
      .optional()
      .describe("Also include archived pages (out of date but kept; not the trash), marked archived: true. Left out by default."),
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
    include_archived: z
      .boolean()
      .optional()
      .describe(
        "Also list archived pages (out of date but kept; not the trash), marked archived: true. Left out by default; under a parent that is archived itself its pages are listed either way.",
      ),
  }),
  listTeamspaces: z.object({
    workspace_id: id("workspace"),
    include_archived: z.boolean().default(false).describe("Also list archived teamspaces."),
  }),
  listGroups: z.object({ workspace_id: id("workspace") }),
  getPage: z.object({
    page_id: id("page"),
    offset: z.number().int().min(0).default(0).describe("Character offset into the Markdown body, for long pages."),
    with_block_ids: z
      .boolean()
      .optional()
      .describe(
        'Put a line "<!-- block <id> -->" before each block of the body, to change single blocks with update_page (modes replace_block, insert_after, delete_block).',
      ),
  }),
  watchPage: z.object({
    page_id: id("page"),
    watching: z
      .boolean()
      .describe("true to watch the page (or follow the database row), false to mute it: no more notifications about its edits and new comment threads."),
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
    icon: z.string().max(64).optional().describe(ICON_INPUT),
    template_id: z
      .string()
      .optional()
      .describe('A page template of the workspace, or a built-in one ("builtin:<key>"), from list_templates.'),
  }),
  saveWebPage: z.object({
    url: z.string().min(1).max(2048).describe("The web page's address (http or https)."),
    workspace_id: z.string().optional().describe("Workspace for a top-level page. Ignored when parent_id is set."),
    parent_id: z
      .string()
      .optional()
      .describe("A page to save it under, or a database to save it into as a row (its first URL property gets the address)."),
    teamspace_id: z
      .string()
      .optional()
      .describe('Top-level pages: the teamspace to add it to, or "private" (the default) for a page only the user sees. Ignored when parent_id is set.'),
    quote: z.string().max(5000).optional().describe("Text from the page to show as a quote under the link back to it."),
  }),
  updatePage: z.object({
    page_id: id("page"),
    title: z.string().min(1).max(500).optional().describe("New title."),
    markdown: z.string().optional().describe("Markdown to write into the body."),
    mode: z
      .enum(["replace", "append", "replace_block", "insert_after", "delete_block"])
      .default("replace")
      .describe(
        '"replace" (default) overwrites the body; "append" adds to the end. With block_id: "replace_block" puts the Markdown in place of that block, "insert_after" adds it after the block, "delete_block" removes the block (no markdown).',
      ),
    block_id: z
      .string()
      .max(100)
      .optional()
      .describe('The block the block modes change, from get_page with with_block_ids (the id in its "<!-- block <id> -->" line).'),
    expected_version: z
      .string()
      .max(64)
      .optional()
      .describe(
        "The body's version from get_page (or from your last update_page). The page is changed only while its body still has that version, so edits someone made after you read it aren't overwritten. Pass it whenever you replace a body you read before.",
      ),
    background: z
      .string()
      .max(64)
      .nullable()
      .optional()
      .describe(
        `What fills the page behind its title and body: a color as "color:<name>" (${BACKGROUND_COLORS.join(", ")}; light in the light theme and dark in the dark one, black in both), a faint pattern as "pattern:<name>" (${BACKGROUND_PATTERNS.join(", ")}), a gradient band across the top as "cover:<name>" (${PAGE_COVERS.join(", ")}), or several separated by spaces, e.g. "color:black pattern:plus". It replaces the whole background. null removes it.`,
      ),
    verified: z
      .string()
      .max(10)
      .optional()
      .describe(
        'Mark the page verified (checked and right; needs full access) for "week", "month", "quarter" or "year", until a day ("YYYY-MM-DD"), or "forever"; "none" removes it. Search ranks verified pages higher.',
      ),
  }),
  pageId: z.object({ page_id: id("page") }),
  setPageArchived: z.object({
    page_id: id("page"),
    archived: z.boolean().describe("true to archive the page, false to unarchive it."),
  }),
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
    limit: z.number().int().min(1).max(200).default(50).describe("Maximum rows per page (1-200, default 50)."),
    cursor: z
      .string()
      .optional()
      .describe("next_cursor from the previous call, to read the next page. Pass the same filters, filter_combinator, sorts and view_id with it."),
    properties: z
      .array(z.string().min(1))
      .max(200)
      .optional()
      .describe(
        "Only return these properties' values in each row (names, case-insensitive, or ids); [] returns just each row's id, title and url. Leave out for every property.",
      ),
    include_archived: z
      .boolean()
      .optional()
      .describe("Also return rows archived on their own (out of date but kept; not the trash), marked archived: true. Left out by default, unless view_id names a view that shows them."),
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
    match_by: matchByInput.optional(),
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
    match_by: matchByInput.optional(),
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
    expect: z
      .number()
      .int()
      .min(0)
      .max(MAX_BULK_ROWS)
      .optional()
      .describe(
        "How many rows you expect to change. When the rows the call would change (row_ids the user may edit, repeats counted once) are a different number, nothing is written and the error says how many and which ids would be skipped.",
      ),
    dry_run: z
      .boolean()
      .default(false)
      .describe("true checks the values and reports which rows would change (row_ids) and which would be skipped, without writing anything."),
  }),
  mergeRows: z.object({
    database_id: id("database").optional().describe("The database of the rows; when given, every row must belong to it."),
    kept_row_id: id("row").describe("The row that stays: the others are merged into it and go to the trash."),
    other_row_ids: z
      .array(z.string().min(1))
      .min(MIN_MERGE_ROWS - 1)
      .max(MAX_MERGE_ROWS - 1)
      .describe(`Ids of the rows merged into the kept one (${MIN_MERGE_ROWS - 1}-${MAX_MERGE_ROWS - 1}), of the same database.`),
    properties: z
      .record(z.string(), z.string().min(1))
      .optional()
      .describe(
        `Which row each property's value comes from, by property name or id: a row id of the merge, or "${COMBINE}" for every row's values together (multi-select, relation, person, files and checklist properties). Properties left out keep the kept row's value, or the first row's that has one; relations combine.`,
      ),
    title: z.string().min(1).optional().describe("The row id of the merge whose title the kept row takes (default: the kept row's, or the first one that has one)."),
    dry_run: z.boolean().default(false).describe("true checks the merge and reports what it would do, without writing anything."),
  }),
  completeSprint: z.object({
    database_id: id("database").describe("A task database with sprints turned on, or its sprints database."),
    dry_run: z.boolean().default(false).describe("true says what completing the sprint would change, without changing anything."),
  }),
  listRowActivity: z.object({
    row_id: id("row"),
    limit: z.number().int().min(1).max(MAX_ACTIVITY_PAGE).default(20).describe(`How many entries to return (1-${MAX_ACTIVITY_PAGE}, default 20).`),
    offset: z.number().int().min(0).default(0).describe("How many of the newest entries to skip, to read further back."),
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
    property: z.string().min(1).max(200).optional().describe("A database row: start a thread on this property's value instead (its name or id)."),
    thread_id: z.string().min(1).optional().describe("Reply in this thread instead."),
  }),
  changeComment: z.object({
    page_id: id("page"),
    thread_id: z.string().min(1).max(100).describe("The thread's id, from list_comments."),
    action: z
      .enum(["edit", "delete", "delete_thread", "resolve", "reopen", "react", "unreact", "mark", "unmark"])
      .describe(
        "edit: change a comment's text (comment_id, text). delete: delete a comment (comment_id). delete_thread: delete the whole thread. resolve / reopen: the thread. react / unreact: add or take back the user's emoji on a comment (comment_id, emoji). mark / unmark: the user's own Come back later mark on the thread.",
      ),
    comment_id: z.string().min(1).max(100).optional().describe("edit, delete, react, unreact: the comment's id, from list_comments."),
    text: z.string().min(1).max(MAX_COMMENT_LENGTH).optional().describe("edit: the comment's new text."),
    emoji: z.string().min(1).max(32).optional().describe("react, unreact: one emoji, such as 👍."),
  }),
  listMeetingNotes: z.object({
    workspace_id: id("workspace"),
    query: z.string().max(200).optional().describe("Only meetings whose title, page, attendees or summary hold every word of this."),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only meetings held or planned on or after this day (YYYY-MM-DD, UTC)."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only meetings held or planned on or before this day (YYYY-MM-DD, UTC)."),
    limit: z.number().int().min(1).max(100).default(25).describe("Maximum meetings (1-100, default 25)."),
  }),
  listSkills: z.object({
    workspace_id: z.string().optional().describe("Only this workspace's skills. Leave out for every workspace."),
  }),
  listSnippets: z.object({
    workspace_id: z.string().optional().describe("Only the user's own snippets and this workspace's. Leave out for every workspace."),
  }),
  getSkill: z.object({
    skill: z.string().min(1).describe("The skill's name (from list_skills) or title, or its page id or link."),
    offset: z.number().int().min(0).default(0).describe("Character offset into the instructions, for long skills."),
  }),
  setSkill: z.object({
    page_id: id("page"),
    skill: z.boolean().optional().describe("true marks the page or row as a skill, false unmarks it."),
    description: z
      .string()
      .max(skills.MAX_SKILL_DESCRIPTION)
      .optional()
      .describe("What the skill is for and when to use it, in a sentence or two. Empty clears it."),
  }),
  dailyNote: z.object({
    workspace_id: id("workspace"),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("The day, YYYY-MM-DD. Leave out for today in time_zone."),
    time_zone: z
      .string()
      .max(64)
      .optional()
      .describe('The user\'s IANA time zone (such as "Europe/Istanbul"), for what today is when date is left out. UTC when left out.'),
  }),
  listDailyNotes: z.object({
    workspace_id: id("workspace"),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First day to list, YYYY-MM-DD."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last day to list, YYYY-MM-DD."),
    limit: z.number().int().min(1).max(366).default(31).describe("Maximum notes (1-366, default 31), newest first."),
  }),
};

export type Args<K extends keyof typeof inputs> = z.infer<(typeof inputs)[K]>;

// ---------------------------------------------------------------------------- helpers

/** Loads a page with its parent, when the user can see it, and its database, if it is a row. */
export async function loadPage(ctx: OperationContext, pageId: string) {
  const page = await pages.getPage(ctx.userId, pageId);
  const parent = page.parentId ? await pages.getPage(ctx.userId, page.parentId).catch(() => null) : null;
  return { page, parent, parentDatabase: parent?.kind === "database" ? parent : null };
}

/**
 * Puts a file uploaded to a page (files.uploadFile) on it, as `ctx`: added to `filesPropertyId`, a
 * files property of the row the page is, or else at the end of its body as an image, video, audio
 * or file block chosen by its type, a history snapshot saved first. Callers check first that the
 * person may change that value, or the page's text (not locked).
 */
export async function placeFile(
  ctx: OperationContext,
  pageId: string,
  stored: Pick<StoredFile, "url" | "name" | "contentType">,
  { filesPropertyId, caption = "" }: { filesPropertyId?: string; caption?: string } = {},
) {
  if (filesPropertyId) {
    const page = await pages.getPage(ctx.userId, pageId);
    const current = asFiles(page.properties?.[filesPropertyId]);
    await databases.updateRowProperties(ctx.userId, pageId, { [filesPropertyId]: [...current, { url: stored.url }] });
    return;
  }
  await getCollab().appendBlocks(pageId, [{ type: blockTypeFor(stored.contentType), props: { url: stored.url, name: stored.name, caption } }], ctx.actor, true);
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
  // The keys a page body's `> [!key]` callouts can name (lib/content-markdown).
  const styles = await calloutStylesOfWorkspaces(workspaces.map((w) => w.id));
  return {
    workspaces: workspaces.map((w) => {
      const own = styles.get(w.id) ?? [];
      return {
        id: w.id,
        name: w.name,
        role: w.role,
        callout_styles: own.length ? own.map((s) => ({ key: s.key, name: s.name, title: s.title || undefined })) : undefined,
      };
    }),
  };
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
      // Watching a teamspace watches all its pages (watch_page mutes single ones).
      watching: t.watching,
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
 * pages.searchPages). `match` says how a result was found: "semantic" when only by meaning;
 * `document`, the PDF or Word document the page shows whose words matched, when not its own text.
 * `within` keeps to a page and its subpages, or to a teamspace (AI chat); `passages` adds the best matching passage of
 * each page (as far as semantic search found one) and the block it starts at (AI chat). `anyWord`:
 * pages with any of the query's words, not all (AI chat, which searches with whole questions).
 * Archived pages (server/page-outdated.ts) only with `include_archived`. Text in double quotes must
 * appear as written (lib/search-query), except with `anyWord`. `filters`: teamspaces, people who
 * created or last edited a page, and when (the REST API's search parameters).
 */
export async function search(
  ctx: OperationContext,
  { query, workspace_id, limit, include_archived = false }: Args<"search">,
  {
    within,
    passages = false,
    anyWord = false,
    filters = {},
  }: {
    within?: ChatScopeRef;
    passages?: boolean;
    anyWord?: boolean;
    filters?: Pick<pages.SearchOptions, "teamspaceIds" | "createdBy" | "editedBy" | "createdIn" | "editedIn">;
  } = {},
) {
  const hits = await pages.searchPages(ctx.userId, query, {
    workspaceId: workspace_id,
    limit,
    ...(within?.kind === "page" ? { withinPageId: within.id } : within?.kind === "teamspace" ? { withinTeamspaceId: within.id } : {}),
    anyWord,
    includeOutdated: include_archived,
    ...(anyWord ? {} : { phrases: parseSearchQuery(query).phrases }),
    ...filters,
  });
  const verifications = await activeVerifications(hits.filter((h) => h.verified).map((h) => h.id));
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
      // Found by the words of a PDF or Word document the page shows (the snippet is from it).
      document: h.file ? { id: h.file.id, name: h.file.name } : null,
      archived: h.outdated,
      // Verified right now: ranked above an otherwise equal page.
      verified: verifiedField(verifications.get(h.id) ?? null),
      updated_at: h.updatedAt.toISOString(),
      url: pageUrl(h.workspaceId, h.id),
      ...(passages ? { passage: h.passage ?? null, block_id: h.blockId ?? null } : {}),
    })),
  };
}

/** A daily note's day as given, or today in `timeZone` (UTC when it isn't one). */
function noteDay(date: string | undefined, timeZone: string | undefined) {
  if (timeZone !== undefined && !isTimeZone(timeZone)) throw new ToolInputError(`"${timeZone}" is not an IANA time zone such as "Europe/Istanbul".`);
  return date ?? journalDays.today(timeZone ?? "UTC");
}

function journalCall<T>(fn: () => Promise<T>) {
  return fn().catch((error) => {
    if (error instanceof journal.JournalError) throw new ToolInputError(`${error.message}.`);
    throw error;
  });
}

/** The user's note for a day, made under their private journal when they have none yet. */
export async function getOrCreateDailyNote(ctx: OperationContext, { workspace_id, date, time_zone }: Args<"dailyNote">) {
  const day = noteDay(date, time_zone);
  const note = await journalCall(() => journal.getOrCreateDailyNote(ctx.actor, workspace_id, day));
  return {
    date: note.day,
    id: note.pageId,
    title: pageLabel(note.title),
    created: note.created,
    workspace_id,
    url: pageUrl(workspace_id, note.pageId),
  };
}

/** The user's daily notes in a workspace, newest first. */
export async function listDailyNotes(ctx: OperationContext, { workspace_id, from, to, limit }: Args<"listDailyNotes">) {
  const notes = await journalCall(() => journal.listDailyNotes(ctx.userId, workspace_id, { from, to, limit }));
  return {
    notes: notes.map((n) => ({ date: n.day, id: n.pageId, title: pageLabel(n.title), url: pageUrl(workspace_id, n.pageId) })),
  };
}

/** Starred pages are listed archived or not: the user picked them. */
export async function listPages(
  ctx: OperationContext,
  { workspace_id, parent_id, teamspace_id, favorites, include_archived = false }: Args<"listPages">,
) {
  if (favorites && (parent_id || teamspace_id)) throw new ToolInputError("favorites lists the starred pages of the whole workspace: leave out parent_id and teamspace_id.");
  const children = favorites
    ? await pageMeta.listFavorites(ctx.userId, workspace_id)
    : await pages.listChildren(ctx.userId, workspace_id, parent_id ?? null, { teamspaceId: spaceOf(teamspace_id), includeOutdated: include_archived });
  return {
    pages: children.map((c) => ({
      id: c.id,
      title: pageLabel(c.title),
      kind: c.kind,
      icon: c.icon,
      teamspace_id: c.teamspaceId,
      archived: c.outdated,
      updated_at: c.updatedAt.toISOString(),
      url: pageUrl(workspace_id, c.id),
    })),
  };
}

/** `maxMarkdownChars` bounds the body returned (MCP keeps it to what a model reads at once). */
export async function getPage(
  ctx: OperationContext,
  { page_id, offset, with_block_ids }: Args<"getPage">,
  { maxMarkdownChars }: { maxMarkdownChars?: number } = {},
) {
  const { userId } = ctx;
  const { page, parent, parentDatabase } = await loadPage(ctx, page_id);
  const [crumbs, content, workspaces, favorite, version, watching, outdated, verification] = await Promise.all([
    pages.getBreadcrumbs(userId, page_id),
    getCollab().readPage(page_id),
    pages.listWorkspaces(userId),
    pageMeta.isFavorite(userId, page_id),
    page.kind === "database" ? null : getCollab().pageVersion(page_id),
    watchState(userId, page_id),
    outdatedState(userId, page_id),
    verificationOf(page_id),
  ]);
  const workspace = workspaces.find((w) => w.id === page.workspaceId);
  // Mentioned pages read as their current title, as far as the user can see them.
  // With block ids: each block's Markdown after a line naming it (lib/block-edits blockMarker).
  const markdown =
    with_block_ids && page.kind !== "database"
      ? (await getCollab().blockMarkdown(page_id)).map((b) => `${blockMarker(b.id)}\n${b.markdown}`).join("\n\n")
      : content.markdown;
  // Synced blocks shown from other pages read as their blocks, as far as the user can see them.
  const body = sliceText(await labelPageLinks(userId, await expandSyncedMarkdown(userId, page_id, markdown)), offset, maxMarkdownChars);
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
    ...archivedFields(page.workspaceId, outdated),
    // A locked page's title, icon, background and body can't change; a locked database's properties and views.
    locked: Boolean(page.lockedAt),
    verified: verifiedField(verification),
    favorite,
    // Templates are neither watched nor followed.
    ...(watching === null ? {} : { watching }),
    // A skill's body is instructions someone may ask to follow; get_skill reads it under its name.
    ...(page.isSkill && !page.inTemplate ? { skill: true, skill_description: page.skillDescription } : {}),
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
    if (version) out.version = version;
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
    if (markdownDashboards(content.markdown).length) {
      out.dashboards = await dashboardsOutput(userId, (await getCollab().readBlocks(page.id)).blocks);
    }
    // Archived ones too, marked: they are still the page's.
    const children = await pages.listChildren(userId, page.workspaceId, page.id, { includeOutdated: true });
    out.child_pages = children
      .slice(0, 100)
      .map((c) => ({ id: c.id, title: pageLabel(c.title), kind: c.kind, ...(c.outdated ? { archived: true } : {}) }));
    if (children.length > 100) out.child_pages_truncated = children.length;
    const backlinks = await listBacklinks(userId, page.id);
    if (backlinks.length) {
      const own = (text: string) => text.replaceAll(LINK_PLACEHOLDER, pageLabel(page.title));
      out.linked_from = backlinks.map((b) => {
        // The text around each link, the link read as this page's title.
        const contexts = (b.places ?? []).flatMap((p) => (p.context ? [own(p.context)] : []));
        return {
          id: b.id,
          title: pageLabel(b.title),
          url: pageUrl(b.workspaceId, b.id),
          ...(b.context ? { context: own(b.context) } : {}),
          ...(contexts.length > 1 ? { contexts } : {}),
        };
      });
      if (backlinks.length === MAX_BACKLINKS) {
        const total = await countBacklinks(userId, page.id);
        if (total > backlinks.length) out.linked_from_truncated = total;
      }
    }
  }
  return out;
}

/**
 * Whether a page is archived (server/page-outdated.ts), for get_page: when and by whom, or the page
 * above it that is archived (unnamed when the user can't open it).
 */
function archivedFields(workspaceId: string, state: OutdatedState | null) {
  if (!state) return { archived: false };
  return {
    archived: true,
    archived_at: state.at.toISOString(),
    archived_by: state.by,
    ...(state.own
      ? {}
      : { archived_with: state.title === null ? null : { id: state.pageId, title: pageLabel(state.title), url: pageUrl(workspaceId, state.pageId) } }),
  };
}

/** A page's verification as MCP and REST show it (server/verification): null when nobody verified it. */
export function verifiedField(view: VerificationView | null) {
  return view ? { by: view.by, at: view.at, until: view.until, expired: view.expired } : null;
}

/** Whether the user watches the page, or follows the database row; null for templates, which are neither. */
async function watchState(userId: string, pageId: string) {
  return (await isWatching(userId, pageId)) ?? (await isFollowing(userId, pageId));
}

/**
 * Watches a page or mutes it; for a database row, follows it or stops (server/page-watch.ts,
 * server/row-follow.ts).
 */
export async function watchPage(ctx: OperationContext, { page_id, watching }: Args<"watchPage">) {
  const { page } = await loadPage(ctx, page_id);
  if (page.isTemplate || page.inTemplate) throw new ToolInputError("Templates aren't watched: watch the pages made from them.");
  if ((await isFollowing(ctx.userId, page_id)) !== null) await setFollowing(ctx.userId, page_id, watching);
  else await setWatching(ctx.userId, page_id, watching);
  return { id: page.id, watching, url: pageUrl(page.workspaceId, page.id) };
}

export async function createPage(
  ctx: OperationContext,
  { workspace_id, parent_id, teamspace_id, title, markdown, icon, template_id }: Args<"createPage">,
) {
  const { userId, actor } = ctx;
  // Checked before anything is created: a page from a template gets its icon afterwards.
  if (icon !== undefined && icon !== null && !parseIcon(icon)) throw new ToolInputError(`icon must be ${ICON_RULE}.`);
  const location = await resolveLocation(ctx, workspace_id, parent_id, teamspace_id);
  if (location.parentKind === "database") {
    throw new ToolInputError("parent_id is a database. Use create_database_row to add rows to it.");
  }
  if (template_id) {
    let createdId: string;
    let parts: templates.MadeFromBuiltin["parts"];
    if (template_id.startsWith("builtin:")) {
      const key = template_id.slice("builtin:".length);
      if (!isBuiltinTemplateKey(key)) throw new ToolInputError(`Unknown built-in template "${key}". Call list_templates for the keys.`);
      // A kit's pages and databases come with their own titles and bodies (its dashboard's widgets among them).
      if ((await builtinTemplate(key, undefined)).kind === "kit" && (title !== undefined || icon !== undefined || markdown !== undefined)) {
        throw new ToolInputError(
          `${template_id} sets up several pages and databases, each with its own title and body: leave out title, icon and markdown, and change a part afterwards with update_page.`,
        );
      }
      const made = await templates.createFromBuiltin(actor, location.workspaceId, key, { parentId: location.parentId, teamspaceId: location.teamspaceId });
      createdId = made.id;
      parts = made.parts;
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
      // A kit: everything it set up, in the order of the sidebar, the page above first.
      ...(parts && { parts: parts.map((p) => ({ id: p.id, title: pageLabel(p.title), kind: p.kind, url: pageUrl(created.workspaceId, p.id) })) }),
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

/** What a saved web page left out, in words. */
function webClipWarning(warning: ImportWarning): string {
  if (warning.code === "tooManyImages") return `${warning.count} more pictures were left out: at most ${warning.limit} are copied.`;
  if (warning.code === "fileNotStored") return `The picture "${warning.path}" wasn't copied (${warning.reason}).`;
  return warning.code;
}

/**
 * Saves the web page at `url` as a page (see server/web-clip.ts): under parent_id (a page), into
 * it as a row (a database), or at the top of the workspace.
 */
export async function saveWebPage(ctx: OperationContext, { url, workspace_id, parent_id, teamspace_id, quote }: Args<"saveWebPage">) {
  const location = await resolveLocation(ctx, workspace_id, parent_id, teamspace_id);
  let saved;
  try {
    saved = await saveWebPageOp(ctx.actor, {
      workspaceId: location.workspaceId,
      url,
      targetId: location.parentId,
      teamspaceId: location.teamspaceId ?? null,
      quote,
    });
  } catch (error) {
    if (error instanceof WebClipError && error.code === "noAccess") throw new AccessError();
    throw error;
  }
  const created = await pages.getPage(ctx.userId, saved.page.id);
  return {
    id: created.id,
    title: pageLabel(created.title),
    workspace_id: created.workspaceId,
    ...(await teamspaceOf(ctx, created.teamspaceId)),
    parent_id: created.parentId,
    row: saved.page.row,
    url: pageUrl(created.workspaceId, created.id),
    source_url: url,
    pictures_copied: saved.created.files,
    warnings: [...saved.warnings.map(webClipWarning), ...(saved.moreWarnings ? [`…and ${saved.moreWarnings} more.`] : [])],
  };
}

/** A page's background as MCP and REST show it: one string (lib/page-background backgroundText). */
function backgroundField(stored: unknown) {
  const background = parsePageBackground(stored);
  return { background: background ? backgroundText(background) : null };
}

/** The background update_page asks for: a new one, or none (null). */
function backgroundFromInput(background: string | null) {
  if (background === null) return null;
  const parsed = parseBackgroundText(background);
  if (!parsed) {
    throw new ToolInputError(
      `background must be "color:<name>" (${BACKGROUND_COLORS.join(", ")}), "pattern:<name>" (${BACKGROUND_PATTERNS.join(", ")}), "cover:<name>" (${PAGE_COVERS.join(", ")}) or several separated by spaces.`,
    );
  }
  return parsed;
}

/** `icon` (null clears it) is REST only: the MCP tool doesn't take it. */
export async function updatePage(
  ctx: OperationContext,
  { page_id, title, markdown, mode, block_id, expected_version, icon, background, verified }: Args<"updatePage"> & { icon?: string | null },
) {
  const { userId, actor } = ctx;
  const blockMode = mode === "replace_block" || mode === "insert_after" || mode === "delete_block";
  if (title === undefined && markdown === undefined && icon === undefined && background === undefined && verified === undefined && !blockMode) {
    throw new ToolInputError("Provide title, markdown, background and/or verified.");
  }
  // Checked before anything is written, like the rest of the input.
  const verifiedUntil = verified === undefined || verified === "none" ? undefined : verificationUntil(verified);
  if (verified !== undefined && verified !== "none" && verifiedUntil === undefined) {
    throw new ToolInputError('verified must be "week", "month", "quarter", "year", "forever", "none" or a day after today (YYYY-MM-DD) within five years.');
  }
  if (blockMode && !block_id) throw new ToolInputError(`mode "${mode}" needs block_id: read the page with get_page with_block_ids for the ids.`);
  if (block_id !== undefined && !blockMode) throw new ToolInputError('block_id goes with mode "replace_block", "insert_after" or "delete_block".');
  if ((mode === "replace_block" || mode === "insert_after") && !stripBlockMarkers(markdown ?? "").trim()) {
    throw new ToolInputError(`mode "${mode}" needs markdown.`);
  }
  if (mode === "delete_block" && markdown !== undefined) throw new ToolInputError('mode "delete_block" takes no markdown.');
  const { page } = await loadPage(ctx, page_id);
  if (page.archivedAt) throw new ToolInputError("This page is in the trash. Restore it in Leafdesk before editing.");
  // Before any of it is written: a locked page refuses the whole call.
  if (isPageLocked(page)) throw new ToolInputError(PAGE_LOCKED_MESSAGE);
  if (expected_version !== undefined && page.kind === "database") {
    throw new ToolInputError("Databases have no body, so they have no version: leave expected_version out.");
  }
  const changed: string[] = [];
  let version: string | undefined;
  if (markdown !== undefined || blockMode) {
    if (page.kind === "database") {
      throw new ToolInputError("Databases have no text body. Use create_database_row or update_database_row.");
    }
    // The body goes through a direct collab connection, which checks no access of its own.
    await requirePageAccess(userId, page_id, "content");
    const collab = getCollab();
    const check = { expectedVersion: expected_version, reportVersion: true };
    let write;
    if (blockMode) {
      const op = mode === "replace_block" ? "replace" : mode === "delete_block" ? "delete" : "insert_after";
      write = await collab.editBlocks(page_id, [{ op, blockId: block_id, markdown }], actor, { snapshot: true, ...check });
      if (write.missing !== null) {
        throw new ToolInputError(`The page has no block ${write.missing} (any more). Read it again with get_page with_block_ids.`);
      }
    } else {
      // Block markers copied from a read with block ids aren't written.
      const body = stripBlockMarkers(markdown!);
      write = mode === "append" ? await collab.appendContent(page_id, body, actor, true, check) : await collab.replaceContent(page_id, body, actor, true, { ...check, syncedBlocks: true });
    }
    if (write?.conflict) throw new VersionConflictError(expected_version!, write.version);
    version = write?.version;
    changed.push(
      mode === "append"
        ? "body (appended)"
        : mode === "replace_block"
          ? "body (block replaced)"
          : mode === "insert_after"
            ? "body (inserted after the block)"
            : mode === "delete_block"
              ? "body (block deleted)"
              : "body (replaced)",
    );
  } else if (expected_version !== undefined) {
    // Only the title or background changes, but the writer asked to change it as the page it read.
    version = await getCollab().pageVersion(page_id);
    if (version !== expected_version) throw new VersionConflictError(expected_version, version);
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
  if (verified !== undefined) {
    await setPageVerification(userId, page_id, verified === "none" ? undefined : verifiedUntil).catch((error) => {
      if (error instanceof VerificationError) throw new ToolInputError(`${error.message}.`);
      throw error;
    });
    changed.push(verified === "none" ? "verification removed" : "verified");
  }
  return {
    id: page.id,
    changed,
    ...(markdown !== undefined || blockMode ? { snapshot: "Saved the previous version to page history before writing." } : {}),
    ...(version ? { version } : {}),
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

/**
 * Archives a page or unarchives it (server/page-outdated.ts): full access only. Its sub-pages (a
 * database's rows) follow it.
 */
export async function setPageArchived(ctx: OperationContext, { page_id, archived }: Args<"setPageArchived">) {
  // Nothing is said about a page the user can't open.
  await pages.getPage(ctx.userId, page_id);
  const before = await outdatedState(ctx.userId, page_id);
  let page;
  try {
    page = await setPageOutdated(ctx.userId, page_id, archived);
  } catch (error) {
    if (error instanceof OutdatedError) throw new ToolInputError(`${error.message}.`);
    throw error;
  }
  const after = await outdatedState(ctx.userId, page_id);
  let note: string;
  if (archived) {
    note = before?.own
      ? "The page was already archived."
      : "Archived with its sub-pages: they stay readable and editable by link, but leave the sidebar, search and pickers (search with include_archived finds them).";
  } else if (after) {
    note = after.own
      ? "The page is still archived."
      : "The page itself isn't archived, but a page above it is: it comes back when that page is unarchived" +
        (after.title === null ? "." : ` ("${pageLabel(after.title)}", ${after.pageId}).`);
  } else note = before ? "Unarchived with its sub-pages." : "The page was not archived.";
  return {
    id: page.id,
    title: pageLabel(page.title),
    archived: Boolean(after),
    note,
    url: pageUrl(page.workspaceId, page.id),
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
    // How voice notes saved as rows are written up; the database's own guidance on what they cover.
    ...(database.voiceNoteInstructions ? { voice_note_instructions: database.voiceNoteInstructions } : {}),
    url: pageUrl(database.workspaceId, database.id),
  };
}

/** How a form view is shared, for tool output. */
export function formLinkOutput(type: string, link: { url: string; anonymous: boolean } | null | undefined) {
  if (type !== "form") return {};
  return link ? { public_url: `${env.appUrl}${link.url}`, anonymous: link.anonymous } : { public_url: null };
}

/**
 * Where a page of query_database starts: after the row a cursor names, by the key that placed it
 * (see databases.listRowsInOrder), so rows added, removed or moved between calls neither repeat
 * nor go missing. The cursor also carries a fingerprint of the query it belongs to. Cursors of the
 * REST API from before keys (`{o: offset}`) still read on from their position.
 */
type RowCursor = { offset: number } | { query: string; after: databases.RowOrderKey };

function queryFingerprint(args: Pick<Args<"queryDatabase">, "database_id" | "filters" | "filter_combinator" | "sorts" | "view_id">) {
  const { database_id, filters = [], filter_combinator = "and", sorts = [], view_id = null } = args;
  return createHash("sha256")
    .update(JSON.stringify({ database_id, filters, filter_combinator, sorts, view_id }))
    .digest("base64url")
    .slice(0, 16);
}

export function encodeRowCursor(query: string, key: databases.RowOrderKey) {
  return Buffer.from(JSON.stringify({ q: query, s: key.sort, p: key.position, c: key.created, i: key.id })).toString("base64url");
}

const INVALID_CURSOR = "The cursor is not valid. Pass next_cursor from the previous response as it is, or leave cursor out to start from the first row.";

export function decodeRowCursor(cursor: string): RowCursor {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ToolInputError(INVALID_CURSOR);
  }
  const c = (data ?? {}) as Record<string, unknown>;
  if (typeof c.o === "number" && Number.isInteger(c.o) && c.o >= 0) return { offset: c.o };
  if (
    typeof c.q !== "string" ||
    !Array.isArray(c.s) ||
    typeof c.p !== "number" ||
    typeof c.c !== "number" ||
    typeof c.i !== "string"
  ) {
    throw new ToolInputError(INVALID_CURSOR);
  }
  return { query: c.q, after: { sort: c.s, position: c.p, created: c.c, id: c.i } };
}

/**
 * Rows matching the filters, a page of `limit` at a time: `next_cursor` reads on from where the
 * page ends (null after the last). `properties` narrows the values each row returns. The first
 * page of a chart view also returns what the chart plots, over every matching row.
 */
export async function queryDatabase(
  ctx: OperationContext,
  { database_id, filters, filter_combinator, sorts, view_id, limit, cursor, properties: only, include_archived }: Args<"queryDatabase">,
) {
  const { userId } = ctx;
  const { database, properties, views, propertyAccess: levels } = await databases.getDatabase(userId, database_id);
  const props: PropertyDef[] = properties;
  const lookups = await databases.getLookups(userId, properties);
  const view = view_id ? views.find((v) => v.id === view_id) : undefined;
  if (view_id && !view) throw new ToolInputError(`No view with id "${view_id}" in this database.`);
  if (view?.type === "dashboard") {
    throw new ToolInputError("A dashboard view has no filters or sorts of its own (its widgets do): query without view_id, or with another view.");
  }
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
  const shown = only ? projectedProperties(props, only) : props;
  const query = queryFingerprint({ database_id, filters, filter_combinator, sorts, view_id });
  const from = cursor ? decodeRowCursor(cursor) : { offset: 0 };
  if ("query" in from && from.query !== query) {
    throw new ToolInputError(
      "This cursor belongs to another query. Pass the same filters, filter_combinator, sorts and view_id as the call that returned it, or leave cursor out to start from the first row.",
    );
  }
  // Filters and sorts run on the values the caller may see (databases.listRows): rows whose values
  // are kept from them count as empty there, so neither the rows returned nor total say anything
  // about those values.
  const { rows: ordered, sorts: applied } = await databases.listRowsInOrder(userId, database_id, {
    filters: [saved, own].filter((g) => g.rules.length),
    sorts: ownSorts ?? (view ? withViewSorts(view).sorts : undefined) ?? [],
    // Rows archived on their own (server/page-outdated.ts), as asked or as the view shows them.
    showOutdated: include_archived ?? view?.config.showOutdated,
  });
  let start: number;
  if ("query" in from) {
    // A view's sorts may have changed since; its key then no longer says where the page ends.
    if (from.after.sort.length !== applied.length) {
      throw new ToolInputError("The view's sorts changed since this cursor was made. Leave cursor out to start from the first row.");
    }
    const next = ordered.findIndex((r) => databases.compareRowOrder(r.key, from.after, applied) > 0);
    start = next === -1 ? ordered.length : next;
  } else start = from.offset;
  const window = ordered.slice(start, start + limit);
  const rest = ordered.length - start - window.length;
  const last = window.at(-1);
  const next_cursor = rest > 0 && last ? encodeRowCursor(query, last.key) : null;
  return {
    database_id: database.id,
    title: pageLabel(database.title),
    total: ordered.length,
    returned: window.length,
    rows: window.map(({ row: r }) => ({
      id: r.id,
      title: pageLabel(r.title),
      properties: displayProperties(shown, r.properties, lookups, env.appUrl),
      ...describeRowAccess(shown, r),
      ...(r.outdated ? { archived: true } : {}),
      url: pageUrl(database.workspaceId, r.id),
    })),
    next_cursor,
    has_more: next_cursor !== null,
    ...(next_cursor ? { note: `${rest} more matching rows: pass next_cursor as cursor (with the same filters and sorts) to read on.` } : {}),
    ...(view?.type === "chart" && !cursor
      ? {
          chart: {
            ...describeViewConfig(props, { ...view.config, filters: undefined, sorts: undefined }, lookups, "chart"),
            ...describeChartSeries(
              props,
              view.config,
              ordered.map((r) => r.row),
              lookups,
            ),
          },
        }
      : {}),
  };
}

/** The properties a query's `properties` names, by name (case-insensitive) or id; "title" is always returned. */
function projectedProperties(props: PropertyDef[], names: string[]) {
  const ids = new Set<string>();
  for (const name of names) {
    if (name.trim().toLowerCase() === "title") continue;
    const { prop } = resolvePropertyKey(props, name);
    if (!prop) throw new ToolInputError(`"${name}" is not a property whose values rows return.`);
    ids.add(prop.id);
  }
  return props.filter((p) => ids.has(p.id));
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
  { database_id, title, properties, markdown, template_id, match_by }: Args<"createDatabaseRow">,
) {
  const { userId } = ctx;
  const { database, properties: props, propertyAccess: levels } = await databases.getDatabase(userId, database_id);
  if (database.archivedAt) throw new ToolInputError("This database is in the trash.");
  if (match_by) {
    const [match] = await findMatches(ctx, database.id, props, levels, match_by, [{ title, properties }]);
    if (match) {
      const update = [{ match, title, properties, markdown }];
      await checkMatched(ctx, database.id, update);
      await updateMatched(ctx, database.id, update);
      return { ...(await rowOutput(ctx, database.id, match.id)), title, action: "updated" as const };
    }
    return { ...(await addRow(ctx, database, { title, properties, markdown, template_id })), action: "created" as const };
  }
  return addRow(ctx, database, { title, properties, markdown, template_id });
}

async function addRow(
  ctx: OperationContext,
  database: { id: string; workspaceId: string },
  { title, properties, markdown, template_id }: Omit<Args<"createDatabaseRow">, "database_id" | "match_by">,
) {
  const { actor } = ctx;
  const blank = template_id === "none";
  const noValues = !Object.keys(properties ?? {}).length && markdown === undefined;
  if (!blank && (template_id || noValues)) {
    const created = await templates.createRow(actor, database.id, {
      title,
      properties: properties ?? {},
      templateId: template_id ?? null,
      useDefault: noValues,
      timeZone: ctx.timeZone,
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

export async function createDatabaseRows(ctx: OperationContext, { database_id, rows, match_by }: Args<"createDatabaseRows">) {
  const { userId, actor } = ctx;
  const { database, properties: props, propertyAccess: levels } = await databases.getDatabase(userId, database_id);
  if (database.archivedAt) throw new ToolInputError("This database is in the trash.");
  const matches = match_by ? await findMatches(ctx, database.id, props, levels, match_by, rows) : rows.map(() => null);
  const fresh = rows.filter((_, i) => !matches[i]);
  const updates = rows.flatMap((row, i) => (matches[i] ? [{ ...row, match: matches[i] }] : []));
  // Every value is checked before anything is written: the matched rows' here, the new rows' by
  // createRows itself before it inserts them.
  if (updates.length) await checkMatched(ctx, database.id, updates);
  const created = await databases.createRows(userId, database.id, fresh);
  const collab = getCollab();
  for (const [i, row] of created.entries()) {
    const markdown = fresh[i].markdown;
    if (markdown?.trim()) await collab.replaceContent(row.id, markdown, actor);
  }
  await updateMatched(ctx, database.id, updates);
  const createdRows = [...created];
  const out = rows.map((row, i) => {
    const match = matches[i];
    const r = match ? { id: match.id, title: row.title } : createdRows.shift()!;
    return {
      id: r.id,
      title: pageLabel(r.title),
      ...(match_by ? { action: match ? ("updated" as const) : ("created" as const) } : {}),
      url: pageUrl(database.workspaceId, r.id),
    };
  });
  return {
    database_id: database.id,
    created: created.length,
    ...(match_by ? { updated: updates.length } : {}),
    rows: out,
    url: pageUrl(database.workspaceId, database.id),
  };
}

type MatchedRow = { id: string; title: string };
type RowWrite = { title: string; properties?: Record<string, unknown>; markdown?: string };

/**
 * For create_database_row(s) with match_by: the existing row each given row stands for, or null
 * when none does. Rows are matched on the values the user may see; a property they can't see in
 * any row can't be matched on. Refuses (writing nothing) a row without a value to match, two given
 * rows with the same value, and a value more than one existing row holds.
 */
async function findMatches(
  ctx: OperationContext,
  databaseId: string,
  props: PropertyDef[],
  levels: Record<string, PropertyAccessNote> | undefined,
  matchBy: string,
  rows: { title: string; properties?: Record<string, unknown> }[],
): Promise<(MatchedRow | null)[]> {
  const { prop } = resolvePropertyKey(props, matchBy);
  const byTitle = !prop && matchBy.trim().toLowerCase() === "title";
  if (!byTitle && (!prop || !(MATCH_TYPES as readonly string[]).includes(prop.type))) {
    throw new ToolInputError(`match_by must name the title or a ${MATCH_TYPES.join(", ")} property; "${matchBy}" isn't one.`);
  }
  if (prop) refuseHiddenValues(props, levels, [prop.id]);
  const name = prop?.name ?? "title";
  const which = (i: number) => (rows.length > 1 ? `Row ${i + 1} ("${rows[i].title.trim()}")` : "The row");
  // Values are compared as they are stored: options by id, numbers as numbers, text trimmed.
  const keyOf = (value: unknown) => {
    if (value === null || value === undefined || value === "") return null;
    if (prop?.type === "email") return JSON.stringify(String(value).trim().toLowerCase());
    return JSON.stringify(typeof value === "string" ? value.trim() : value);
  };
  const wanted = rows.map((row, i) => {
    let key: string | null;
    if (byTitle) key = keyOf(row.title);
    else {
      const given = Object.entries(row.properties ?? {}).find(([k]) => resolvePropertyKey(props, k).prop?.id === prop!.id);
      key = given ? keyOf(normalizeValue(prop!, given[1])) : null;
    }
    if (key === null) throw new ToolInputError(`${which(i)} has no value for "${name}", which match_by needs.`);
    return key;
  });
  const first = new Map<string, number>();
  for (const [i, key] of wanted.entries()) {
    const seen = first.get(key);
    if (seen !== undefined) {
      throw new ToolInputError(`Rows ${seen + 1} and ${i + 1} have the same "${name}"; give each value once.`);
    }
    first.set(key, i);
  }
  const existing = new Map<string, MatchedRow[]>();
  // Archived rows match too: they are still rows of the database.
  for (const row of await databases.listRows(ctx.userId, databaseId, { showOutdated: true })) {
    const key = keyOf(byTitle ? row.title : row.properties[prop!.id]);
    if (key === null || !first.has(key)) continue;
    existing.set(key, [...(existing.get(key) ?? []), { id: row.id, title: row.title }]);
  }
  return wanted.map((key, i) => {
    const found = existing.get(key) ?? [];
    if (found.length > 1) {
      throw new ToolInputError(
        `${which(i)}: ${found.length} rows already have this "${name}" (${found.map((r) => r.id).join(", ")}), so match_by can't tell which to update. Update one of them by id instead.`,
      );
    }
    return found[0] ?? null;
  });
}

/**
 * Checks, before anything is written, that every matched row can take its update: the user may
 * edit it and the values given (see databases.normalizeRowProperties), and rename it if its title
 * changes (a locked row keeps its title).
 */
async function checkMatched(ctx: OperationContext, databaseId: string, updates: (RowWrite & { match: MatchedRow })[]) {
  const { rows, skipped } = await databases.rowsWithAccess(
    ctx.userId,
    databaseId,
    updates.map((u) => u.match.id),
    "edit",
  );
  if (skipped.length) {
    throw new ToolInputError(`match_by found rows you can't edit (${skipped.join(", ")}), so nothing was written.`);
  }
  const stored = new Map(rows.map((r) => [r.id, r]));
  for (const update of updates) {
    const row = stored.get(update.match.id)!;
    const label = `Row "${update.title.trim()}"`;
    try {
      if (update.properties && Object.keys(update.properties).length) {
        await databases.normalizeRowProperties(ctx.userId, databaseId, update.properties, row.properties, { createdBy: row.createdBy });
      }
    } catch (error) {
      if (error instanceof Error) error.message = `${label}: ${error.message}`;
      throw error;
    }
    if (update.title.trim() !== update.match.title && isPageLocked(await pages.getPage(ctx.userId, row.id))) {
      throw new ToolInputError(`${label}: ${PAGE_LOCKED_MESSAGE}`);
    }
  }
}

/** Writes the update of each matched row, checked by checkMatched first: values, then title, then body. */
async function updateMatched(ctx: OperationContext, databaseId: string, updates: (RowWrite & { match: MatchedRow })[]) {
  const collab = getCollab();
  for (const { match, title, properties, markdown } of updates) {
    if (properties && Object.keys(properties).length) await databases.updateRowProperties(ctx.userId, match.id, properties);
    if (title.trim() !== match.title) await pages.renamePage(ctx.actor, match.id, title);
    if (markdown !== undefined) await collab.replaceContent(match.id, markdown, ctx.actor);
  }
}

/** A database row with its property values (REST only; MCP reads rows with get_page). */
export async function getDatabaseRow(ctx: OperationContext, { row_id }: { row_id: string }) {
  const { parentDatabase } = await loadPage(ctx, row_id);
  if (!parentDatabase) throw new ToolInputError("This page is not a database row.");
  return rowOutput(ctx, parentDatabase.id, row_id);
}

/**
 * A row's activity, newest first: who created it, and who changed its title or which value from
 * what to what (server/row-activity-feed.ts). Entries about properties the person may not see in
 * the row are left out; linked rows they can't open read as "(no access)".
 */
export async function listRowActivity(ctx: OperationContext, { row_id, limit, offset }: Args<"listRowActivity">) {
  const { page, parentDatabase } = await loadPage(ctx, row_id);
  if (!parentDatabase) throw new ToolInputError("This page is not a database row.");
  const { entries, total, hasMore } = await rowActivityFeed.listRowActivity(ctx.userId, row_id, { offset, limit });
  return {
    row_id,
    title: pageLabel(page.title),
    total,
    has_more: hasMore,
    entries: entries.map((e) => ({
      at: e.at,
      by: e.actor.person?.name ?? null,
      by_user_id: e.actor.person?.id ?? null,
      actor: e.actor.kind,
      ...(e.proposedBy ? { proposed_by: e.proposedBy.name, proposed_by_user_id: e.proposedBy.id } : {}),
      change: e.kind,
      ...(e.property ? { property: e.property.name, property_id: e.property.id } : {}),
      ...(e.kind === "created" || e.kind === "merged" ? {} : { from: e.from && valueText(e.from), to: e.to && valueText(e.to) }),
      ...(e.merged ? { merged_rows: e.merged.map((r) => ({ id: r.id, title: pageLabel(r.title) })) } : {}),
      ...(e.mergedFrom ? { merged_from: { id: e.mergedFrom.id, title: pageLabel(e.mergedFrom.title) } } : {}),
    })),
    url: pageUrl(page.workspaceId, page.id),
  };
}

/**
 * Merges duplicate rows into one (server/merge-rows.ts): the kept row takes the chosen values, and
 * the links, comments, activity, files, email and content of the others, which go to the trash.
 * Values are only ever picked from the rows, never given.
 */
export async function mergeRows(
  ctx: OperationContext,
  { database_id, kept_row_id, other_row_ids, properties, title, dry_run = false }: Args<"mergeRows">,
  { locale }: { locale?: Locale } = {},
) {
  const { page: kept, parentDatabase } = await loadPage(ctx, kept_row_id);
  if (!parentDatabase) throw new ToolInputError("This page is not a database row.");
  if (database_id !== undefined && parentDatabase.id !== database_id) throw new ToolInputError("The kept row isn't a row of this database.");
  const { properties: props } = await databases.getDatabase(ctx.userId, parentDatabase.id);
  const ids = new Set([kept.id, ...other_row_ids]);
  const rowChoice = (key: string, value: string) => {
    if (value === COMBINE || ids.has(value)) return value;
    throw new ToolInputError(`"${key}": "${value}" is neither a row of this merge nor "${COMBINE}".`);
  };
  const choices: MergeChoices = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    const { prop } = resolvePropertyKey(props, key);
    if (!prop) throw new ToolInputError(`"${key}" is a built-in field; give the title's row with "title".`);
    choices[prop.id] = rowChoice(prop.name, value);
  }
  if (title !== undefined) {
    if (!ids.has(title)) throw new ToolInputError(`"title": "${title}" is not a row of this merge.`);
    choices[MERGE_TITLE] = title;
  }
  const result = await mergeRowsOp(ctx.actor, { keptRowId: kept.id, otherRowIds: other_row_ids, choices }, { dryRun: dry_run, locale });
  return {
    ...(dry_run ? { dry_run: true } : {}),
    kept_row_id: result.keptRowId,
    [dry_run ? "would_merge_row_ids" : "merged_row_ids"]: result.mergedRowIds,
    title: pageLabel(result.title),
    relinked_rows: result.relinkedRows,
    moved: { comment_threads: result.threads, bodies: result.bodies, activity: result.activity, files: result.files, emails: result.emails },
    url: pageUrl(result.workspaceId, result.keptRowId),
  };
}

/**
 * Completes the current sprint (see server/sprints completeSprint): it is marked completed, the
 * next sprint becomes current, a new next one is planned when none waits, and unfinished tasks
 * move to the new current sprint.
 */
export async function completeSprint(ctx: OperationContext, { database_id, dry_run = false }: Args<"completeSprint">) {
  const { workspaceId } = await databases.requireDatabase(ctx.userId, database_id, "view");
  const result = await completeSprintOp(ctx.userId, database_id, { dryRun: dry_run });
  const sprint = (s: { id: string; title: string; created?: boolean }) => ({
    id: s.id,
    title: pageLabel(s.title),
    ...(s.created !== undefined ? { created: s.created } : {}),
    url: pageUrl(workspaceId, s.id),
  });
  return {
    ...(dry_run ? { dry_run: true } : {}),
    completed: sprint(result.completed),
    current: sprint(result.current),
    next: sprint(result.next),
    moved_tasks: result.moved,
    skipped_tasks: result.skipped,
  };
}

export async function updateDatabaseRow(ctx: OperationContext, { row_id, title, properties }: Args<"updateDatabaseRow">) {
  const { userId, actor } = ctx;
  if (title === undefined && !properties) throw new ToolInputError("Provide title and/or properties.");
  const { page, parentDatabase } = await loadPage(ctx, row_id);
  if (!parentDatabase) throw new ToolInputError("This page is not a database row. Use update_page for regular pages.");
  if (page.archivedAt) throw new ToolInputError("This row is in the trash.");
  // A locked row keeps its title; its properties stay editable, but not half of a call that renames it.
  if (title !== undefined && isPageLocked(page)) throw new ToolInputError(PAGE_LOCKED_MESSAGE);
  if (properties && Object.keys(properties).length) await databases.updateRowProperties(userId, row_id, properties);
  if (title !== undefined) await pages.renamePage(actor, row_id, title);
  const out = await rowOutput(ctx, parentDatabase.id, row_id);
  // The rename lands in the live document first; report the new title right away.
  return title !== undefined ? { ...out, title } : out;
}

export async function updateDatabaseRows(
  ctx: OperationContext,
  { database_id, row_ids, properties, expect, dry_run = false }: Args<"updateDatabaseRows">,
) {
  if (!Object.keys(properties).length) throw new ToolInputError("Provide at least one property value.");
  const { database } = await databases.getDatabase(ctx.userId, database_id);
  if (database.archivedAt) throw new ToolInputError("This database is in the trash.");
  const guard = ({ done, skipped }: databases.BulkResult) => {
    if (expect === undefined || done.length === expect) return;
    throw new ToolInputError(
      `Expected ${expect} ${expect === 1 ? "row" : "rows"} to change, but ${done.length} would${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}. Nothing was written.`,
    );
  };
  const { done, skipped } = await databases.updateRowsProperties(ctx.userId, database.id, row_ids, properties, {
    guard,
    dryRun: dry_run,
  });
  return {
    database_id: database.id,
    ...(dry_run ? { dry_run: true, would_update: done.length, row_ids: done } : { updated: done.length }),
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
  const marked = await markedAmong(userId, page_id, threads.map((t) => t.id));
  return {
    page_id: page.id,
    title: pageLabel(page.title),
    threads: threads.map((t) => ({
      id: t.id,
      quote: t.quote ?? null,
      ...(t.page ? { about_page: true } : {}),
      ...(t.property ? { property: t.property.name } : {}),
      resolved: t.resolved,
      ...(marked.has(t.id) ? { marked: true } : {}),
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

export async function addComment(ctx: OperationContext, { page_id, text, quote, property, thread_id }: Args<"addComment">) {
  const { userId } = ctx;
  if ([quote, property, thread_id].filter((v) => v !== undefined).length > 1) {
    throw new ToolInputError("Pass at most one of quote (a thread on text), property (a thread on a row's value) or thread_id (a reply); none starts a thread about the whole page.");
  }
  const { page, parentDatabase } = await loadPage(ctx, page_id);
  let propertyId: string | undefined;
  if (property !== undefined) {
    if (!parentDatabase) throw new ToolInputError("property is for database rows; this page isn't one. Quote its text, or leave quote out for a thread about the whole page.");
    const { properties } = await databases.getDatabase(userId, parentDatabase.id);
    const { prop } = resolvePropertyKey(properties, property);
    if (!prop) throw new ToolInputError(`"${property}" is not a property of this row's database. get_database lists them.`);
    propertyId = prop.id;
  }
  const result = thread_id
    ? await comments.changeComments(userId, page_id, { type: "addComment", threadId: thread_id, body: text })
    : await comments
        .changeComments(userId, page_id, {
          type: "createThread",
          body: text,
          ...(quote ? { anchor: { quote } } : {}),
          ...(propertyId ? { propertyId } : {}),
        })
        .catch((error) => {
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
    ...(!thread_id && !quote && !propertyId ? { about_page: true } : {}),
    url: pageUrl(page.workspaceId, page.id),
  };
}

/**
 * Changes a comment thread as `ctx`: edits or deletes a comment (the user's own, or anyone's with
 * full access), deletes, resolves or reopens the thread, reacts to a comment, or marks the thread
 * for the user to come back to. Answers with the thread as list_comments shows it, or deleted.
 */
export async function changeComment(ctx: OperationContext, { page_id, thread_id, action, comment_id, text, emoji }: Args<"changeComment">) {
  const { userId } = ctx;
  const onComment = action === "edit" || action === "delete" || action === "react" || action === "unreact";
  if (onComment && !comment_id) throw new ToolInputError(`${action} needs the comment's comment_id, from list_comments.`);
  if (!onComment && comment_id) throw new ToolInputError(`${action} is about the whole thread; leave comment_id out.`);
  if ((action === "edit") !== (text !== undefined)) throw new ToolInputError(action === "edit" ? "edit needs text: the comment's new text." : "text goes only with edit.");
  const reacting = action === "react" || action === "unreact";
  if (reacting !== (emoji !== undefined)) throw new ToolInputError(reacting ? `${action} needs an emoji.` : "emoji goes only with react and unreact.");
  if (action === "mark" || action === "unmark") await setThreadMarked(userId, page_id, thread_id, action === "mark");
  else {
    const op: CommentOp =
      action === "edit"
        ? { type: "updateComment", threadId: thread_id, commentId: comment_id!, body: text }
        : action === "delete"
          ? { type: "deleteComment", threadId: thread_id, commentId: comment_id! }
          : action === "delete_thread"
            ? { type: "deleteThread", threadId: thread_id }
            : action === "resolve"
              ? { type: "resolveThread", threadId: thread_id }
              : action === "reopen"
                ? { type: "unresolveThread", threadId: thread_id }
                : { type: action === "react" ? "addReaction" : "deleteReaction", threadId: thread_id, commentId: comment_id!, emoji: emoji! };
    await comments.changeComments(userId, page_id, op);
  }
  const { threads, url } = await listComments(ctx, { page_id, include_resolved: true });
  const thread = threads.find((t) => t.id === thread_id);
  return thread ? { page_id, thread, url } : { page_id, thread_id, deleted: true, url };
}

/** The meetings of a workspace the user can see, newest first, narrowed as asked. */
export async function listMeetingNotes(ctx: OperationContext, { workspace_id, query, from, to, limit }: Args<"listMeetingNotes">) {
  const { listMeetings } = await import("@/server/meetings");
  const { matchesMeeting } = await import("@/lib/meeting-list");
  const day = (m: { startedAt: string | null; scheduledAt: string | null }) => (m.startedAt ?? m.scheduledAt ?? "").slice(0, 10);
  const all = (await listMeetings(ctx.userId, workspace_id)).filter(
    (m) => (!query || matchesMeeting(m, query)) && (!from || (day(m) && day(m) >= from)) && (!to || (day(m) && day(m) <= to)),
  );
  return {
    workspace_id,
    meetings: all.slice(0, limit).map((m) => ({
      page_id: m.pageId,
      title: m.title || pageLabel(m.pageTitle),
      ...(m.title && m.title !== m.pageTitle ? { page_title: pageLabel(m.pageTitle) } : {}),
      status: m.status || (m.startedAt ? "ended" : "planned"),
      scheduled_at: m.scheduledAt,
      started_at: m.startedAt,
      ended_at: m.endedAt,
      minutes: Math.round(m.seconds / 60),
      attendees: m.attendees.map((a) => a.name),
      ...(m.preview ? { summary_start: m.preview } : {}),
      url: pageUrl(workspace_id, m.pageId),
    })),
    ...(all.length > limit ? { more: all.length - limit } : {}),
  };
}

// ---------------------------------------------------------------------------- history

/** A page's saved versions, newest first, with who made each change (a user, or a user through an app). */
export async function listPageHistory(ctx: OperationContext, { page_id }: Args<"pageId">) {
  const snapshots = await pages.listSnapshots(ctx.userId, page_id);
  return {
    page_id,
    versions: snapshots.map((s) => ({
      id: s.id,
      title: pageLabel(s.title),
      saved_at: new Date(s.createdAt).toISOString(),
      reason: s.reason,
      by: s.clientName ? `${s.authorName ?? "Unknown"} via ${s.clientName}` : (s.authorName ?? null),
    })),
  };
}

/** A saved version's title and Markdown body, from `offset`, cut at `maxChars`. */
export async function getPageVersion(ctx: OperationContext, { version_id, offset }: { version_id: string; offset: number }, { maxChars }: { maxChars?: number } = {}) {
  const snap = await pages.getSnapshot(ctx.userId, version_id);
  const body = sliceText(await labelPageLinks(ctx.userId, snap.contentMarkdown), offset, maxChars);
  return {
    id: snap.id,
    page_id: snap.pageId,
    title: pageLabel(snap.title),
    saved_at: new Date(snap.createdAt).toISOString(),
    markdown: body.text,
    ...(body.truncated ? { markdown_truncated: true, markdown_total_chars: body.totalChars, ...("note" in body ? { note: body.note } : {}) } : {}),
  };
}

/**
 * What changed between a saved version and the page now (`current`), or between the version saved
 * before it and this one (`previous`), one line per block (lib/page-diff diffToText).
 */
export async function diffPageVersion(
  ctx: OperationContext,
  { version_id, against, offset }: { version_id: string; against: "current" | "previous"; offset: number },
  { maxChars }: { maxChars?: number } = {},
) {
  const { diffSnapshot } = await import("@/server/page-history");
  const diff = await diffSnapshot(ctx.userId, version_id, against);
  if (!diff) return { version_id, against, note: "This is the oldest saved version; there is nothing earlier to compare it with." };
  const changed = diff.title !== null || diff.changes.some((c) => c.op !== "same");
  const body = sliceText(changed ? diffToText(diff.changes) : "", offset, maxChars);
  return {
    from: diff.fromId,
    to: diff.toId ?? "current",
    changed,
    ...(diff.title ? { title: wordsToText(diff.title) } : {}),
    changed_by: diff.actors.map((a) => (a.client ? `${a.name ?? "Unknown"} via ${a.client}` : a.name)),
    diff: body.text,
    ...(body.truncated ? { diff_truncated: true, diff_total_chars: body.totalChars, ...("note" in body ? { note: body.note } : {}) } : {}),
  };
}

// ---------------------------------------------------------------------------- skills

function skillOut(s: skills.NamedSkill, workspaces: number) {
  return {
    name: s.name,
    page_id: s.id,
    title: s.title,
    description: s.description,
    ...(s.described ? {} : { description_from_body: true }),
    ...(workspaces > 1 ? { workspace_id: s.workspaceId, workspace: s.workspaceName } : {}),
    ...(s.database ? { database_id: s.database.id, database: s.database.title } : {}),
    updated_at: s.updatedAt.toISOString(),
    url: pageUrl(s.workspaceId, s.id),
  };
}

export async function listSkills(ctx: OperationContext, { workspace_id }: Args<"listSkills">) {
  const all = await skills.namedSkills(ctx.userId);
  const workspaceId = workspace_id ? idFromLink("workspace_id", workspace_id) : undefined;
  if (workspaceId && !(await pages.listWorkspaces(ctx.userId)).some((w) => w.id === workspaceId)) {
    throw new ToolInputError("No workspace with that id. Call list_workspaces to see the user's workspaces.");
  }
  const list = workspaceId ? all.filter((s) => s.workspaceId === workspaceId) : all;
  const workspaces = new Set(all.map((s) => s.workspaceId)).size;
  return {
    skills: list.map((s) => skillOut(s, workspaces)),
    ...(list.length ? {} : { note: "No skills yet. Any page or database row can be made a skill with set_skill." }),
  };
}

/**
 * The user's snippets and those of their workspaces (where they are an owner or member), with
 * their Markdown bodies as stored: placeholders such as {{date}} are filled in by the editor.
 */
export async function listSnippets(ctx: OperationContext, { workspace_id }: Args<"listSnippets">) {
  const all = await pages.listWorkspaces(ctx.userId);
  const workspaceId = workspace_id ? idFromLink("workspace_id", workspace_id) : undefined;
  if (workspaceId && !all.some((w) => w.id === workspaceId)) {
    throw new ToolInputError("No workspace with that id. Call list_workspaces to see the user's workspaces.");
  }
  const shown = workspaceId ? all.filter((w) => w.id === workspaceId) : all;
  const names = new Map(shown.map((w) => [w.id, w.name]));
  const list = await snippets.snippetsForWorkspaces(ctx.userId, [...names.keys()]);
  return {
    snippets: list.map((s) => ({
      trigger: s.trigger,
      title: s.title,
      scope: s.scope,
      ...(s.workspaceId ? { workspace_id: s.workspaceId, workspace: names.get(s.workspaceId) ?? "" } : {}),
      markdown: s.body,
    })),
    placeholders:
      "{{date}}, {{time}}, {{datetime}}: now, in the user's language and time zone; {{me}}: the user's name; {{page}}: the page's title; {{cursor}}: where the caret goes (drop it when writing the snippet into a page).",
    ...(list.length ? {} : { note: "No snippets yet. People add them in Leafdesk under Settings > Snippets." }),
  };
}

/** `maxChars` bounds the instructions returned, like get_page's body. */
export async function getSkill(ctx: OperationContext, { skill, offset }: Args<"getSkill">, { maxChars }: { maxChars?: number } = {}) {
  const wanted = skill.trim();
  const pageId = idFromLink("page_id", wanted);
  const named = await skills.namedSkills(ctx.userId);
  // Its name, or its page, or its title (as names are made from titles); a title several skills
  // share names none of them.
  const titled = named.filter((s) => skillSlug(s.title) === skillSlug(wanted));
  if (!named.some((s) => s.name === wanted.toLowerCase() || s.id === pageId) && titled.length > 1) {
    throw new ToolInputError(`Several skills are titled "${wanted}": ${titled.map((s) => s.name).join(", ")}. Pass one of these names.`);
  }
  const found = named.find((s) => s.name === wanted.toLowerCase()) ?? named.find((s) => s.id === pageId) ?? titled[0];
  if (!found) {
    throw new ToolInputError(
      named.length ? `No skill named "${wanted}". Call list_skills to see the user's skills.` : "The user has no skills yet.",
    );
  }
  const content = await skills.getSkillContent(ctx.userId, found.id);
  const body = sliceText(content.body, offset, maxChars);
  return {
    name: found.name,
    page_id: content.id,
    title: content.title,
    description: content.description,
    instructions: body.text,
    ...(body.truncated ? { instructions_truncated: true, instructions_total_chars: body.totalChars } : {}),
    ...("note" in body ? { note: body.note } : {}),
    url: pageUrl(content.workspaceId, content.id),
  };
}

export async function setSkill(ctx: OperationContext, { page_id, skill, description }: Args<"setSkill">) {
  if (skill === undefined && description === undefined) throw new ToolInputError("Pass skill, description or both.");
  await skills.setSkill(ctx.userId, page_id, { skill, description });
  const page = await pages.getPage(ctx.userId, page_id);
  return {
    page_id: page.id,
    skill: page.isSkill,
    description: page.skillDescription,
    url: pageUrl(page.workspaceId, page.id),
  };
}
