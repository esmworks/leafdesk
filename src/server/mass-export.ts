import { and, count, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { auditEvent, notification } from "@/db/schema";
import { MASS_EXPORT_PAGES, MASS_EXPORT_WINDOW_MS, massExportMessage } from "@/lib/mass-export";
import { findMembership, workspaceOwnerIds } from "@/server/access";
import { recordMassExport } from "@/server/notifications";

/**
 * Tells the workspace's owners when someone who isn't one exports or prints many pages: the
 * MASS_EXPORT_PAGES-th page export (`export.page` in the audit log: a page's Markdown, PDF, Word,
 * print view, a database's CSV …) within MASS_EXPORT_WINDOW_MS. Printing single pages is what
 * `exportBy` "pages" leaves the others, and a customer list printed row by row would otherwise go
 * unnoticed. Owners see what was taken in the audit log.
 *
 * An owner's own exports aren't told. Each person makes at most one notice per window; nothing
 * here stops the export, and a failure only logs. Called by export.ts `recordExport`.
 */
export async function noticeMassExport(actorId: string, workspaceId: string) {
  try {
    const membership = await findMembership(actorId, workspaceId);
    if (!membership || membership.role === "owner") return;
    const since = new Date(Date.now() - MASS_EXPORT_WINDOW_MS);
    const [exports] = await db
      .select({ n: count() })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.workspaceId, workspaceId),
          eq(auditEvent.actorUserId, actorId),
          eq(auditEvent.action, "export.page"),
          gt(auditEvent.createdAt, since),
        ),
      );
    const total = Number(exports?.n ?? 0);
    if (total < MASS_EXPORT_PAGES) return;
    // Once per person within the window: later pages of the same spree don't repeat it.
    const [told] = await db
      .select({ id: notification.id })
      .from(notification)
      .where(
        and(
          eq(notification.kind, "mass_export"),
          eq(notification.workspaceId, workspaceId),
          eq(notification.actorId, actorId),
          gt(notification.createdAt, since),
        ),
      )
      .limit(1);
    if (told) return;
    const owners = (await workspaceOwnerIds(workspaceId)).filter((id) => id !== actorId);
    if (!owners.length) return;
    await recordMassExport(workspaceId, owners, actorId, massExportMessage({ count: total, actorId }));
  } catch (error) {
    console.error("[mass-export] couldn't tell the owners", error instanceof Error ? error.message : error);
  }
}
