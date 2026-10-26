import type { JiraSyncError } from "./jira-sync";
import type { PropertyType } from "./property-types";

/**
 * Keeping a database in step with a table of a PostgreSQL database outside Leafdesk, one way
 * (server/postgres-sync for setting it up and reading, server/jira-sync/run for the runs every
 * synced database shares): each row of the table is a row, found again by its key column. Pure,
 * shared by the server, the import dialog and the sync's dialog on the database.
 *
 * A run reads the table in a read-only transaction, at most MAX_POSTGRES_ROWS rows ordered by the
 * key: the title column becomes the row's title, the key column a text property, and the other
 * columns the properties the sync made from their types (PostgresMapping), written over on each
 * run. Rows that leave the table stay as they are.
 */

/** Rows a run takes at most: a table with more stops the run (sync a view of the part you need). */
export const MAX_POSTGRES_ROWS = 5000;
/** Columns a sync makes properties of at most, in the table's order. */
export const MAX_POSTGRES_COLUMNS = 50;
/** The most text a value keeps. */
export const MAX_POSTGRES_TEXT = 10_000;
/** How long a run's query may take, in ms. */
export const POSTGRES_STATEMENT_TIMEOUT = 30_000;

/** What a sync reads: one table (or view) and the columns that find and name its rows. */
export type PostgresQuery = { schema: string; table: string; keyColumn: string; titleColumn: string };

/** How a column's values are written: the kind of property it became. */
export const POSTGRES_KINDS = ["text", "number", "checkbox", "date", "time", "json"] as const;
export type PostgresKind = (typeof POSTGRES_KINDS)[number];

/** The properties a sync writes: the key, and one per column, by what each holds (their ids in the database). */
export type PostgresMapping = {
  key: string;
  columns: { column: string; property: string; kind: PostgresKind }[];
};

/** The type a column's property has, by its kind. */
export const KIND_TYPES: Record<PostgresKind, PropertyType> = {
  text: "text",
  number: "number",
  checkbox: "checkbox",
  date: "date",
  time: "date",
  json: "text",
};

/**
 * Why a run didn't happen, in the codes every synced database uses (`lastError` is one column):
 * "unauthorized" (the server refused the user or password), "forbidden" (the user may not read
 * the table), "notFound" (no such database, table or column), "badQuery" (the server refused the
 * query; lastErrorDetail says why), "tooManyIssues" (the table has more than MAX_POSTGRES_ROWS
 * rows), "unreachable" and "failed" (passing), and "runAsGone", "accessLost", "keyGone" as for Jira.
 */
export type PostgresSyncError = JiraSyncError;
export type PostgresErrorCode = PostgresSyncError | "invalidSite" | "invalidInput" | "alreadyRunning";

/** A sync as its dialog on the database shows it: where it reads, never the password. */
export type PostgresSyncView = {
  host: string;
  database: string;
  table: string;
  keyColumn: string;
  titleColumn: string;
  intervalMinutes: number;
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastCount: number | null;
  lastError: PostgresSyncError | null;
  lastErrorDetail: string | null;
  canManage: boolean;
};

/** How a sync reaches the server, from its connection address. */
export type PostgresConnection = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** libpq's sslmode: "disable", "prefer", "require" or "verify-full"; null when the address says none. */
  sslmode: "disable" | "prefer" | "require" | "verify-full" | null;
};

const SSL_MODES = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"];

/** A connection address (postgres://user:password@host:5432/database?sslmode=require) read, or null. */
export function parsePostgresUrl(value: unknown): PostgresConnection | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
  const host = decodeURIComponent(url.hostname).replace(/^\[|\]$/g, "");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  if (!host || !database || !user || database.includes("/")) return null;
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const mode = url.searchParams.get("sslmode");
  if (mode !== null && !SSL_MODES.includes(mode)) return null;
  const sslmode = mode === null ? null : mode === "allow" ? "prefer" : mode === "verify-ca" ? "verify-full" : (mode as PostgresConnection["sslmode"]);
  return { host, port, database, user, password: decodeURIComponent(url.password), sslmode };
}

/** Where a connection reads, without its user or password ("postgres://db.example.test:5432/shop"). */
export function postgresSite(connection: PostgresConnection): string {
  const host = connection.host.includes(":") ? `[${connection.host}]` : connection.host;
  return `postgres://${host}:${connection.port}/${encodeURIComponent(connection.database)}`;
}

const IDENTIFIER = /^[^\u0000"]{1,63}$/;

/** A table named "table" or "schema.table" (public when no schema is given), or null. */
export function parseTableName(value: unknown): { schema: string; table: string } | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(".");
  if (parts.length > 2) return null;
  const [schema, table] = parts.length === 2 ? parts : ["public", parts[0]];
  return IDENTIFIER.test(schema) && IDENTIFIER.test(table) ? { schema, table } : null;
}

/** A column name as typed, or null. */
export function columnName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return IDENTIFIER.test(name) ? name : null;
}

/** The kind of property a column's type becomes (information_schema's data_type); null for types it doesn't read. */
export function kindOf(dataType: string): PostgresKind | null {
  const type = dataType.toLowerCase();
  if (["smallint", "integer", "bigint", "numeric", "decimal", "real", "double precision", "money"].includes(type)) return "number";
  if (type === "boolean") return "checkbox";
  if (type === "date") return "date";
  if (type.startsWith("timestamp")) return "time";
  if (type === "json" || type === "jsonb" || type === "array") return "json";
  if (["text", "character varying", "character", "uuid", "citext", "name", "inet", "cidr", "macaddr", "interval", "time without time zone", "time with time zone", "user-defined"].includes(type)) {
    return "text";
  }
  return null;
}

/** A column's value as its property takes it (row_to_json's form); null when empty or not readable. */
export function columnValue(kind: PostgresKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case "number": {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[^0-9eE.+-]/g, "")) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return value === true;
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
    case "time": {
      if (typeof value !== "string") return null;
      // A timestamp without a zone is taken as UTC.
      const at = new Date(/[zZ]|[+-]\d{2}(:?\d{2})?$/.test(value) ? value : `${value}Z`);
      return Number.isNaN(at.getTime()) ? null : at.toISOString();
    }
    case "json": {
      const flat = Array.isArray(value) && value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
      const text = flat ? (value as unknown[]).filter((v) => v !== null).join(", ") : JSON.stringify(value);
      return text ? text.slice(0, MAX_POSTGRES_TEXT) : null;
    }
    default: {
      const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
      return text.trim() ? text.slice(0, MAX_POSTGRES_TEXT) : null;
    }
  }
}

/** A table row as text: what finds it again (its key) and its title. */
export function keyText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A row's values for the properties the sync writes, as normalizeRowProperties takes them. */
export function postgresValues(row: Record<string, unknown>, query: PostgresQuery, mapping: Partial<PostgresMapping>) {
  const values: Record<string, unknown> = {};
  if (mapping.key) values[mapping.key] = keyText(row[query.keyColumn]);
  for (const { column, property, kind } of mapping.columns ?? []) values[property] = columnValue(kind, row[column]);
  return values;
}
