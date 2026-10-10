import { sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvent, databaseProperty, databaseView, DEFAULT_WORKSPACE_SETTINGS, page, pageSnapshot, workspace } from "@/db/schema";
import { auditCutoff, HISTORY_RETENTION, historyCutoffs } from "@/lib/retention";
import { purgeDeletedProperties, purgeDeletedViews } from "@/server/databases";
import { deleteTrashedPages } from "@/server/pages";

/**
 * Data retention, applied once a day by the app server (startRetention, from server.ts):
 *  - pages that have been in the trash longer than their workspace's `trashRetentionDays` are
 *    deleted for good, the way "Delete permanently" does it (files included);
 *  - so are database properties and views deleted longer ago than that (purgeExpiredSchema);
 *  - page history is pruned by the rules in lib/retention.ts (HISTORY_RETENTION);
 *  - audit log events older than AUDIT_RETENTION_DAYS are deleted.
 *
 * Each replica has its own daily timer; a session advisory lock keeps two of them from running at
 * once. The work is idempotent, so a replica that runs later the same day only finds what has
 * become due since.
 *
 * `workspaceIds` narrows a run to some workspaces: the e2e script runs it against its own
 * workspaces only, so a test never deletes anyone else's trash.
 */

export type RetentionOptions = { now?: Date; workspaceIds?: string[] };

export type RetentionResult = {
  /** Trash entries deleted for good; their subpages went with them. */
  trashedPages: number;
  /** Workspaces those entries came from. */
  workspaces: number;
  /** Deleted database properties and views deleted for good (the other sides of relations included). */
  deletedProperties: number;
  deletedViews: number;
  snapshots: number;
  auditEvents: number;
};

const LOCK = "leafdesk:retention";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Pages deleted per statement, so a long-neglected trash doesn't make one huge delete. */
const DELETE_BATCH = 200;

/**
 * Deletes the trash entries that are due at `now`. An entry is what the trash lists (see
 * pages.listTrash): the top page of what was trashed together. Subpages trashed earlier are
 * entries of their own and fall due on their own date; the ones trashed with it go with it.
 */
export async function purgeExpiredTrash({ now = new Date(), workspaceIds }: RetentionOptions = {}) {
  if (workspaceIds?.length === 0) return { trashedPages: 0, workspaces: 0 };
  const days = sql`coalesce((w.settings ->> 'trashRetentionDays')::int, ${DEFAULT_WORKSPACE_SETTINGS.trashRetentionDays})`;
  const due = await db.execute<{ id: string; workspace_id: string }>(sql`
    select p.id, p.workspace_id
    from ${page} p
    join ${workspace} w on w.id = p.workspace_id
    left join ${page} parent on parent.id = p.parent_id
    where p.archived_at is not null
      and not p.is_template
      and (parent.id is null or parent.archived_at is null or parent.archived_at <> p.archived_at)
      and ${days} > 0
      and p.archived_at <= ${now.toISOString()}::timestamptz - make_interval(hours => 24 * ${days})
      ${workspaceIds ? sql`and p.workspace_id in ${workspaceIds}` : sql``}
  `);

  const byWorkspace = new Map<string, string[]>();
  for (const row of due) {
    const list = byWorkspace.get(row.workspace_id) ?? [];
    list.push(row.id);
    byWorkspace.set(row.workspace_id, list);
  }
  let trashedPages = 0;
  for (const [workspaceId, ids] of byWorkspace) {
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      // No actor: the audit log records these deletes as the server's own.
      trashedPages += (await deleteTrashedPages(workspaceId, ids.slice(i, i + DELETE_BATCH), null)).length;
    }
  }
  return { trashedPages, workspaces: byWorkspace.size };
}

/**
 * Deletes for good the database properties and views that were deleted longer ago than their
 * workspace's `trashRetentionDays` at `now` (none where it is 0), as "Delete permanently" in the
 * database does. Properties of databases in the trash count too: their own date decides.
 */
