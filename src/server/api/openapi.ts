import * as z from "zod";
import { API_TOKEN_SCOPES } from "@/db/schema";
import { API_ERROR_CODES } from "./errors";
import { API_PREFIX, DEFAULT_RATE_LIMIT, MAX_BODY_BYTES } from "./handler";
import type { ApiRoute } from "./routes";

type JsonSchema = Record<string, unknown>;

const TAGS = [
  { name: "Account", description: "The token and the user it acts for." },
  { name: "Workspaces", description: "Workspaces, their teamspaces and their page tree." },
  { name: "Pages", description: "Pages: read and write the body as Markdown, move, trash and restore, search." },
  { name: "Databases", description: "Database schemas and row queries." },
  { name: "Rows", description: "Database rows and their property values." },
  { name: "Comments", description: "Comment threads on pages." },
  { name: "Agents", description: "A workspace's agents: their settings, runs asked for now, schedules, run history and monthly usage." },
];

/** Field descriptions are shared with the MCP server and sometimes name its tools. */
const TOOL_NAMES = [
  ["get_page", "GET /pages/{page_id}"],
  ["update_page", "PATCH /pages/{page_id}"],
  ["get_database", "GET /databases/{database_id}"],
  ["query_database", "POST /databases/{database_id}/query"],
  ["create_database_row", "POST /databases/{database_id}/rows"],
  ["update_database_row", "PATCH /rows/{row_id}"],
  ["list_templates, attach_file", "the app (not in the REST API yet)"],
];

