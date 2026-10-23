import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, databaseRowAccess, user } from "@/db/schema";
import { parseRowAccess, readRowAccess, remapRowAccess, rowAccessInUse, type RowAccessConfig } from "@/lib/row-access";
import { AccessError, peopleWithFullAccess, requirePageAccess } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { onRowChanged } from "@/server/row-events";

/**
 * Row access (lib/row-access.ts): a database's rules giving the people a row names access to it,
 * and whether its rows are kept from everyone else. Stored in `database_row_access`, applied by
 * the SQL function page_access_level, so every check and list follows it without asking here.
 *
 * Who a row names changes with its values: after a row of such a database changes, open editors
 * are checked again (a connection's access is only checked when it opens), and the database's
 * viewers reload its rows.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A database's row access as stored; the empty setting when it has none. */
export async function loadRowAccess(databaseId: string, exec: Pick<typeof db, "select"> = db): Promise<RowAccessConfig> {
  const [row] = await exec
    .select({ restricted: databaseRowAccess.restricted, rules: databaseRowAccess.rules })
    .from(databaseRowAccess)
    .where(eq(databaseRowAccess.databaseId, databaseId));
  return readRowAccess(row);
}

async function requireRowAccessDatabase(userId: string, databaseId: string, needed: "view" | "full") {
  const database = await requirePageAccess(userId, databaseId, needed);
  if (database.kind !== "database") throw new AccessError("Not a database");
  return database;
}

/** A database's row access, for anyone who can open the database (it names properties, not people). */
export async function getRowAccess(userId: string, databaseId: string): Promise<RowAccessConfig> {
  await requireRowAccessDatabase(userId, databaseId, "view");
  return loadRowAccess(databaseId);
}

/** How many of the people with full access the settings name; the rest are a count. */
const FULL_ACCESS_NAMES = 3;

export type RowAccessSettings = RowAccessConfig & {
  /** The database's person properties, which rules can name. */
  personProperties: { id: string; name: string }[];
  /** Others with full access to the database: they see every row, restricted or not. */
  fullAccess: { count: number; names: string[] };
};

/** A database's row access for its settings dialog. Needs full access to the database. */
export async function getRowAccessSettings(actorId: string, databaseId: string): Promise<RowAccessSettings> {
  const database = await requireRowAccessDatabase(actorId, databaseId, "full");
  const [config, personProperties, full] = await Promise.all([
    loadRowAccess(databaseId),
    db
      .select({ id: databaseProperty.id, name: databaseProperty.name })
      .from(databaseProperty)
      .where(
        and(eq(databaseProperty.databaseId, databaseId), eq(databaseProperty.type, "person"), isNull(databaseProperty.deletedAt)),
      )
      .orderBy(asc(databaseProperty.position)),
    peopleWithFullAccess(database.workspaceId, databaseId, actorId),
  ]);
  const named = full.length
    ? await db
        .select({ name: user.name, email: user.email })
        .from(user)
        .where(inArray(user.id, full))
        .orderBy(user.name)
        .limit(FULL_ACCESS_NAMES)
    : [];
  return {
    ...config,
    // Rules whose property is gone don't apply; the dialog shows the ones it can name.
    rules: config.rules.filter((r) => r.kind === "creator" || personProperties.some((p) => p.id === r.propertyId)),
    personProperties,
    fullAccess: { count: full.length, names: named.map((u) => u.name || u.email) },
  };
}

/**
 * Replaces a database's row access. Needs full access to the database. Rules name person
 * properties of the database (lib/row-access parseRowAccess); a setting that changes nothing is
 * removed rather than stored, which keeps the workspace on page_access_level's fast path.
 */
export async function setRowAccess(actorId: string, databaseId: string, input: unknown): Promise<RowAccessConfig> {
  const database = await requireRowAccessDatabase(actorId, databaseId, "full");
  const properties = await db
    .select({ id: databaseProperty.id, type: databaseProperty.type })
    .from(databaseProperty)
    .where(and(eq(databaseProperty.databaseId, databaseId), isNull(databaseProperty.deletedAt)));
  const config = parseRowAccess(input, properties);
  await db.transaction(async (tx) => {
    // The lock sharing changes take: one of them can't check a page as reachable while this
    // takes it away.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`page_permission:${database.workspaceId}`}))`);
    const before = await loadRowAccess(databaseId, tx);
    await writeRowAccess(tx, databaseId, database.workspaceId, config, actorId);
    if (JSON.stringify(before) !== JSON.stringify(config)) {
      await recordAudit(
        {
          workspaceId: database.workspaceId,
          actorId,
          action: "page.row_access_changed",
          target: { type: "page", id: databaseId },
          details: { restricted: config.restricted, rules: config.rules.length, previous: before },
        },
        tx,
      );
    }
  });
  await afterRowAccessChanged(database.workspaceId, databaseId);
  return config;
}

async function writeRowAccess(tx: Tx, databaseId: string, workspaceId: string, config: RowAccessConfig, actorId: string | null) {
  if (!rowAccessInUse(config)) {
    await tx.delete(databaseRowAccess).where(eq(databaseRowAccess.databaseId, databaseId));
    return;
  }
  const values = { restricted: config.restricted, rules: config.rules, updatedBy: actorId, updatedAt: new Date() };
  await tx
    .insert(databaseRowAccess)
    .values({ databaseId, workspaceId, ...values })
    .onConflictDoUpdate({ target: databaseRowAccess.databaseId, set: values });
}

/**
 * Gives the copies of databases their originals' row access, rules naming the copies' properties
 * (`pageIds`, `propertyIds`: original id → copy's id, server/duplicate.ts). In the copy's
 * transaction, after the properties.
 */
export async function copyRowAccess(
  tx: Tx,
  plan: { pageIds: Map<string, string>; propertyIds: Map<string, string> },
  workspaceId: string,
  actorId: string,
) {
  const sources = [...plan.pageIds.keys()];
  if (!sources.length) return;
  const stored = await tx
    .select()
    .from(databaseRowAccess)
    .where(inArray(databaseRowAccess.databaseId, sources));
  for (const row of stored) {
    const copy = plan.pageIds.get(row.databaseId);
    if (copy) await writeRowAccess(tx, copy, workspaceId, remapRowAccess(readRowAccess(row), plan.propertyIds), actorId);
  }
}

/** Open editors are checked again; the database's viewers reload its rows; the sidebar its tree. */
async function afterRowAccessChanged(workspaceId: string, databaseId: string) {
  const collab = getCollab();
  collab.broadcast(`db:${databaseId}`, "rows");
  collab.broadcast(`ws:${workspaceId}`, "tree");
  await collab.disconnectLostAccess(workspaceId);
}

// Databases whose rows changed lately, checked again together once things settle: a bulk edit of
// a hundred rows checks the open editors once.
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const SETTLE_MS = 1_000;

onRowChanged("row-access", ({ databaseId }) => {
  if (pending.has(databaseId)) return;
  pending.set(
    databaseId,
    setTimeout(() => {
      pending.delete(databaseId);
      void (async () => {
        const [row] = await db
          .select({ workspaceId: databaseRowAccess.workspaceId })
          .from(databaseRowAccess)
          .where(eq(databaseRowAccess.databaseId, databaseId));
        if (!row) return;
        await getCollab().disconnectLostAccess(row.workspaceId);
        getCollab().broadcast(`ws:${row.workspaceId}`, "tree");
      })().catch((error) => console.error("[row-access] recheck failed", error));
    }, SETTLE_MS).unref(),
  );
});

