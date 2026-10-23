/**
 * Which tables a workspace backup holds (server/backup), which rows of each, and in what order a
 * restore inserts them. Columns, keys and foreign keys come from the Drizzle schema, so a new column
 * is backed up without a change here; a new table must be put in BACKED_UP or LEFT_OUT (a test
 * checks that each one is).
 */
import { getTableColumns, getTableName, is, sql, type SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import type { ColumnKind } from "@/lib/backup";

type Scope = (workspaceId: string) => SQL;

const own: Scope = (ws) => sql`workspace_id = ${ws}`;
const pages = (ws: string) => sql`(select id from page where workspace_id = ${ws})`;
const ofPages =
  (column: string): Scope =>
  (ws) =>
    sql`${sql.identifier(column)} in ${pages(ws)}`;
const ofTeamspaces: Scope = (ws) => sql`teamspace_id in (select id from teamspace where workspace_id = ${ws})`;
const ofAgents: Scope = (ws) => sql`agent_id in (select id from workspace_agent where workspace_id = ${ws})`;
const ofConnections: Scope = (ws) => sql`connection_id in (select id from connection where workspace_id = ${ws})`;
/** Agents' notes: what the AI remembers about a person is theirs alone, like their chats. */
const agentsNotes: Scope = (ws) => sql`workspace_id = ${ws} and user_id in (select user_id from workspace_agent where workspace_id = ${ws})`;
const ofFiles: Scope = (ws) => sql`file_id in (select id from file where workspace_id = ${ws})`;

/** The tables a backup holds, by SQL name, with the rows of the workspace in each. */
export const BACKED_UP: Record<string, Scope> = {
  workspace: (ws) => sql`id = ${ws}`,
  workspace_member: own,
  teamspace: own,
  teamspace_member: ofTeamspaces,
  teamspace_watch: ofTeamspaces,
  member_group: own,
  member_group_member: own,
  teamspace_group: own,
  page: own,
  database_property: ofPages("database_id"),
  database_view: ofPages("database_id"),
  page_snapshot: ofPages("page_id"),
  row_activity: own,
  page_permission: own,
  database_row_access: own,
  page_group_permission: ofPages("page_id"),
  property_permission: own,
  page_favorite: ofPages("page_id"),
  meeting_note: ofPages("page_id"),
  page_watch: ofPages("page_id"),
  thread_mute: ofPages("page_id"),
  thread_state: ofPages("page_id"),
  row_follower: ofPages("row_id"),
  row_reminder: ofPages("row_id"),
  page_publication: ofPages("page_id"),
  form_publication: (ws) => sql`view_id in (select id from database_view where database_id in ${pages(ws)})`,
  workspace_site: own,
  file: own,
  file_reference: ofFiles,
  file_text: ofFiles,
  page_link: ofPages("source_id"),
  synced_block_reference: ofPages("page_id"),
  page_mention: ofPages("page_id"),
  page_reminder: ofPages("page_id"),
  ai_property_state: ofPages("row_id"),
  page_chunk: own,
  page_index_state: own,
  ai_usage: own,
  ai_memory: agentsNotes,
  workspace_agent: own,
  agent_usage: ofAgents,
  agent_database_share: ofAgents,
  agent_skill: ofAgents,
  agent_version: ofAgents,
  agent_helper: ofAgents,
  agent_share: own,
  database_automation: own,
  automation_fire: (ws) => sql`automation_id in (select id from database_automation where workspace_id = ${ws})`,
  automation_version: (ws) => sql`automation_id in (select id from database_automation where workspace_id = ${ws})`,
  schedule: own,
  connection: own,
  agent_grant: ofConnections,
  connection_trigger: ofConnections,
  journal: own,
  daily_note: own,
  mail_database: own,
  row_email: own,
  row_email_attachment: (ws) => sql`row_email_id in (select id from row_email where workspace_id = ${ws})`,
  email_sequence: own,
  // The workspace's own snippets; people's personal ones have no workspace and stay out.
  snippet: own,
  pdf_letterhead: own,
};

/** Tables older backups held and later ones leave out: a restore passes over them. */
export const NO_LONGER_BACKED_UP = new Set(["ai_conversation"]);

/** The table of a workspace's members and their roles. */
export const WORKSPACE_MEMBERS = "workspace_member";
/**
 * Tables that make someone a member of something, or name them on an agent's sharing list (a
 * restore leaves out who has no account).
 */
export const MEMBERSHIP_TABLES = [WORKSPACE_MEMBERS, "teamspace_member", "member_group_member", "agent_share"];

/** The tables a backup leaves out, and why. */
export const LEFT_OUT: Record<string, string> = {
  user: "accounts belong to the server; the people a backup names are in its manifest",
  session: "signed-in sessions",
  account: "passwords and provider accounts",
  verification: "sign-in and email verification codes",
  two_factor: "two-step verification secrets",
  passkey: "passkeys",
  jwks: "the server's signing keys",
  oauth_client: "apps registered on the server",
  oauth_resource: "the server's OAuth setup",
  oauth_client_resource: "the server's OAuth setup",
  oauth_refresh_token: "app tokens",
  oauth_access_token: "app tokens",
  oauth_consent: "people's consent to apps on the server",
  oauth_client_assertion: "the server's OAuth setup",
  sso_provider: "single sign-on secrets, set up again on the new server",
  workspace_sso: "single sign-on, set up again on the new server",
  scim_token: "SCIM tokens",
  scim_identity: "the identity provider provisions people again",
  scim_group: "the identity provider provisions groups again",
  api_token: "API tokens",
  api_idempotency_key: "answers kept for API retries, which belong to the old server's tokens",
  calendar_feed: "calendar feed links (secret tokens)",
  telegram_link: "Telegram accounts linked to people, linked again on the new server",
  telegram_link_code: "Telegram link codes in progress",
  connected_app_use: "when apps reached the workspace on the old server",
  push_subscription: "browsers subscribed to push on the old server",
  user_preference: "people's own settings on the old server",
  workspace_invitation: "pending invitations (their links)",
  workspace_join_request: "pending requests to join",
  page_invitation: "pending page invitations (their links)",
  access_request: "pending access requests",
  notification: "inboxes",
  audit_event: "the old server's audit log; a backup file can be edited, so it would prove nothing",
  agent_run: "agent runs, kept a few weeks only",
  pending_change: "changes agents proposed for review, kept a few weeks only; the runs that proposed them aren't backed up",
  automation_run: "automation runs; pending ones would run again",
  connection_event: "events received from connected services",
  connection_oauth: "connection sign-ins in progress",
  storage_deletion: "the old server's queue of files to delete",
  assignment_email: "emails waiting to go out",
  row_update_pending: "emails waiting to go out",
  page_update_pending: "emails waiting to go out",
  page_update_email: "emails waiting to go out",
  mailbox: "members' mailboxes and their passwords, connected again on the new server",
  sequence_enrollment: "follow-ups under way, which would send from mailboxes the new server hasn't connected",
  sequence_send: "the steps follow-ups sent, kept with their enrollments",
  workspace_storage: "the workspace's place in its owners' own file storage, connected again on the new server",
  storage_account: "people's own file storage and its keys, connected again on the new server",
  storage_oauth: "storage sign-ins in progress",
  storage_move: "moves of files between storages on the old server",
  ai_conversation: "people's AI chats, which only each of them may read",
  agent_conversation: "people's chats with agents, which only each of them may read (their answers are agent runs, not backed up either)",
  ai_account: "people's own AI provider keys; the workspace uses the new server's AI until an owner attaches one again",
  ai_usage_person: "AI usage by person, which names people of the old server; the workspace's own totals (ai_usage) are backed up",
};

export type BackupColumn = {
  /** The SQL name, as backups key their rows. */
  name: string;
  /** The Drizzle property name, for inserts. */
  key: string;
  kind: ColumnKind;
  notNull: boolean;
  hasDefault: boolean;
};

export type BackupForeignKey = { columns: string[]; table: string; foreignColumns: string[] };

export type BackupTable = {
  name: string;
  table: PgTable;
  scope: Scope;
  /** Without generated columns (search vectors), which Postgres fills in. */
  columns: BackupColumn[];
  primaryKey: string[];
  foreignKeys: BackupForeignKey[];
};

/** Every table of the schema, by SQL name. */
export function schemaTables(): Map<string, PgTable> {
  const tables = new Map<string, PgTable>();
  for (const value of Object.values(schema)) if (is(value, PgTable)) tables.set(getTableName(value), value);
  return tables;
}

function describe(name: string, table: PgTable, scope: Scope): BackupTable {
  const config = getTableConfig(table);
  const columns = Object.entries(getTableColumns(table))
    .filter(([, column]) => !column.generated)
    .map(([key, column]) => ({
      name: column.name,
      key,
      kind: (column.columnType === "PgTimestamp" ? "timestamp" : column.getSQLType() === "bytea" ? "bytes" : "other") as ColumnKind,
      notNull: column.notNull,
      hasDefault: column.hasDefault,
    }));
  const primaryKey = [
    ...Object.values(getTableColumns(table))
      .filter((column) => column.primary)
      .map((column) => column.name),
    ...config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
  ];
  const foreignKeys = config.foreignKeys.map((key) => {
    const reference = key.reference();
    return {
      columns: reference.columns.map((column) => column.name),
      table: getTableName(reference.foreignTable),
      foreignColumns: reference.foreignColumns.map((column) => column.name),
    };
  });
  return { name, table, scope, columns, primaryKey, foreignKeys };
}

let cached: BackupTable[] | null = null;

/**
 * The backed-up tables in the order a restore inserts them: each after the tables its foreign keys
 * point at (a table's keys to itself, like a page's parent, are ordered row by row instead).
 */
export function backupTables(): BackupTable[] {
  if (cached) return cached;
  const all = schemaTables();
  const described = new Map(Object.entries(BACKED_UP).map(([name, scope]) => [name, describe(name, all.get(name)!, scope)]));
  const order: BackupTable[] = [];
  const placed = new Set<string>();
  while (order.length < described.size) {
    const ready = [...described.values()]
      .filter((t) => !placed.has(t.name))
      .filter((t) => t.foreignKeys.every((key) => key.table === t.name || placed.has(key.table) || !described.has(key.table)))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!ready.length) throw new Error("backup tables refer to each other in a circle");
    for (const t of ready) {
      order.push(t);
      placed.add(t.name);
    }
  }
  cached = order;
  return order;
}
