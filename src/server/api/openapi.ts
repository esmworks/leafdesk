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

**Rate limits.** Each token may make ${DEFAULT_RATE_LIMIT} requests a minute unless the server sets another limit; \`X-RateLimit-Limit\` and \`X-RateLimit-Remaining\` show where you stand, and \`429 rate_limited\` comes with \`Retry-After\`. Request bodies can be at most ${MAX_BODY_BYTES / 1024 / 1024} MB.

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
const teamspaceId = { type: ["string", "null"], description: "The page's teamspace; null for a private page." };
const teamspaceFields = {
  teamspace_id: teamspaceId,
  teamspace: { type: ["string", "null"], description: '"Private" for a private page.' },
};
const propertyValues = {
  type: "object",
  additionalProperties: true,
  description:
    "Values by property name: text, numbers, booleans, option names, dates (YYYY-MM-DD), relations as [{id, title}], people as [{id, name}], checklists as [{text, checked}], files as [{name, url}].",
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
      items: loose({ id, name: { type: "string" }, role: { type: "string", enum: ["owner", "member", "guest"] } }, ["id", "name", "role"]),
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
      workspace_id: id,
      ...teamspaceFields,
      parent_id: { type: ["string", "null"], description: "Null at the top level, or when the user can't see the parent." },
      path: { type: "string", description: "Workspace and ancestors, joined with /." },
      in_trash: { type: "boolean" },
      favorite: { type: "boolean", description: "The user starred the page (Favorites in the sidebar)." },
      updated_at: { type: "string", format: "date-time" },
      url,
      markdown: { type: "string", description: "The body (pages and rows; databases have none)." },
      template: { type: "string", enum: ["page_template", "row_template", "inside_template"] },
      database_id: { type: "string", description: "For rows: their database." },
      properties: propertyValues,
      ...rowAccessFields,
      database_properties: { type: "array", items: { type: "object", additionalProperties: true }, description: "For databases." },
      embedded_databases: { type: "array", items: { type: "object", additionalProperties: true } },
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
    },
    ["id", "title", "workspace_id", "url"],
  ),
  PageChanged: loose({ id, changed: { type: "array", items: { type: "string" } }, snapshot: { type: "string" }, url }, ["id", "changed", "url"]),
  PageMoved: loose({ id, title: { type: "string" }, parent_id: { type: ["string", "null"] }, ...teamspaceFields, url }, ["id", "parent_id", "url"]),
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
          "The first entry is the row title. access_settings (who may do what with a restricted property) is only there for users with full access to the database.",
      },
      views: { type: "array", items: loose({ id, name: { type: "string" }, type: { type: "string" } }) },
      url,
    },
    ["id", "title", "properties", "views", "url"],
  ),
  Row: loose({ id, title: { type: "string" }, database_id: id, properties: propertyValues, ...rowAccessFields, from_template: { type: "string" }, url }, [
    "id",
    "title",
    "database_id",
    "properties",
    "url",
  ]),
  QueryResult: loose(
    {
      database_id: id,
      title: { type: "string" },
      total: { type: "integer", description: "Rows matching the filters, over all pages." },
      returned: { type: "integer" },
      rows: { type: "array", items: loose({ id, title: { type: "string" }, properties: propertyValues, ...rowAccessFields, url }) },
      chart: { type: "object", additionalProperties: true, description: "For a chart view: its settings and the series it plots." },
      ...cursorFields,
    },
    ["database_id", "total", "returned", "rows", "next_cursor", "has_more"],
  ),
  RowsCreated: loose(
    { database_id: id, created: { type: "integer" }, rows: { type: "array", items: loose({ id, title: { type: "string" }, url }) }, url },
    ["database_id", "created", "rows"],
  ),
  RowsUpdated: loose({ database_id: id, updated: { type: "integer" }, skipped_row_ids: { type: "array", items: id }, url }, [
    "database_id",
    "updated",
  ]),
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
};

const ERROR_RESPONSES: Record<string, { description: string }> = {
  "400": { description: "Invalid input (validation_error, invalid_json, invalid_request, invalid_property_value, invalid_cursor)." },
  "401": { description: "No token, or an invalid or expired one (unauthorized, invalid_token, token_expired)." },
  "403": {
    description:
      "The token lacks the scope (insufficient_scope), or the user may not do this, or the workspace lets API tokens only read (forbidden).",
  },
  "404": { description: "Not found, or the user (or the token's workspace) may not access it." },
  "413": { description: "The request body is too large (payload_too_large)." },
  "429": { description: "Rate limited; wait for Retry-After seconds." },
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

/** The OpenAPI 3.1 description of the REST API, built from its route table. */
export function buildOpenApiDocument(routes: ApiRoute[], { appUrl, version }: { appUrl: string; version: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const status = String(route.status ?? 200);
    const errors = ["400", "401", "403", "404", "429", ...(route.body ? ["413"] : [])];
    const parameters = parametersOf(route);
    (paths[route.path] ??= {})[route.method.toLowerCase()] = {
      operationId: route.operationId,
      tags: [route.tag],
      summary: route.summary,
      ...(route.description ? { description: `${route.description}\n\nScope: \`${route.scope}\`.` } : {}),
      security: [{ bearerAuth: [route.scope] }],
      ...(parameters.length ? { parameters } : {}),
      ...(route.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchemaOf(route.body) } } } } : {}),
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
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
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
