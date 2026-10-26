import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import postgres from "postgres";
import { env } from "@/lib/env";
import {
  kindOf,
  MAX_POSTGRES_ROWS,
  parsePostgresUrl,
  POSTGRES_STATEMENT_TIMEOUT,
  type PostgresConnection,
  type PostgresErrorCode,
  type PostgresKind,
} from "@/lib/postgres-sync";
import { JiraError } from "@/server/jira-sync/client";
import { isBlockedAddress } from "@/server/ssrf";

/**
 * Leafdesk's reads of a PostgreSQL database for synced tables (lib/postgres-sync). The server is
 * reached like a connection's: on a public address only, connected to the address checked (so a
 * host can't answer the check with a public address and the connection with a private one), unless
 * the host is in CONNECTOR_ALLOWED_HOSTS (by name, or name and port), for databases on the same
 * machine or network. TLS is required on public addresses unless the address's sslmode says
 * otherwise. Every read is one read-only transaction with a time limit, and the connection closes
 * after it. An error is a JiraError (the runs record every source alike) with a code; it carries
 * the server's own words only for a refused query.
 */

type Sql = ReturnType<typeof postgres>;

export class PostgresSyncError extends JiraError {
  constructor(code: PostgresErrorCode, message: string = code, detail: string | null = null) {
    super(code, message, detail);
  }
}

function allowedHost(connection: PostgresConnection) {
  const host = connection.host.toLowerCase();
  return env.connectorAllowedHosts.includes(host) || env.connectorAllowedHosts.includes(`${host}:${connection.port}`);
}

/** The address to connect to: the host itself when allowed, else a public address it resolves to. */
async function addressOf(connection: PostgresConnection): Promise<string> {
  const { host } = connection;
  if (allowedHost(connection)) return host;
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new PostgresSyncError("invalidSite", "A private address");
    return host;
  }
  if (!host.includes(".") || /^localhost\.?$/i.test(host) || /\.(localhost|local|internal|home\.arpa)\.?$/i.test(host)) {
    throw new PostgresSyncError("invalidSite", "A local host name");
  }
  let found: { address: string }[];
  try {
    found = await lookup(host, { all: true });
  } catch {
    throw new PostgresSyncError("unreachable", `No address for ${host}`);
  }
  if (!found.length) throw new PostgresSyncError("unreachable", `No address for ${host}`);
  if (found.some((a) => isBlockedAddress(a.address))) throw new PostgresSyncError("invalidSite", `${host} has a private address`);
  return found[0].address;
}

/** The server's refusals and failures as a sync's codes. */
function syncError(error: unknown): JiraError {
  if (error instanceof JiraError) return error;
  const { code, message } = error as { code?: string; message?: string };
  if (code === "28P01" || code === "28000") return new PostgresSyncError("unauthorized", "The server refused the user or password");
  if (code === "42501") return new PostgresSyncError("forbidden", "The user may not read the table");
  if (code === "3D000" || code === "42P01" || code === "3F000") return new PostgresSyncError("notFound", "No such database or table");
  if (code === "42703") return new PostgresSyncError("badQuery", "A column is gone", message ?? null);
  if (code === "57014") return new PostgresSyncError("unreachable", "The query took too long");
  if (code && ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED"].includes(code)) {
    return new PostgresSyncError("unreachable", "The server could not be reached");
  }
  // Other errors the server sends (five-character SQLSTATE codes) refuse the query.
  if (code && /^[0-9A-Z]{5}$/.test(code)) return new PostgresSyncError("badQuery", "The server refused the query", message?.slice(0, 300) ?? null);
  return new PostgresSyncError("failed", "The read failed");
}

/** Connects with the address a sync keeps (user and password in it), runs `fn` and disconnects. */
export async function withPostgres<T>(url: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const connection = parsePostgresUrl(url);
  if (!connection) throw new PostgresSyncError("invalidInput", "Not a PostgreSQL address");
  const host = await addressOf(connection);
  const mode = connection.sslmode ?? (allowedHost(connection) ? "prefer" : "require");
  const servername = isIP(connection.host) ? undefined : connection.host;
  const sql = postgres({
    host,
    port: connection.port,
    database: connection.database,
    username: connection.user,
    password: connection.password,
    ssl: mode === "disable" ? false : mode === "prefer" ? "prefer" : { rejectUnauthorized: mode === "verify-full", servername },
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: false,
    onnotice: () => {},
    connection: { application_name: "Leafdesk sync" },
  });
  try {
    return await fn(sql);
  } catch (error) {
    throw syncError(error);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** A table's columns in their order, the kind each becomes (null when not read), and its one-column primary key. */
export async function describeTable(sql: Sql, schema: string, table: string) {
  const columns = await sql<{ column_name: string; data_type: string }[]>`
    select column_name, data_type from information_schema.columns
    where table_schema = ${schema} and table_name = ${table}
    order by ordinal_position
  `;
  if (!columns.length) throw new PostgresSyncError("notFound", "No such table");
  const keys = await sql<{ name: string }[]>`
    select a.attname as name
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = to_regclass(format('%I.%I', ${schema}::text, ${table}::text)) and i.indisprimary
  `;
  return {
    columns: columns.map((c) => ({ name: c.column_name, kind: kindOf(c.data_type) as PostgresKind | null })),
    primaryKey: keys.length === 1 ? keys[0].name : null,
  };
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * The table's rows (row_to_json's form: numbers, booleans, ISO times in UTC, JSON as itself), only
 * `columns`, ordered by `key`, in a read-only transaction with a time limit. More than
 * MAX_POSTGRES_ROWS stops the read.
 */
export async function readTable(sql: Sql, schema: string, table: string, key: string, columns: string[]) {
  const names = [...new Set([key, ...columns])];
  const rows = await sql.begin("read only", async (tx) => {
    await tx.unsafe(`set local statement_timeout = ${POSTGRES_STATEMENT_TIMEOUT}`);
    await tx.unsafe("set local time zone 'UTC'");
    // Identifiers are quoted here (lib/postgres-sync refuses names with quotes); nothing else is put in.
    return tx.unsafe<{ row: string }[]>(
      `select row_to_json(t)::text as row from (select ${names.map(quote).join(", ")} from ${quote(schema)}.${quote(table)} order by ${quote(key)} limit ${MAX_POSTGRES_ROWS + 1}) t`,
    );
  });
  if (rows.length > MAX_POSTGRES_ROWS) throw new PostgresSyncError("tooManyIssues", "The table has too many rows");
  return rows.map((r) => JSON.parse(r.row) as Record<string, unknown>);
}