const DESCRIPTION = `A REST API for the pages, databases, rows and comments of Leafdesk, acting as the user who created the token, with that user's own access to pages.

**Authentication.** Create a personal access token in Settings → Connected apps and send it as \`Authorization: Bearer esi_…\`. Tokens have the scope \`pages:read\` (GET endpoints) and optionally \`pages:write\` (everything that changes data), may be limited to one workspace and may expire. Tokens look like \`esi_\` followed by 40 letters and digits, so secret scanners can spot leaked ones; revoke a leaked token in Settings. Tokens act outside a workspace's "require two-step verification" policy, like connected MCP apps.

**Errors** are JSON: \`{"error": {"code": "not_found", "message": "…"}}\`, with \`details\` for invalid input. A page, database or row that doesn't exist and one the user may not see both answer \`404 not_found\`.

**Pagination.** Lists return \`next_cursor\` and \`has_more\`; pass \`cursor=<next_cursor>\` (a body field for the query endpoint) to read on.

**Rate limits.** Each token may make ${DEFAULT_RATE_LIMIT} requests a minute unless the server sets another limit; \`X-RateLimit-Limit\` and \`X-RateLimit-Remaining\` show where you stand, and \`429 rate_limited\` comes with \`Retry-After\`. JSON request bodies can be at most ${MAX_BODY_BYTES / 1024 / 1024} MB; endpoints that take files (multipart form data) say their own limit.

**CORS** is off unless the server lists allowed origins, so browsers can't call the API from other sites by default.

**Property access.** A database property can be restricted: some people may not see it at all, see it without its values, or only read its values. The API answers as the token's user: properties they can't know of are left out everywhere (schema, rows, views, errors), values they may not see are left out of rows and named in \`hidden_properties\`, and filters and sorts never run on values kept from them. People with full access to a database see everything, with each restricted property's settings in \`access_settings\`.

**Page bodies** are Markdown with a few extensions (callouts, equations, columns, mentions, embedded databases); see the MCP server's instructions in the README. Every body change saves the previous version to page history first.

Field descriptions are shared with Leafdesk's MCP server; where they name its tools: ${TOOL_NAMES.map(([tool, rest]) => `\`${tool}\` → ${rest}`).join(", ")}.`;

const url = { type: "string", format: "uri", description: "Link to it in the app." };
const id = { type: "string" };
const loose = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: true,
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const cursorFields = {
  next_cursor: { type: ["string", "null"], description: "Pass as cursor to read the next page; null after the last one." },
  has_more: { type: "boolean" },
};
const pageKind = { type: "string", enum: ["page", "database"] };
const upsertAction = {
  type: "string",
  enum: ["created", "updated"],
  description: "With match_by: whether the row was added or an existing row with the same value was updated.",
};
const teamspaceId = { type: ["string", "null"], description: "The page's teamspace; null for a private page." };
const teamspaceFields = {
  teamspace_id: teamspaceId,
  teamspace: { type: ["string", "null"], description: '"Private" for a private page.' },
};
const propertyValues = {
  type: "object",
  additionalProperties: true,
  description:
    "Values by property name: text, numbers, booleans, option names, dates as written by the date property (a day YYYY-MM-DD, a UTC time 2026-10-12T11:30:00.000Z, or a range \"start/end\" of either), relations as [{id, title}], people as [{id, name}], checklists as [{text, checked}], files as [{name, url}].",
};
/** What property access keeps from the user in a row (see "Property access" above). */
const rowAccessFields = {
  hidden_properties: {
    type: "array",
    items: { type: "string" },
    description: "Properties whose values the user may not see in this row: left out of properties, not empty.",
  },
  read_only_properties: {
    type: "array",
    items: { type: "string" },
    description: "Properties whose values the user may see but not change in this row.",
  },
};
const propertyLevel = { type: "string", enum: ["none", "view_property", "view", "edit_values", "edit"] };

const SCHEMAS: Record<string, JsonSchema> = {
  Error: {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string", enum: Object.keys(API_ERROR_CODES) },
          message: { type: "string" },
          details: { type: "array", items: loose({ path: { type: "string" }, message: { type: "string" } }) },
        },
      },
    },
  },
  Me: loose({
    user: loose({ id, name: { type: "string" }, email: { type: "string" } }),
    token: loose({
      id,
      scopes: { type: "array", items: { type: "string", enum: [...API_TOKEN_SCOPES] } },
      workspace_id: { type: ["string", "null"] },
      expires_at: { type: ["string", "null"], format: "date-time" },
    }),
  }),
  WorkspaceList: loose({
    workspaces: {
      type: "array",
      items: loose(
        {
          id,
          name: { type: "string" },
          role: { type: "string", enum: ["owner", "member", "guest"] },
          callout_styles: {
            type: "array",
            description: "The workspace's callout styles, when it has any: a page body writes one as `> [!key] Title`.",
            items: loose({ key: { type: "string" }, name: { type: "string" }, title: { type: "string" } }, ["key", "name"]),
          },
        },
        ["id", "name", "role"],
      ),
    },
  }),
  TeamspaceList: loose({
    teamspaces: {
      type: "array",
      items: loose(
        {
          id,
          name: { type: "string" },
          icon: { type: ["string", "null"] },
          description: { type: "string" },
          access: { type: "string", enum: ["default", "open", "closed", "private"] },
          member_access: {
            type: "string",
            enum: ["full", "edit", "comment", "view"],
            description: "What members get on its pages where a page doesn't set it; its owners and workspace owners get full access.",
          },
          archived: { type: "boolean" },
          member_count: { type: "integer" },
          owners: { type: "array", items: { type: "string" } },
          joined: { type: "boolean" },
          role: { type: ["string", "null"], enum: ["owner", "member", null] },
          can_add_pages: { type: "boolean" },
        },
        ["id", "name", "access", "joined", "can_add_pages"],
      ),
    },
  }),
  GroupList: loose({
    groups: {
      type: "array",
      items: loose(
        {
          id,
          name: { type: "string" },
          member_count: { type: "integer" },
          members: {
            type: "array",
            items: loose({ id, name: { type: "string" }, email: { type: "string" } }, ["id", "name", "email"]),
          },
          teamspaces: { type: "array", items: loose({ id, name: { type: "string" } }, ["id", "name"]) },
        },
        ["id", "name", "member_count", "members", "teamspaces"],
      ),
    },
  }),
  PageSummary: loose(
    {
      id,
      title: { type: "string" },
      kind: pageKind,
      icon: { type: ["string", "null"] },
      teamspace_id: teamspaceId,
      archived: { type: "boolean", description: "Archived (out of date but kept; not the trash), itself or through a page above it. Only with include_archived." },
      updated_at: { type: "string", format: "date-time" },
      url,
    },
    ["id", "title", "kind", "url"],
  ),
  PageList: loose({ pages: { type: "array", items: ref("PageSummary") }, ...cursorFields }, ["pages", "next_cursor", "has_more"]),
  SearchResults: loose(
    {
      results: {
        type: "array",
        items: loose({
          id,
          title: { type: "string" },
          kind: pageKind,
          workspace_id: id,
          teamspace_id: teamspaceId,
          parent_id: { type: ["string", "null"] },
          snippet: { type: "string" },
          match: { type: "string", enum: ["text", "semantic"], description: "semantic: found by meaning only (needs an embeddings model on the server)." },
          document: {
            type: ["object", "null"],
            description: "The PDF or Word document the page shows whose words matched, when the page's own text doesn't; the snippet is from it.",
            properties: { id, name: { type: "string" } },
          },
          archived: { type: "boolean", description: "Archived (out of date but kept; not the trash), itself or through a page above it. Only with include_archived." },
          updated_at: { type: "string", format: "date-time" },
          url,
        }),
      },
      ...cursorFields,
    },
    ["results", "next_cursor", "has_more"],
  ),
  Page: loose(
    {
      id,
      title: { type: "string" },
      kind: pageKind,
      icon: { type: ["string", "null"] },
      background: {
        type: ["string", "null"],
        description: 'What fills the page behind its title and body: "color:<name>", "pattern:<name>" or both separated by a space.',
      },
      workspace_id: id,
      ...teamspaceFields,
      parent_id: { type: ["string", "null"], description: "Null at the top level, or when the user can't see the parent." },
      path: { type: "string", description: "Workspace and ancestors, joined with /." },
      in_trash: { type: "boolean" },
      archived: {
        type: "boolean",
        description: "Archived: out of date but kept, out of the sidebar, search and pickers (not the trash). Set on the page itself or on a page above it (archived_with).",
      },
      archived_at: { type: "string", format: "date-time" },
      archived_by: { type: ["string", "null"], description: "Who archived it; null when their account is gone." },
      archived_with: {
        type: ["object", "null"],
        description: "The page above it it is archived with, when it isn't archived itself; null when the user can't open that page.",
        properties: { id, title: { type: "string" }, url },
      },
      locked: {
        type: "boolean",
        description:
          "Nobody can change the page's title, icon, background or body (for a database: its properties and views) until someone unlocks it in the app.",
      },
      favorite: { type: "boolean", description: "The user starred the page (Favorites in the sidebar)." },
      watching: {
        type: "boolean",
        description: "The user hears about others' edits and new comment threads (for a row: follows it). Left out for templates.",
      },
      updated_at: { type: "string", format: "date-time" },
      url,
      markdown: { type: "string", description: "The body (pages and rows; databases have none)." },
      version: {
        type: "string",
        description: "The body's version: pass it as expected_version when updating the page, so changes made since aren't overwritten.",
      },
      template: { type: "string", enum: ["page_template", "row_template", "inside_template"] },
      database_id: { type: "string", description: "For rows: their database." },
      properties: propertyValues,
      ...rowAccessFields,
      database_properties: { type: "array", items: { type: "object", additionalProperties: true }, description: "For databases." },
      embedded_databases: { type: "array", items: { type: "object", additionalProperties: true } },
      dashboards: {
        type: "array",
        items: { type: "object", additionalProperties: true },
        description: "The body's dashboards, each with its widgets (a database and the view it shows).",
      },
      child_pages: { type: "array", items: loose({ id, title: { type: "string" }, kind: pageKind }) },
      child_pages_truncated: { type: "integer", description: "How many sub-pages there are, when over 100." },
      linked_from: { type: "array", items: loose({ id, title: { type: "string" }, url }) },
    },
    ["id", "title", "kind", "workspace_id", "url"],
  ),
  PageCreated: loose(
    {
      id,
      title: { type: "string" },
      workspace_id: id,
      ...teamspaceFields,
      parent_id: { type: ["string", "null"] },
      from_template: { type: "string" },
      url,
      parts: {
        type: "array",
        items: loose({ id, title: { type: "string" }, kind: pageKind, url }),
        description: "From a built-in kit: every page and database it set up, in the sidebar's order.",
      },
    },
    ["id", "title", "workspace_id", "url"],
  ),
  DailyNote: loose(
    {
      date: { type: "string", format: "date" },
      id,
      title: { type: "string" },
      created: { type: "boolean", description: "Whether the note was made by this request." },
      workspace_id: id,
      url,
    },
    ["date", "id", "title", "created", "workspace_id", "url"],
  ),
  DailyNoteList: loose(
    { notes: { type: "array", items: loose({ date: { type: "string", format: "date" }, id, title: { type: "string" }, url }) } },
    ["notes"],
  ),
  VoiceNoteCreated: loose(
    {
      id,
      title: { type: "string", description: "The title AI gave the note, or the transcript's first words." },
      workspace_id: id,
      database_id: { type: ["string", "null"], description: "The database the note is a row of; null for a private page." },
      rewritten: { type: "boolean", description: "False when the note is the transcript as it was heard (no chat model, or the AI failed)." },
      transcript: { type: "string", description: "What was heard, also kept in a toggle under the note." },
      properties: { ...propertyValues, description: "The select and multi-select values AI picked for the row, by property name." },
      url,
    },
    ["id", "title", "workspace_id", "database_id", "rewritten", "transcript", "url"],
  ),
  PageChanged: loose(
    {
      id,
      changed: { type: "array", items: { type: "string" } },
      snapshot: { type: "string" },
      version: { type: "string", description: "The body's version after the change, for the next expected_version." },
      url,
    },
    ["id", "changed", "url"],
  ),
  PageWatch: loose({ id, watching: { type: "boolean" }, url }, ["id", "watching", "url"]),
  PageMoved: loose({ id, title: { type: "string" }, parent_id: { type: ["string", "null"] }, ...teamspaceFields, url }, ["id", "parent_id", "url"]),
  PageArchiveState: loose({ id, title: { type: "string" }, archived: { type: "boolean" }, url }, ["id", "archived", "url"]),
  PageTrashState: loose({ id, title: { type: "string" }, parent_id: { type: ["string", "null"] }, in_trash: { type: "boolean" }, url }, [
    "id",
    "in_trash",
  ]),
  Database: loose(
    {
      id,
      title: { type: "string" },
      workspace_id: id,
      in_trash: { type: "boolean" },
      row_count: { type: "integer" },
      properties: {
        type: "array",
        items: loose({
          name: { type: "string" },
          type: { type: "string" },
          id: { type: "string" },
          result_type: { type: "string", enum: ["number", "text", "checkbox", "date"], description: "Formulas only: what the formula gives." },
          number_format: loose(
            {
              format: { type: "string", enum: ["number", "percent", "currency"] },
              currency: { type: "string", description: "ISO 4217 code; only for the currency format." },
              decimals: { type: "integer", minimum: 0, maximum: 8 },
            },
            ["format"],
          ),
          access: {
            ...propertyLevel,
            description:
              "Only on restricted properties: what the user may do with it. view_property: its values are hidden; view: read-only; edit_values: values, not the property itself.",
          },
          access_per_row: { type: "boolean", description: "Rows naming the user in a person property may give them more than access." },
          access_settings: loose(
            {
              everyone: { type: "string", enum: [...(propertyLevel.enum as string[]), "inherit"] },
              exceptions: { type: "array", items: loose({ level: propertyLevel }) },
            },
            ["everyone", "exceptions"],
          ),
        }),
        description:
          "The first entry is the row title. number_format (how the app shows the values; they stay plain numbers here, a percentage as its fraction) is there for number properties and formulas giving a number that have one. access_settings (who may do what with a restricted property) is only there for users with full access to the database.",
      },
      views: { type: "array", items: loose({ id, name: { type: "string" }, type: { type: "string" } }) },
      voice_note_instructions: {
        type: "string",
        description: "How voice notes saved as rows are written up: what they cover and how they are laid out. Left out when the database has none.",
      },
      url,
    },
    ["id", "title", "properties", "views", "url"],
  ),
  Row: loose(
    {
      id,
      title: { type: "string" },
      database_id: id,
      properties: propertyValues,
      ...rowAccessFields,
      from_template: { type: "string" },
      action: upsertAction,
      url,
    },
    ["id", "title", "database_id", "properties", "url"],
  ),
  RowActivity: loose(
    {
      row_id: id,
      title: { type: "string" },
      total: { type: "integer", description: "Entries the user may see, over all pages." },
      entries: {
        type: "array",
        items: loose(
          {
            at: { type: "string", format: "date-time", description: "When it happened; for merged changes, the last of them." },
            by: { type: ["string", "null"], description: "Who did it; null for an anonymous form answer." },
            by_user_id: { type: ["string", "null"] },
            actor: {
              type: "string",
              enum: ["user", "agent", "automation", "ai", "form"],
              description:
                "Who acted: a person, an agent, an automation (acting as the person in by), an AI autofill value (worked out for the person in by) or an anonymous form answer.",
            },
            change: { type: "string", enum: ["created", "title", "property"] },
            property: { type: "string", description: "For property changes: the property's name." },
            property_id: id,
            from: { type: ["string", "null"], description: "The value before, as text (option and people names, dates as stored); null for nothing." },
            to: { type: ["string", "null"], description: "The value after." },
          },
          ["at", "by", "actor", "change"],
        ),
      },
      url,
      ...cursorFields,
    },
    ["row_id", "total", "entries", "next_cursor", "has_more"],
  ),
  QueryResult: loose(
    {
      database_id: id,
      title: { type: "string" },
      total: { type: "integer", description: "Rows matching the filters, over all pages." },
      returned: { type: "integer" },
      rows: {
        type: "array",
        items: loose({
          id,
          title: { type: "string" },
          properties: propertyValues,
          ...rowAccessFields,
          archived: { type: "boolean", description: "The row is archived on its own; only with include_archived or a view that shows archived rows." },
          url,
        }),
      },
      chart: { type: "object", additionalProperties: true, description: "For a chart view: its settings and the series it plots." },
      ...cursorFields,
    },
    ["database_id", "total", "returned", "rows", "next_cursor", "has_more"],
  ),
  RowsCreated: loose(
    {
      database_id: id,
      created: { type: "integer", description: "Rows added." },
      updated: { type: "integer", description: "With match_by: existing rows updated instead." },
      rows: { type: "array", items: loose({ id, title: { type: "string" }, action: upsertAction, url }), description: "In the order given." },
      url,
    },
    ["database_id", "created", "rows"],
  ),
  RowsUpdated: loose(
    {
      database_id: id,
      updated: { type: "integer", description: "Rows changed (not with dry_run)." },
      dry_run: { type: "boolean" },
      would_update: { type: "integer", description: "With dry_run: how many rows the call would change." },
      row_ids: { type: "array", items: id, description: "With dry_run: the rows the call would change." },
      skipped_row_ids: { type: "array", items: id },
      url,
    },
    ["database_id"],
  ),
  CommentThreads: loose(
    {
      page_id: id,
      title: { type: "string" },
      threads: {
        type: "array",
        items: loose({
          id,
          quote: { type: ["string", "null"] },
          resolved: { type: "boolean" },
          comments: {
            type: "array",
            items: loose({
              id,
              author: { type: "string" },
              author_id: id,
              created_at: { type: "string" },
              edited_at: { type: "string" },
              text: { type: "string" },
              reactions: { type: "array", items: loose({ emoji: { type: "string" }, count: { type: "integer" } }) },
            }),
          },
        }),
      },
      url,
    },
    ["page_id", "threads"],
  ),
  CommentCreated: loose({ thread_id: id, comment_id: id, url }, ["thread_id", "comment_id"]),
  AgentSummary: loose(
    {
      id,
      name: { type: "string" },
      icon: { type: ["string", "null"] },
      description: { type: "string" },
      enabled: { type: "boolean", description: "Paused agents don't run." },
      archived: { type: "boolean" },
      model: {
        type: "string",
        enum: ["main", "fast"],
        description: "Which of the server's models its runs use: its main model, or its cheaper fast one (the main model where the server has none, or on an own AI account).",
      },
      user_id: { type: "string", description: "The agent's own user: what its changes and comments show." },
    },
    ["id", "name", "enabled", "archived", "model", "user_id"],
  ),
  AgentList: loose({ workspace_id: id, agents: { type: "array", items: ref("AgentSummary") } }, ["workspace_id", "agents"]),
  AgentUsageMonth: loose(
    {
      month: { type: "string", description: "The calendar month (UTC), YYYY-MM." },
      runs: { type: "integer" },
      input_tokens: { type: "integer" },
      output_tokens: { type: "integer" },
      cost_usd: { type: "number", description: "0 where the AI provider names no price." },
    },
    ["month", "runs", "input_tokens", "output_tokens", "cost_usd"],
  ),
  Agent: {
    allOf: [
      ref("AgentSummary"),
      loose(
        {
          workspace_id: id,
          instructions: { type: "string" },
          monthly_token_limit: { type: ["integer", "null"], description: "The most tokens its runs may use in a calendar month (UTC); null: no limit." },
          usage_this_month: ref("AgentUsageMonth"),
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
        ["workspace_id", "instructions", "monthly_token_limit", "usage_this_month"],
      ),
    ],
  },
  AgentRun: loose(
    {
      id,
      status: { type: "string", enum: ["pending", "running", "awaiting_approval", "done", "failed"] },
      code: {
        type: "string",
        description: "Why it failed: aiOff, agentDisabled, noAccess, rowGone, databaseGone, provider, timeout, tooManyAttempts, approvalTimeout, connectionGone, limitReached or error.",
      },
      error: { type: "string" },
      source: loose(
        {
          kind: { type: "string", enum: ["automation", "connection", "request", "schedule"] },
          requested_by: loose({ id, name: { type: "string" } }),
          via: { type: "string", enum: ["api", "mcp"] },
          task: { type: "string", description: "The task asked for, or the schedule's (empty where the run's row or database is hidden from the user)." },
          schedule_id: { type: ["string", "null"], description: "The schedule that started it; null once the schedule was deleted." },
          scheduled_by: loose({ id, name: { type: "string" } }),
          database: loose({ id, title: { type: ["string", "null"], description: "null where the user can't open the database." }, url }),
        },
        ["kind"],
      ),
      row: loose({ id, title: { type: ["string", "null"], description: "null where the user can't open the row." }, url }),
      steps: { type: "array", items: loose({ kind: { type: "string" }, summary: { type: "string" } }) },
      answer: { type: "string", description: "What the agent said at the end." },
      usage: loose({
        rounds: { type: "integer" },
        input_tokens: { type: "integer" },
        output_tokens: { type: "integer" },
        cost_usd: { type: "number" },
        model: { type: "string", description: "The model that answered its latest turn." },
      }),
      created_at: { type: "string", format: "date-time" },
      finished_at: { type: ["string", "null"], format: "date-time" },
    },
    ["id", "status", "source", "steps", "answer", "created_at", "finished_at"],
  ),
  AgentRunList: loose({ agent_id: id, runs: { type: "array", items: ref("AgentRun") } }, ["agent_id", "runs"]),
  AgentSchedule: loose(
    {
      schedule_id: id,
      repeat: loose(
        {
          frequency: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
          interval: { type: "integer" },
          weekdays: { type: "array", items: { type: "integer" }, description: "Weekly only: 0 for Sunday to 6 for Saturday." },
          time: { type: "string", description: "HH:MM, in time_zone." },
          start: { type: "string", format: "date" },
        },
        ["frequency", "interval", "time", "start"],
      ),
      time_zone: { type: "string" },
      task: { type: "string", description: "Empty where the user can't open the database." },
      database: {
        oneOf: [
          { type: "null" },
          loose(
            {
              id,
              title: { type: ["string", "null"], description: "null where the user can't open the database." },
              url,
              agent_access: { type: "string", enum: ["none", "view", "comment", "edit"], description: "What the agent may do with it: edit to change rows." },
            },
            ["id", "agent_access"],
          ),
        ],
      },
      enabled: { type: "boolean", description: "false while paused; `note` says why." },
      next_run_at: { type: ["string", "null"], format: "date-time" },
      last_run_at: { type: ["string", "null"], format: "date-time" },
      set_by: loose({ id, name: { type: "string" } }),
      note: { type: "string", description: "What stands in its way, if anything." },
    },
    ["schedule_id", "repeat", "time_zone", "task", "database", "enabled", "next_run_at"],
  ),
  AgentScheduleList: loose({ agent_id: id, schedules: { type: "array", items: ref("AgentSchedule") } }, ["agent_id", "schedules"]),
  AgentScheduleDeleted: loose({ agent_id: id, deleted: { type: "string", description: "The deleted schedule's id." } }, ["agent_id", "deleted"]),
  AgentUsage: loose(
    {
      agent_id: id,
      monthly_token_limit: { type: ["integer", "null"] },
      months: { type: "array", items: ref("AgentUsageMonth") },
    },
    ["agent_id", "monthly_token_limit", "months"],
  ),
};

const ERROR_RESPONSES: Record<string, { description: string }> = {
  "400": { description: "Invalid input (validation_error, invalid_json, invalid_request, invalid_property_value, invalid_cursor)." },
  "401": { description: "No token, or an invalid or expired one (unauthorized, invalid_token, token_expired)." },
  "403": {
    description:
      "The token lacks the scope (insufficient_scope), or the user may not do this, or the workspace lets API tokens only read (forbidden).",
  },
  "404": { description: "Not found, or the user (or the token's workspace) may not access it." },
  "409": {
    description:
      "It can't be done now: the agent can't run (agent_unavailable, limit_reached, too_many_runs), or voice notes or AI aren't available (voice_notes_unavailable, ai_unavailable).",
  },
  "413": { description: "The request body is too large (payload_too_large)." },
  "415": { description: "The body or its file is of a kind the endpoint doesn't take (unsupported_media_type)." },
  "429": { description: "Rate limited; wait for Retry-After seconds." },
  "502": { description: "The speech to text or AI provider failed or took too long (upstream_error)." },
};

/** A zod schema as JSON Schema (draft 2020-12, as OpenAPI 3.1 uses), for what clients send. */
function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: "input" }) as JsonSchema;
  return rest;
}

function parametersOf(route: ApiRoute) {
  const params: JsonSchema[] = [...route.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    description: `The ${name.replace(/_id$/, "").replace(/_/g, " ")} id.`,
  }));
  if (route.query) {
    const schema = jsonSchemaOf(route.query) as { properties?: Record<string, JsonSchema>; required?: string[] };
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const { description, ...rest } = property;
      params.push({
        name,
        in: "query",
        required: schema.required?.includes(name) ?? false,
        schema: rest,
        ...(description ? { description } : {}),
      });
    }
  }
  return params;
}

/** A route's body: JSON, or multipart form data with its files as binary fields. */
function requestBodyOf(route: ApiRoute) {
  if (route.form) {
    const fields = (route.body ? jsonSchemaOf(route.body) : { type: "object", properties: {} }) as {
      properties?: Record<string, JsonSchema>;
      required?: string[];
    };
    const files = Object.entries(route.form.files);
    const required = [...(fields.required ?? []), ...files.filter(([, file]) => file.required).map(([name]) => name)];
    const schema = {
      ...fields,
      properties: {
        ...Object.fromEntries(files.map(([name, file]) => [name, { type: "string", format: "binary", description: file.description }])),
        ...fields.properties,
      },
      ...(required.length ? { required } : {}),
    };
    return { requestBody: { required: true, content: { "multipart/form-data": { schema } } } };
  }
  if (!route.body) return {};
  return { requestBody: { required: true, content: { "application/json": { schema: jsonSchemaOf(route.body) } } } };
}

/** The OpenAPI 3.1 description of the REST API, built from its route table. */
export function buildOpenApiDocument(routes: ApiRoute[], { appUrl, version }: { appUrl: string; version: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const status = String(route.status ?? 200);
    const errors = [
      "400",
      "401",
      "403",
      "404",
      ...(route.conflict ? ["409"] : []),
      ...(route.body || route.form ? ["413"] : []),
      ...(route.form ? ["415"] : []),
      "429",
      ...(route.form ? ["502"] : []),
    ];
    const parameters = parametersOf(route);
    (paths[route.path] ??= {})[route.method.toLowerCase()] = {
      operationId: route.operationId,
      tags: [route.tag],
      summary: route.summary,
      ...(route.description ? { description: `${route.description}\n\nScope: \`${route.scope}\`.` } : {}),
      security: [{ bearerAuth: [route.scope] }],
      ...(parameters.length ? { parameters } : {}),
      ...requestBodyOf(route),
      responses: {
        [status]: {
          description: status === "201" ? "Created" : "OK",
          content: { "application/json": { schema: ref(route.response) } },
        },
        ...Object.fromEntries(errors.map((code) => [code, { $ref: `#/components/responses/E${code}` }])),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Leafdesk REST API",
      version,
      description: DESCRIPTION,
      license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
    },
    servers: [{ url: `${appUrl}${API_PREFIX}` }],
    tags: TAGS,
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "esi_ personal access token",
          description: `Personal access token from Settings → Connected apps. Scopes: ${API_TOKEN_SCOPES.join(", ")}.`,
        },
      },
      schemas: SCHEMAS,
      responses: Object.fromEntries(
        Object.entries(ERROR_RESPONSES).map(([code, { description }]) => [
          `E${code}`,
          { description, content: { "application/json": { schema: ref("Error") } } },
        ]),
      ),
    },
  };
}