export async function purgeExpiredSchema({ now = new Date(), workspaceIds }: RetentionOptions = {}) {
  if (workspaceIds?.length === 0) return { deletedProperties: 0, deletedViews: 0 };
  const days = sql`coalesce((w.settings ->> 'trashRetentionDays')::int, ${DEFAULT_WORKSPACE_SETTINGS.trashRetentionDays})`;
  const due = (table: typeof databaseProperty | typeof databaseView) =>
    db.execute<{ id: string; workspace_id: string }>(sql`
      select x.id, p.workspace_id
      from ${table} x
      join ${page} p on p.id = x.database_id
      join ${workspace} w on w.id = p.workspace_id
      where x.deleted_at is not null
        and ${days} > 0
        and x.deleted_at <= ${now.toISOString()}::timestamptz - make_interval(hours => 24 * ${days})
        ${workspaceIds ? sql`and p.workspace_id in ${workspaceIds}` : sql``}
    `);
  const byWorkspace = (rows: { id: string; workspace_id: string }[]) => {
    const out = new Map<string, string[]>();
    for (const row of rows) out.set(row.workspace_id, [...(out.get(row.workspace_id) ?? []), row.id]);
    return out;
  };
  let deletedProperties = 0;
  let deletedViews = 0;
  // No actor: the audit log records these deletes as the server's own.
  for (const [workspaceId, ids] of byWorkspace([...(await due(databaseProperty))])) {
    for (let i = 0; i < ids.length; i += DELETE_BATCH) deletedProperties += await purgeDeletedProperties(workspaceId, ids.slice(i, i + DELETE_BATCH));
  }
  for (const [workspaceId, ids] of byWorkspace([...(await due(databaseView))])) {
    for (let i = 0; i < ids.length; i += DELETE_BATCH) deletedViews += await purgeDeletedViews(workspaceId, ids.slice(i, i + DELETE_BATCH));
  }
  return { deletedProperties, deletedViews };
}

/**
 * Deletes the page versions that HISTORY_RETENTION no longer keeps at `now`. Versions of the kinds
 * kept longer are ranked apart from the rest, so they don't push ordinary ones past the limit or
 * the other way round. Returns how many went.
 */
export async function pruneSnapshots({ now = new Date(), workspaceIds }: RetentionOptions = {}) {
  if (workspaceIds?.length === 0) return 0;
  const cutoff = historyCutoffs(now);
  const kept = sql`s.reason in ${[...HISTORY_RETENTION.keptReasons]}`;
  const scope = workspaceIds ? sql`and s.page_id in (select id from ${page} where workspace_id in ${workspaceIds})` : sql``;
  const deleted = await db.execute<{ id: string }>(sql`
    with ranked as (
      select s.id, s.created_at, ${kept} as kept,
        row_number() over (partition by s.page_id order by s.created_at desc, s.id desc) as newest,
        row_number() over (partition by s.page_id, ${kept} order by s.created_at desc, s.id desc) as rank_in_kind
      from ${pageSnapshot} s
      where true ${scope}
    )
    delete from ${pageSnapshot} target
    using ranked r
    where target.id = r.id
      and r.newest > 1
      and case
        when r.kept then r.created_at < ${cutoff.kept.toISOString()}::timestamptz
        else r.created_at < ${cutoff.regular.toISOString()}::timestamptz or r.rank_in_kind > ${HISTORY_RETENTION.maxPerPage}
      end
    returning target.id
  `);
  return deleted.length;
}

/** Deletes the audit log events older than AUDIT_RETENTION_DAYS at `now`. Returns how many went. */
export async function pruneAuditEvents({ now = new Date(), workspaceIds }: RetentionOptions = {}) {
  if (workspaceIds?.length === 0) return 0;
  const [row] = await db.execute<{ count: number }>(sql`
    with deleted as (
      delete from ${auditEvent}
      where created_at < ${auditCutoff(now).toISOString()}::timestamptz
        ${workspaceIds ? sql`and workspace_id in ${workspaceIds}` : sql``}
      returning 1
    )
    select count(*)::int as count from deleted
  `);
  return Number(row?.count ?? 0);
}

/**
 * One retention run: the trash, page history, then the audit log. Returns null when another
 * replica is running it right now. The lock is a session lock, so it is taken on a connection held
 * for the run and goes away with it if the process dies midway.
 */
export async function runRetention(options: RetentionOptions = {}): Promise<RetentionResult | null> {
  const connection = await db.$client.reserve();
  try {
    const [row] = await connection<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${LOCK})) as locked`;
    if (!row?.locked) return null;
    try {
      const trash = await purgeExpiredTrash(options);
      const schema = await purgeExpiredSchema(options);
      const snapshots = await pruneSnapshots(options);
      const auditEvents = await pruneAuditEvents(options);
      return { ...trash, ...schema, snapshots, auditEvents };
    } finally {
      await connection`select pg_advisory_unlock(hashtext(${LOCK}))`;
    }
  } finally {
    connection.release();
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Runs the retention cleanup a few minutes after the server starts, then once a day. */
export function startRetention() {
  if (timer) return;
  const run = async () => {
    try {
      const result = await runRetention();
      if (!result) {
        console.log("[retention] skipped: another server is running it");
        return;
      }
      console.log(
        `[retention] deleted ${result.trashedPages} pages from the trash of ${result.workspaces} workspaces, ` +
          `${result.deletedProperties} deleted properties, ${result.deletedViews} deleted views, ` +
          `${result.snapshots} old page versions and ${result.auditEvents} old audit log events`,
      );
    } catch (error) {
      console.error("[retention] cleanup failed", error);
    }
  };
  setTimeout(run, 5 * 60 * 1000).unref();
  timer = setInterval(run, DAY_MS);
  timer.unref();
}
