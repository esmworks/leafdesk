import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { page } from "@/db/schema";
import type { EmbedBlockType, EmbedReference } from "@/lib/embed-blocks";
import { tableAsDatabase } from "@/lib/table-to-database";
import {
  accessRank,
  getMembership,
  hasLevel,
  isGuest,
  levelFromRank,
  requirePageAccess,
  resolvePageAccess,
  type AccessLevel,
} from "@/server/access";
import type { WriteActor } from "@/server/collab/bridge";
import { withCode } from "@/server/databases";
import { createPage, type DatabaseSeedNames } from "@/server/pages";
import { recordAudit } from "@/server/audit";
import { importCsvAsDatabase } from "@/server/import/csv";
import { exportAllowed } from "@/server/workspaces";

/**
 * Databases shown inside page bodies (see lib/embed-blocks). An inline database is an ordinary
 * database page whose parent is the page showing it: it sits under that page in the sidebar,
 * inherits its access, and goes to the trash, comes back and is duplicated with it. A linked view
 * shows any database. Either way the block holds only the database id, and everything about the
 * database is read with the reader's own access to it: seeing the page is not enough.
 */

/**
 * Creates the database of a new inline database block under `hostPageId`. Needs edit access to the
 * page, like adding any subpage. Databases hold rows, not pages, so they can't host one.
 */
export async function createInlineDatabase(actor: WriteActor, hostPageId: string, seedNames?: DatabaseSeedNames) {
  const host = await requirePageAccess(actor.userId, hostPageId, "edit");
  if (host.kind === "database") throw withCode(new Error("A database can't contain another database"), "nestedDatabase");
  const created = await createPage(actor, { workspaceId: host.workspaceId, parentId: host.id, kind: "database", seedNames });
  return { id: created.id, workspaceId: created.workspaceId };
}

/**
 * Creates the database a table block of `hostPageId` turns into, under that page as an inline
 * database is: the first row names the properties (the first column is the rows' titles, the others
 * text properties), and every other row becomes a row with its cells as plain text. Takes the
 * table's cells as text (see lib/table-to-database tableRecords); the editor then puts a database
 * block in the table's place.
 */
export async function tableToDatabase(actor: WriteActor, hostPageId: string, records: string[][], seedNames?: DatabaseSeedNames) {
  const host = await requirePageAccess(actor.userId, hostPageId, "edit");
  if (host.kind === "database") throw withCode(new Error("A database can't contain another database"), "nestedDatabase");
  const table = tableAsDatabase(records.map((row) => row.map((cell) => String(cell ?? ""))));
  const { database } = await importCsvAsDatabase(actor, {
    workspaceId: host.workspaceId,
    parentId: host.id,
    title: "",
    table,
    titleColumn: 0,
    types: table.headers.map((_, i) => (i === 0 ? null : "text")),
    seedNames,
  });
  // The import leaves its database out of the audit log; this one is made like any inline database.
  await recordAudit({
    workspaceId: host.workspaceId,
    actorId: actor.userId,
    action: "page.created",
    target: { type: "page", id: database.id, label: database.title },
    details: { kind: "database" },
  });
  return { id: database.id, workspaceId: database.workspaceId };
}

/** What a database block may show about its database to this reader. */
export type EmbedInfo =
  /** Missing, not a database, or not visible to them: the block says so and nothing else. */
  | { state: "unavailable" }
  | { state: "ok"; workspaceId: string; level: AccessLevel; guest: boolean; archived: boolean; exportable: boolean };

export async function getEmbedInfo(userId: string, databaseId: string): Promise<EmbedInfo> {
  const { page: found, level } = await resolvePageAccess(userId, databaseId);
  if (!found || found.kind !== "database" || !hasLevel(level, "view")) return { state: "unavailable" };
  const [membership, exportable] = await Promise.all([getMembership(userId, found.workspaceId), exportAllowed(found.workspaceId)]);
  if (!membership) return { state: "unavailable" };
  return {
    state: "ok",
    workspaceId: found.workspaceId,
    level,
    guest: isGuest(membership.role),
    archived: Boolean(found.archivedAt),
    exportable,
  };
}

export type ResolvedEmbed = {
  type: EmbedBlockType;
  databaseId: string;
  /** Null when the reader can't see the database (or it is gone): its title stays private. */
  database: { id: string; workspaceId: string; title: string; inTrash: boolean } | null;
};

/** The databases a page body's blocks point at, as far as `userId` may see them. */
export async function resolveEmbeds(userId: string, references: EmbedReference[]): Promise<ResolvedEmbed[]> {
  if (!references.length) return [];
  const ids = [...new Set(references.map((r) => r.databaseId))];
  const rows = await db
    .select({
      id: page.id,
      workspaceId: page.workspaceId,
      title: page.title,
      kind: page.kind,
      archivedAt: page.archivedAt,
      level: accessRank(userId, sql`${page.id}`),
    })
    .from(page)
    .where(inArray(page.id, ids));
  const visible = new Map(
    rows
      .filter((r) => r.kind === "database" && levelFromRank(r.level) !== "none")
      .map((r) => [r.id, { id: r.id, workspaceId: r.workspaceId, title: r.title, inTrash: r.archivedAt !== null }]),
  );
  return references.map((r) => ({ ...r, database: visible.get(r.databaseId) ?? null }));
}
