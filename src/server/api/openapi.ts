import * as z from "zod";
import { API_SCOPE_DESCRIPTIONS, API_TOKEN_SCOPES } from "@/lib/api-scopes";
import { API_ERROR_CODES } from "./errors";
import { API_PREFIX, DEFAULT_RATE_LIMIT, MAX_BODY_BYTES, takesIdempotencyKey } from "./handler";
import { IDEMPOTENCY_HEADER, MAX_IDEMPOTENCY_KEY, REPLAYED_HEADER } from "./idempotency";
import type { ApiRoute } from "./routes";

type JsonSchema = Record<string, unknown>;

const TAGS = [
  { name: "Account", description: "The token and the user it acts for." },
  { name: "Workspaces", description: "Workspaces, their teamspaces and their page tree." },
  { name: "Pages", description: "Pages: read and write the body as Markdown, move, trash and restore, search." },
  { name: "Databases", description: "Database schemas and row queries." },
  { name: "Rows", description: "Database rows and their property values." },
  { name: "Comments", description: "Comment threads on pages." },
  { name: "Agents", description: "A workspace's agents: their settings, who they are shared with, runs asked for now, schedules, run history and monthly usage." },
  { name: "Review", description: "Changes agents proposed instead of making them: rows to add or change and email drafts, each approved (optionally edited) or dismissed by a person." },
  { name: "Follow-ups", description: "Follow-up sequences of mail databases, and the rows they go on: emails sent one after another from a member's mailbox until the contact replies." },
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

**Authentication.** Create a personal access token in Settings → Connected apps and send it as \`Authorization: Bearer esi_…\`. Tokens may be limited to one workspace and may expire. Tokens look like \`esi_\` followed by 40 letters and digits, so secret scanners can spot leaked ones; revoke a leaked token in Settings. Tokens act outside a workspace's "require two-step verification" policy, like connected MCP apps.

**Scopes.** A token may read, and for some resources write, each kind of thing on its own: ${API_TOKEN_SCOPES.map((s) => `\`${s}\``).join(", ")}. A write scope brings the read scope of its resource. Each endpoint names the one scope it needs (\`GET /me\` takes any token); without it the answer is \`403 insufficient_scope\` with the scope in \`details.scope\`. What a token may do can be changed in Settings without changing its secret. Tokens made before scopes were per resource keep the access they had: their \`pages:read\` reads everything and their \`pages:write\` reads and writes everything (\`GET /me\` shows \`legacy_scopes: true\` and lists the scopes they stand for).

**Errors** are JSON: \`{"error": {"code": "not_found", "message": "…"}}\`. Invalid input adds \`details\` (what is wrong with each field) and \`param\`, the field it is about where it is known (\`title\`, \`properties.Status\`, \`rows.2.properties.Status\`). A page, database or row that doesn't exist and one the user may not see both answer \`404 not_found\`.

**Idempotency.** Endpoints that change something take an \`${IDEMPOTENCY_HEADER}\` header (up to ${MAX_IDEMPOTENCY_KEY} characters; a random UUID per change is a good key). Sending the same request again with the same key, within 24 hours, answers what the first one answered, with \`${REPLAYED_HEADER}: true\`, and changes nothing more. A key belongs to its token and endpoint and remembers the request's path, query and body: the same key with another request answers \`422 idempotency_key_reused\`, and while the first request is still running \`409 idempotency_conflict\`. Server failures (5xx) and 429s are not remembered, so a retry runs again. \`POST /databases/{database_id}/query\` changes nothing and ignores the header.

**Pagination.** Lists return \`next_cursor\` and \`has_more\`; pass \`cursor=<next_cursor>\` (a body field for the query endpoint) to read on.

**Rate limits.** Each token may make ${DEFAULT_RATE_LIMIT} requests a minute unless the server sets another limit. Every answer to a request with a valid token says where it stands: \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\` and \`X-RateLimit-Reset\` (when one more request is allowed again, in Unix seconds); \`429 rate_limited\` comes with \`Retry-After\` (seconds). JSON request bodies can be at most ${MAX_BODY_BYTES / 1024 / 1024} MB; endpoints that take files (multipart form data) say their own limit.

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
          param: {
            type: "string",
            description: "The request field the error is about, where it is known: `title`, `properties.Status`, `rows.2.properties.Status`.",
          },
          details: {
            description:
              "For invalid input, what is wrong with each field; for `insufficient_scope`, `{scope}`; for `version_conflict`, the versions.",
            oneOf: [{ type: "array", items: loose({ path: { type: "string" }, message: { type: "string" } }) }, loose({})],
          },
        },
      },
    },
  },
  Me: loose({
    user: loose({ id, name: { type: "string" }, email: { type: "string" } }),
    token: loose({
      id,
      scopes: {
        type: "array",
        items: { type: "string", enum: [...API_TOKEN_SCOPES] },
        description: "What the token may do; for a legacy token, what its pages:read or pages:write stands for.",
      },
      legacy_scopes: { type: "boolean", description: "Made before scopes were per resource." },
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
          description: {
            type: "string",
            description: "What the property holds and how to fill it, as whoever set the database up wrote it. Left out when it has none.",
          },
          depends_on: {
            type: "string",
            description:
              "Select and multi-select properties depending on another select property: its name. A row may hold only the options that go with its value of that property (see option_parents); values that no longer fit are cleared when it changes.",
          },
          option_parents: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
            description: "With depends_on: per option name, the options of that property it goes with. Options left out go with any value.",
          },
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
            change: {
              type: "string",
              enum: ["created", "title", "property", "merged"],
              description: "merged: other rows were merged into this one (listed in merged_rows).",
            },
            property: { type: "string", description: "For property changes: the property's name." },
            property_id: id,
            from: { type: ["string", "null"], description: "The value before, as text (option and people names, dates as stored); null for nothing." },
            to: { type: ["string", "null"], description: "The value after." },
            merged_rows: {
              type: "array",
              items: loose({ id, title: { type: "string" } }, ["id", "title"]),
              description: "merged entries: the rows merged into this one, by their titles then.",
            },
            merged_from: {
              ...loose({ id, title: { type: "string" } }, ["id", "title"]),
              description: "An entry that came with a row merged into this one: that row, by its title then.",
            },
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
  RowsMerged: loose(
    {
      kept_row_id: id,
      merged_row_ids: { type: "array", items: id, description: "The rows merged into the kept one, now in the trash (not with dry_run)." },
      would_merge_row_ids: { type: "array", items: id, description: "With dry_run: the rows the call would merge." },
      dry_run: { type: "boolean" },
      title: { type: "string", description: "The kept row's title after the merge." },
      relinked_rows: { type: "integer", description: "Other rows whose links point at the kept row instead." },
      moved: loose({
        comment_threads: { type: "integer" },
        bodies: { type: "integer", description: "Merged rows whose page content was added to the kept row's." },
        activity: { type: "integer" },
        files: { type: "integer" },
        emails: { type: "integer" },
      }),
      url,
    },
    ["kept_row_id", "title", "relinked_rows", "moved"],
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
          marked: { type: "boolean", description: "The asking user marked the thread to come back to later." },
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
      web_access: { type: "boolean", description: "Whether its runs may read public web pages (and search the web, where the server has a search service)." },
      row_changes: {
        type: "string",
        enum: ["direct", "review"],
        description: "How its runs change database rows: directly, or by proposing each change for a person to approve first (the pending changes endpoints).",
      },
      user_id: { type: "string", description: "The agent's own user: what its changes and comments show." },
      helper_agent_ids: {
        type: "array",
        items: { type: "string" },
        description: "The other agents of the workspace it can hand part of a task to during a run (its \"Agents it can ask\").",
      },
      your_access: {
        type: "string",
        enum: ["full", "edit", "interact"],
        description:
          "The token's user's access to the agent: full (everything, sharing and archiving it too; workspace owners always), edit (change and run it), interact (see it, chat with it and mention it).",
      },
    },
    ["id", "name", "enabled", "archived", "model", "web_access", "row_changes", "user_id", "your_access"],
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
        description: "Why it failed: aiOff, agentDisabled, noAccess, rowGone, databaseGone, commentGone, provider, timeout, tooManyAttempts, approvalTimeout, connectionGone, limitReached or error.",
      },
      error: { type: "string" },
      source: loose(
        {
          kind: { type: "string", enum: ["automation", "connection", "request", "schedule", "mention", "handoff"] },
          requested_by: loose({ id, name: { type: "string" } }),
          via: { type: "string", enum: ["api", "mcp"] },
          task: {
            type: "string",
            description: "The task asked for, the schedule's, or the comment that mentioned the agent (empty where the run's row, database or page is hidden from the user).",
          },
          schedule_id: { type: ["string", "null"], description: "The schedule that started it; null once the schedule was deleted." },
          scheduled_by: loose({ id, name: { type: "string" } }),
          asked_by: { ...loose({ agent_id: id, name: { type: "string" }, run_id: id }), description: "For a run another agent asked for (`handoff`): that agent and its run." },
          database: loose({ id, title: { type: ["string", "null"], description: "null where the user can't open the database." }, url }),
          mentioned_by: loose({ id, name: { type: "string" } }),
          thread_id: { type: "string", description: "The comment thread the agent answers in." },
          page: loose({ id, title: { type: ["string", "null"], description: "null where the user can't open the page." }, url }),
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
  AgentSharing: loose(
    {
      agent_id: id,
      your_access: { type: "string", enum: ["full", "edit", "interact"] },
      shared_with: {
        type: "array",
        description: "Each entry names `everyone: true`, a person (`user_id`, `name`, `email`) or a group (`group_id`, `name`, `member_count`), with its `level`.",
        items: loose(
          {
            everyone: { type: "boolean" },
            user_id: { type: "string" },
            group_id: { type: "string" },
            name: { type: "string" },
            email: { type: "string" },
            member_count: { type: "integer" },
            level: { type: "string", enum: ["full", "edit", "interact"] },
          },
          ["level"],
        ),
      },
      note: { type: "string" },
    },
    ["agent_id", "your_access", "shared_with"],
  ),
  AgentUsage: loose(
    {
      agent_id: id,
      monthly_token_limit: { type: ["integer", "null"] },
      months: { type: "array", items: ref("AgentUsageMonth") },
    },
    ["agent_id", "monthly_token_limit", "months"],
  ),
  PendingChange: loose(
    {
      id,
      kind: { type: "string", enum: ["create_row", "update_row", "email_draft", "automation_approval"], description: "automation_approval: an automation's run waits for the people it asks; approving lets it go on, dismissing stops it." },
      status: { type: "string", enum: ["pending", "approved", "dismissed", "expired", "failed"], description: "failed: approved, but it couldn't be made (`error` says why); approve it again or dismiss it." },
      error: { type: "string" },
      reason: { type: "string", description: "Why the agent proposed it." },
      database: loose({ id, title: { type: "string" }, url }, ["id"]),
      row: { oneOf: [{ type: "null" }, loose({ id, title: { type: "string" }, url }, ["id"])], description: "null for a row still to be added." },
      agent: { oneOf: [{ type: "null" }, loose({ id, name: { type: "string" } }, ["id"])] },
      run_id: { type: "string", description: "The agent's run that proposed it." },
      run_url: url,
      changes: {
        type: "array",
        description: "A row change's values: what each was when proposed (`from`), is now (`now`) and would become (`to`), as text.",
        items: loose(
          {
            property: { type: "string", description: "The property's name, or `title`." },
            property_id: id,
            from: { type: "string" },
            now: { type: "string" },
            to: { type: "string" },
            conflict: { type: "boolean", description: "The value changed since it was proposed." },
          },
          ["property", "to"],
        ),
      },
      markdown: { type: "string", description: "A new row's page text." },
      email: loose({
        from: { type: "string", description: "The person it goes out from." },
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        text: { type: "string" },
        in_reply: { type: "boolean", description: "It answers the row's latest email." },
      }),
      approval: loose({
        automation: { oneOf: [{ type: "null" }, loose({ id, name: { type: "string" } }, ["id"])] },
        run_id: { type: ["string", "null"] },
        version: { type: "integer", description: "The automation's version the run is pinned to." },
        message: { type: "string" },
        approvers: { type: "array", items: { type: "string" }, description: "The people who may answer it; only they can." },
        next_steps: { type: "array", items: { type: "string" }, description: "What the steps after it do, in order." },
        on_timeout: { type: "string", enum: ["stop", "continue"] },
      }),
      edited: { type: "boolean", description: "A reviewer changed it from what the agent proposed." },
      conflict: { type: "boolean", description: "The row changed since in a value it sets: approving needs `force`." },
      can_approve: { type: "boolean", description: "Whether the token's user may approve or dismiss it." },
      created_at: { type: "string", format: "date-time" },
      expires_at: { type: "string", format: "date-time" },
      decided_at: { type: "string", format: "date-time" },
      decided_by: { type: ["string", "null"] },
      url,
    },
    ["id", "kind", "status", "reason", "database", "row", "edited", "conflict", "can_approve", "created_at", "expires_at"],
  ),
  PendingChangeList: loose({ workspace_id: id, changes: { type: "array", items: ref("PendingChange") } }, ["workspace_id", "changes"]),
  Sequence: loose(
    {
      id,
      name: { type: "string" },
      database_id: id,
      steps: {
        type: "array",
        items: loose(
          {
            step: { type: "integer" },
            wait_days: { type: "integer", description: "Days after the previous email (the first: after it starts)." },
            mode: { type: "string", enum: ["send", "ask_first"], description: "ask_first: the email waits in the sender's For review queue." },
            subject: { type: "string" },
            text: { type: "string", description: "With {{Property | fallback}} variables." },
          },
          ["step", "wait_days", "mode", "text"],
        ),
      },
      send_window: loose({ days: { type: "array", items: { type: "integer" }, description: "0 is Sunday." }, start_minute: { type: "integer" }, end_minute: { type: "integer" } }),
      open_enrollments: { type: "integer" },
      updated_at: { type: "string", format: "date-time" },
      url,
    },
    ["id", "name", "database_id", "steps", "send_window"],
  ),
  SequenceList: loose({ database_id: id, sequences: { type: "array", items: ref("Sequence") } }, ["database_id", "sequences"]),
  Enrollment: loose(
    {
      id,
      sequence: loose({ id, name: { type: "string" } }, ["id", "name"]),
      row: loose({ id, title: { type: "string" }, url }, ["id"]),
      sender: loose({ id, name: { type: "string" } }, ["id"]),
      status: { type: "string", enum: ["active", "waiting", "paused", "finished", "stopped"], description: "waiting: its next email is in the sender's For review queue." },
      step: { type: "integer", description: "1-based: the next to go out (or waiting for review; for a finished one, the last)." },
      steps: { type: "integer" },
      sent: { type: "integer" },
      next_at: { type: "string", format: "date-time", description: "When the next email goes out at the earliest; the send window and the daily limit may hold it later." },
      paused_until: { type: "string", format: "date-time" },
      reason: {
        type: "string",
        enum: ["outOfOffice", "checkFailed", "replied", "manual", "rowTrashed", "mailboxDisconnected", "noAccess", "emailOff", "dismissed", "draftExpired", "noAddress"],
      },
      problems: { type: "array", items: { type: "string" }, description: "checkFailed: what the check found in the next email." },
      pending_change_id: id,
      source: { type: "string", enum: ["row", "bulk", "automation", "mcp", "api"] },
      started_at: { type: "string", format: "date-time" },
      ended_at: { type: "string", format: "date-time" },
      can_stop: { type: "boolean" },
      can_resume: { type: "boolean" },
    },
    ["id", "sequence", "row", "sender", "status", "step", "steps", "sent", "source", "started_at", "can_stop", "can_resume"],
  ),
  EnrollmentList: loose({ enrollments: { type: "array", items: ref("Enrollment") } }, ["enrollments"]),
  EnrollmentOutcomes: loose(
    {
      started: { type: "integer" },
      rows: {
        type: "array",
        items: loose({ row_id: id, enrollment: ref("Enrollment"), skipped: { type: "string", description: "Why the row was skipped (a code)." }, reason: { type: "string" } }, ["row_id"]),
      },
    },
    ["started", "rows"],
  ),
};

const ERROR_RESPONSES: Record<string, { description: string }> = {
  "400": { description: "Invalid input (validation_error, invalid_json, invalid_request, invalid_property_value, invalid_cursor)." },
  "401": { description: "No token, or an invalid or expired one (unauthorized, invalid_token, token_expired)." },
  "403": {
    description:
      "The token lacks the scope (insufficient_scope, naming it in details.scope), or the user may not do this, or the workspace lets API tokens only read (forbidden).",
  },
  "404": { description: "Not found, or the user (or the token's workspace) may not access it." },
  "409": {
    description:
      "It can't be done now: a request with the same Idempotency-Key is still running (idempotency_conflict), the page changed (version_conflict), the agent can't run (agent_unavailable, limit_reached, too_many_runs), a change waiting for review was already answered or its row changed since (change_decided, change_conflict), or voice notes or AI aren't available (voice_notes_unavailable, ai_unavailable).",
  },
  "413": { description: "The request body is too large (payload_too_large)." },
  "415": { description: "The body or its file is of a kind the endpoint doesn't take (unsupported_media_type)." },
  "422": { description: "The Idempotency-Key was used for a different request (idempotency_key_reused)." },
  "429": { description: "Rate limited; wait for Retry-After seconds." },
  "502": { description: "The speech to text or AI provider failed or took too long (upstream_error)." },
};

/** Headers of every answer to a request with a valid token (while the server limits requests). */
const RATE_LIMIT_HEADERS = {
  "X-RateLimit-Limit": { $ref: "#/components/headers/X-RateLimit-Limit" },
  "X-RateLimit-Remaining": { $ref: "#/components/headers/X-RateLimit-Remaining" },
  "X-RateLimit-Reset": { $ref: "#/components/headers/X-RateLimit-Reset" },
};

const HEADERS: Record<string, JsonSchema> = {
  "X-RateLimit-Limit": { description: "Requests the token may make a minute.", schema: { type: "integer" } },
  "X-RateLimit-Remaining": { description: "Requests it may still make in the current minute.", schema: { type: "integer" } },
  "X-RateLimit-Reset": { description: "When it may make one more request again, in Unix seconds.", schema: { type: "integer" } },
  "Retry-After": { description: "Seconds to wait before trying again.", schema: { type: "integer" } },
  [REPLAYED_HEADER]: {
    description: `"true" when the answer is the one kept for an earlier request with the same ${IDEMPOTENCY_HEADER}.`,
    schema: { type: "string", enum: ["true"] },
  },
};

const idempotencyKeyParameter = {
  name: IDEMPOTENCY_HEADER,
  in: "header",
  required: false,
  schema: { type: "string", minLength: 1, maxLength: MAX_IDEMPOTENCY_KEY },
  description: `Send the same key again with the same request to get the first answer back instead of doing it twice (kept 24 hours). A random UUID per change is a good key.`,
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
    const idempotent = takesIdempotencyKey(route);
    const errors = [
      "400",
      "401",
      "403",
      "404",
      ...(route.conflict || idempotent ? ["409"] : []),
      ...(route.body || route.form ? ["413"] : []),
      ...(route.form ? ["415"] : []),
      ...(idempotent ? ["422"] : []),
      "429",
      ...(route.form ? ["502"] : []),
    ];
    const parameters = [...parametersOf(route), ...(idempotent ? [idempotencyKeyParameter] : [])];
    const scope = route.scope ? `Scope: \`${route.scope}\`.` : "Any token may call it.";
    (paths[route.path] ??= {})[route.method.toLowerCase()] = {
      operationId: route.operationId,
      tags: [route.tag],
      summary: route.summary,
      description: route.description ? `${route.description}\n\n${scope}` : scope,
      security: [{ bearerAuth: route.scope ? [route.scope] : [] }],
      ...(route.scope ? { "x-scope": route.scope } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...requestBodyOf(route),
      responses: {
        [status]: {
          description: status === "201" ? "Created" : "OK",
          headers: { ...RATE_LIMIT_HEADERS, ...(idempotent ? { [REPLAYED_HEADER]: { $ref: `#/components/headers/${REPLAYED_HEADER}` } } : {}) },
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
          "x-scopes": API_SCOPE_DESCRIPTIONS,
        },
      },
      schemas: SCHEMAS,
      headers: HEADERS,
      responses: Object.fromEntries(
        Object.entries(ERROR_RESPONSES).map(([code, { description }]) => [
          `E${code}`,
          {
            description,
            // Answers before the token is known (401) can't say where it stands.
            ...(code === "401"
              ? {}
              : { headers: { ...RATE_LIMIT_HEADERS, ...(code === "429" || code === "409" ? { "Retry-After": { $ref: "#/components/headers/Retry-After" } } : {}) } }),
            content: { "application/json": { schema: ref("Error") } },
          },
        ]),
      ),
    },
  };
}
