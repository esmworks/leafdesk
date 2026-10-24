/**
 * What a personal access token for the REST API (/api/v1) may do: read, and for some kinds of
 * things write, one resource at a time. Every endpoint names the one scope it needs (see
 * server/api/routes.ts); a write scope always brings the read scope of the same resource.
 *
 * Tokens made before scopes were per resource hold `pages:read` and `pages:write`, which then
 * meant "read everything" and "read and write everything". They are marked as such
 * (`api_token.legacy_scopes`) and keep exactly that access, whatever scopes are added later, until
 * someone changes what the token may do: then it gets the scopes chosen, like a new token.
 *
 * Some scopes are for workspace owners only (OWNER_SCOPES: the audit log). Only an owner can give
 * one to a token, and only to a token of a workspace they own (server/api/tokens.ts); no preset
 * and no legacy token includes one, so it is always chosen on its own.
 *
 * Only the REST API's tokens: the MCP server's OAuth scopes are their own (lib/auth-options.ts).
 */

/**
 * The resources, in the order settings and the docs list them, whether they have a write scope,
 * and whether only workspace owners may give a token their scopes.
 */
export const API_SCOPE_RESOURCES = [
  { resource: "workspaces", write: false },
  { resource: "pages", write: true },
  { resource: "search", write: false },
  { resource: "databases", write: false },
  { resource: "rows", write: true },
  { resource: "comments", write: true },
  { resource: "agents", write: true },
  { resource: "webhooks", write: true },
  { resource: "audit", write: false, owners: true },
] as const;

export type ApiScopeResource = (typeof API_SCOPE_RESOURCES)[number]["resource"];

/** The scopes anyone may give a token. */
export const API_TOKEN_SCOPES = [
  "workspaces:read",
  "pages:read",
  "pages:write",
  "search:read",
  "databases:read",
  "rows:read",
  "rows:write",
  "comments:read",
  "comments:write",
  "agents:read",
  "agents:write",
  "webhooks:read",
  "webhooks:write",
] as const;

/** The scopes only a workspace's owners may give a token, for that workspace. */
export const OWNER_SCOPES = ["audit:read"] as const;

/** Every scope, in the catalog's order. */
export const ALL_API_SCOPES = [...API_TOKEN_SCOPES, ...OWNER_SCOPES] as const;

export type ApiTokenScope = (typeof ALL_API_SCOPES)[number];

export const isOwnerScope = (scope: string) => (OWNER_SCOPES as readonly string[]).includes(scope);

/** What each scope lets a token do, for the OpenAPI document and the docs page. */
export const API_SCOPE_DESCRIPTIONS: Record<ApiTokenScope, string> = {
  "workspaces:read": "List the user's workspaces, their teamspaces and groups.",
  "pages:read": "Read pages (database rows too, as pages), sub-pages, the page tree and daily notes.",
  "pages:write": "Create, change, move, trash, restore, archive and watch pages; open daily notes; make voice notes.",
  "search:read": "Search pages and rows.",
  "databases:read": "Read a database's properties and views.",
  "rows:read": "Query a database's rows; read a row's values and its activity.",
  "rows:write": "Add, change and upsert rows, one or many; also needed for a voice note that goes into a database.",
  "comments:read": "Read comment threads.",
  "comments:write": "Start comment threads and reply in them.",
  "agents:read": "Read agents, their runs, usage, schedules and sharing.",
  "agents:write": "Change agents, ask them for runs, set their schedules and share them.",
  "webhooks:read": "Read a workspace's page webhooks and their deliveries (workspace owners).",
  "webhooks:write": "Add, change, test and remove page webhooks and replace their secrets (workspace owners).",
  "audit:read": "Read a workspace's audit log. Only an owner can give it, to a token of a workspace they own.",
};

export const READ_SCOPES: readonly ApiTokenScope[] = API_TOKEN_SCOPES.filter((s) => s.endsWith(":read"));

export const isApiTokenScope = (value: unknown): value is ApiTokenScope =>
  typeof value === "string" && (ALL_API_SCOPES as readonly string[]).includes(value);

export const isWriteScope = (scope: string) => scope.endsWith(":write");

/** Whether scopes let a token change anything (a legacy token's stored ones too). */
export const scopesWrite = (scopes: readonly string[]) => scopes.some(isWriteScope);

export const readScopeOf = (resource: ApiScopeResource) => `${resource}:read` as ApiTokenScope;

export const writeScopeOf = (resource: ApiScopeResource): ApiTokenScope | null => {
  const scope = `${resource}:write`;
  return isApiTokenScope(scope) ? scope : null;
};

/** Scopes as stored: known ones only, in the catalog's order, and each write scope brings its read. */
export function normalizeScopes(scopes: readonly string[]): ApiTokenScope[] {
  const known = new Set(scopes.filter(isApiTokenScope));
  for (const scope of [...known]) {
    if (isWriteScope(scope)) known.add(scope.replace(/:write$/, ":read") as ApiTokenScope);
  }
  return ALL_API_SCOPES.filter((s) => known.has(s));
}

/**
 * What a token may do: its scopes, or for a token from before per-resource scopes what its
 * `pages:read` (every read scope) and `pages:write` (every scope) stood for.
 */
export function effectiveScopes(stored: readonly string[], legacy: boolean): ApiTokenScope[] {
  if (!legacy) return normalizeScopes(stored);
  if (stored.includes("pages:write")) return [...API_TOKEN_SCOPES];
  if (stored.includes("pages:read")) return [...READ_SCOPES];
  return [];
}

/** The two choices settings offers in one click. */
export const SCOPE_PRESETS = { readAll: READ_SCOPES, all: API_TOKEN_SCOPES } as const;

/** Texts under apiTokens.scopes, for summarizeScopes. */
export type ScopeTexts = (key: string, values?: Record<string, string>) => string;

/** What scopes come to, in a few words: a preset's name, or each resource with its access. */
export function summarizeScopes(scopes: readonly ApiTokenScope[], t: ScopeTexts) {
  const preset = presetOf(scopes);
  if (preset) return t(`presets.${preset}`);
  const set = new Set(scopes);
  return API_SCOPE_RESOURCES.flatMap(({ resource }) => {
    const write = writeScopeOf(resource);
    const name = t(`resources.${resource}.name`);
    if (write && set.has(write)) return [t("summary.readWrite", { resource: name })];
    if (set.has(readScopeOf(resource))) return [t("summary.read", { resource: name })];
    return [];
  }).join(", ");
}

/** The preset scopes amount to, if any. */
export function presetOf(scopes: readonly string[]): keyof typeof SCOPE_PRESETS | null {
  const set = new Set<string>(normalizeScopes(scopes));
  const equals = (list: readonly string[]) => list.length === set.size && list.every((s) => set.has(s));
  if (equals(SCOPE_PRESETS.all)) return "all";
  if (equals(SCOPE_PRESETS.readAll)) return "readAll";
  return null;
}
