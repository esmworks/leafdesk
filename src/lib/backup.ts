/**
 * Workspace backups (see server/backup): a ZIP holding a whole workspace, its rows table by table,
 * that another Leafdesk restores as it was. Pure helpers only (no database, no storage), so the
 * writer, the reader and tests share them.
 *
 * The archive:
 * - `manifest.json` first: the format and its version, the last migration of the Leafdesk that made
 *   it, the workspace, the people its rows name, how many rows each table holds and the bytes of
 *   its files. A restore reads it before anything else.
 * - `tables/<table>/<n>.jsonl` next: one row per line, keyed by column name (as in SQL), in the
 *   order a restore inserts them. Dates are ISO strings, binary columns base64.
 * - `files/<id>` last: the uploaded files' bytes, by file id.
 *
 * Every id except people's is kept: pages, properties, views, options and files keep theirs, so
 * the links between them, in columns, JSON and page bodies alike, need no rewriting. People are
 * matched by email on the restoring server and their ids rewritten (`idRewriter`).
 */

export const BACKUP_FORMAT = "leafdesk-workspace-backup";
export const BACKUP_VERSION = 1;
export const MANIFEST_PATH = "manifest.json";

/** A table's rows go into entries of about this many bytes (a few MB each), numbered from 1. */
export const TABLE_ENTRY_BYTES = 8 * 1024 * 1024;

export const tableEntryPath = (table: string, part: number) => `tables/${table}/${String(part).padStart(4, "0")}.jsonl`;
export const fileEntryPath = (fileId: string) => `files/${fileId}`;

/** What an archive entry is, from its path; null for anything a backup never holds. */
export function entryKind(path: string): { kind: "manifest" } | { kind: "table"; table: string } | { kind: "file"; id: string } | null {
  if (path === MANIFEST_PATH) return { kind: "manifest" };
  const table = /^tables\/([a-z_]+)\/\d{4}\.jsonl$/.exec(path);
  if (table) return { kind: "table", table: table[1] };
  const file = /^files\/([A-Za-z0-9_-]{24})$/.exec(path);
  if (file) return { kind: "file", id: file[1] };
  return null;
}

/** Someone the backup's rows name: its members, former members who made something, its agents. */
export type BackupPerson = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  /** An agent's user (server/agents): restored as it was, never matched to a person. */
  agent: boolean;
};

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** The last migration of the Leafdesk that made it (drizzle/meta/_journal.json). */
  schema: string;
  /** That Leafdesk's version (package.json). */
  app: string;
  createdAt: string;
  workspace: { id: string; name: string };
  people: BackupPerson[];
  tables: { name: string; rows: number }[];
  files: { count: number; bytes: number };
  /** The model semantic search's vectors came from; null without semantic search. */
  embeddings: { model: string; dimensions: number | null } | null;
};

/** The manifest, checked for its shape; null when the text isn't one. */
export function parseManifest(text: string): BackupManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value) || value.format !== BACKUP_FORMAT || typeof value.version !== "number") return null;
  const m = value as Record<string, unknown>;
  const workspace = m.workspace;
  const files = m.files;
  if (typeof m.schema !== "string" || typeof m.app !== "string" || typeof m.createdAt !== "string") return null;
  if (!isObject(workspace) || typeof workspace.id !== "string" || typeof workspace.name !== "string") return null;
  if (!isObject(files) || !isCount(files.count) || !isCount(files.bytes)) return null;
  if (!Array.isArray(m.tables) || !m.tables.every((t) => isObject(t) && typeof t.name === "string" && isCount(t.rows))) return null;
  if (!Array.isArray(m.people) || !m.people.every(isPerson)) return null;
  const embeddings = m.embeddings;
  if (embeddings !== null && !(isObject(embeddings) && typeof embeddings.model === "string" && (embeddings.dimensions === null || isCount(embeddings.dimensions)))) {
    return null;
  }
  return value as BackupManifest;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isPerson = (value: unknown): value is BackupPerson =>
  isObject(value) &&
  typeof value.id === "string" &&
  value.id.length > 0 &&
  typeof value.email === "string" &&
  typeof value.name === "string" &&
  typeof value.emailVerified === "boolean" &&
  typeof value.agent === "boolean";

// ---------------------------------------------------------------------------------------------
// Column values

/** What a restore needs to know of a column to turn its JSON back into a value. */
export type ColumnKind = "timestamp" | "bytes" | "other";

/** A column's value as JSON: dates as ISO strings, bytes as base64, the rest as they are. */
export function encodeValue(kind: ColumnKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (kind === "timestamp") return value instanceof Date ? value.toISOString() : value;
  if (kind === "bytes") return Buffer.from(value as Uint8Array).toString("base64");
  return value;
}

/** The value `encodeValue` made JSON of; throws on what can't be one. */
export function decodeValue(kind: ColumnKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (kind === "timestamp") {
    const date = typeof value === "string" ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) throw new Error("not a date");
    return date;
  }
  if (kind === "bytes") {
    if (typeof value !== "string") throw new Error("not base64");
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// People's ids

/**
 * A function that rewrites every id `map` holds wherever it appears in a string, or null when the
 * map changes nothing. People's ids are long and random (32 characters from Better Auth), so one
 * never turns up by chance inside other text; a filter's "me" stays as it is.
 */
export function idRewriter(map: ReadonlyMap<string, string>): ((text: string) => string) | null {
  const changed = [...map].filter(([from, to]) => from !== to && from.length >= 16);
  if (!changed.length) return null;
  const targets = new Map(changed);
  const pattern = new RegExp(changed.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (text) => (text.length < 16 ? text : text.replace(pattern, (found) => targets.get(found) ?? found));
}

/** `value` with `rewrite` applied to every string in it, keys of objects included. */
export function rewriteDeep(value: unknown, rewrite: (text: string) => string): unknown {
  if (typeof value === "string") return rewrite(value);
  if (Array.isArray(value)) return value.map((item) => rewriteDeep(item, rewrite));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [rewrite(key), rewriteDeep(item, rewrite)]));
  }
  return value;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** What restoring a backup (server/backup/restore) made, and what to set up again. */
export type RestoreResult = {
  workspaceId: string;
  name: string;
  pages: number;
  files: number;
  /** People the backup names who have no account here (with the address they had), to invite. */
  withoutAccount: { name: string; email: string }[];
  /** The site's address is taken on this server: the site was left out, to set up again. */
  siteLeftOut: boolean;
  /** Connections to sign in to again: their secrets stayed with the old server. */
  connectionsToReconnect: number;
  /** Semantic search's vectors came from another model: the pages are indexed again. */
  searchIndexDropped: boolean;
  /**
   * "SSO only" fell back to any method: single sign-on is set up again here, and the server has no
   * provider of its own to send members to meanwhile.
   */
  ssoOnlyTurnedOff: boolean;
};
