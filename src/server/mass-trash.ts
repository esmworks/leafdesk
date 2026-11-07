import { and, count, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { notification, page } from "@/db/schema";
import { MASS_TRASH_ROWS, MASS_TRASH_WINDOW_MS, massTrashMessage, type MassTrash } from "@/lib/mass-trash";
import { findMembership, workspaceOwnerIds } from "@/server/access";
import { recordMassTrash } from "@/server/notifications";

/**
 * Tells the workspace's owners when someone who isn't one moves many rows of a database to the
 * trash: MASS_TRASH_ROWS or more of one database within MASS_TRASH_WINDOW_MS, one by one or at
 * once (`rows`), or the database itself with that many rows (`database`). The trash empties itself
 * after the workspace's retention, so rows trashed out of spite would otherwise go unnoticed until
 * they are gone. Owners undo it from the database's history (rows) or the trash (a database).
 *
 * An owner's own trashing isn't told: owners may delete for good anyway. Each person and database
 * makes at most one notice per window; nothing here stops the trashing, and a failure only logs.
 */
export async function noticeMassTrash(actorId: string, databaseId: string, what: MassTrash["what"]) {
  try {
    const [database] = await db
      .select({ workspaceId: page.workspaceId, kind: page.kind, archivedAt: page.archivedAt })
      .from(page)
      .where(eq(page.id, databaseId));
    if (database?.kind !== "database") return;
    const membership = await findMembership(actorId, database.workspaceId);
    if (!membership || membership.role === "owner") return;
    const since = new Date(Date.now() - MASS_TRASH_WINDOW_MS);
    // Rows of it in the trash now that this person put there within the window (archivePage and
    // archiveRows stamp them as theirs), or, for the database, the rows that went with it.
    const [rows] =
      what === "database"
        ? database.archivedAt
          ? await db
              .select({ n: count() })
              .from(page)
              .where(and(eq(page.parentId, databaseId), eq(page.archivedAt, database.archivedAt)))
          : [{ n: 0 }]
        : await db
            .select({ n: count() })
            .from(page)
            .where(and(eq(page.parentId, databaseId), isNotNull(page.archivedAt), gt(page.archivedAt, since), eq(page.updatedBy, actorId)));
    const total = Number(rows?.n ?? 0);
    if (total < MASS_TRASH_ROWS) return;
    // Once per person and database within the window: later rows of the same spree don't repeat it.
    const [told] = await db
      .select({ id: notification.id })
      .from(notification)
      .where(
        and(
          eq(notification.kind, "mass_trash"),
          eq(notification.pageId, databaseId),
          eq(notification.actorId, actorId),
          gt(notification.createdAt, since),
        ),
      )
      .limit(1);
    if (told) return;
    const owners = (await workspaceOwnerIds(database.workspaceId)).filter((id) => id !== actorId);
    if (!owners.length) return;
    await recordMassTrash(database.workspaceId, owners, actorId, databaseId, massTrashMessage({ what, count: total }));
  } catch (error) {
    console.error("[mass-trash] couldn't tell the owners", error instanceof Error ? error.message : error);
  }
}
