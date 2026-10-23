/**
 * Verified pages: someone with full access to a page marks it as checked and right, for a week, a
 * month, three months, a year, until a day they choose, or with no end. The page header shows who
 * verified it and until when, and "Verification expired" once that passes; editing the page
 * leaves it as it is, and verifying again replaces it. Search ranks a verified page above an
 * otherwise equal one and marks it (`is:verified` finds only those), the AI chat tells its model
 * which sources are verified, and MCP and the REST API show it. The verifier hears a few days
 * before the end and when it comes (inbox and email, the "verification" preference). Published
 * pages don't show it: it says something about the workspace's own reading of the page.
 *
 * Only the one row per page in `page_verification`; whether it still holds is worked out against
 * the time whenever it is read (`activeVerification`), never stored on the page.
 */
import { and, eq, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { page, pageVerification, user } from "@/db/schema";
import { PAGE_HEADER_EVENT } from "@/lib/collab-constants";
import { REMIND_BEFORE_MS, remindsBefore, verificationExpired, type VerificationView } from "@/lib/verification";
import { accessRank, AccessError, FULL_RANK, pageIdColumn, pageVisibleTo, requirePageAccess } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { recordVerificationReminder } from "@/server/notifications";
import { startSweep } from "@/server/sweep";

/** Why verifying was refused; translated in the app (`page.verification.errors`). */
export type VerificationErrorCode = "template" | "inTrash" | "invalidEnd";

export class VerificationError extends Error {
  constructor(
    readonly code: VerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VerificationError";
  }
}

/** How often the server looks for verifications to remind about. */
const SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * SQL condition: the page of `alias` (or the page table) is verified right now: verified, and its
 * verification has no end or ends later.
 */
export function activeVerification(alias?: string): SQL<boolean> {
  return sql<boolean>`exists (select 1 from ${pageVerification} pv where pv.page_id = ${pageIdColumn(alias)} and (pv.expires_at is null or pv.expires_at > now()))`;
}

/** A page's verification as `viewOf` reads it, with the verifier's name. */
async function loadVerifications(pageIds: string[]) {
  if (!pageIds.length) return [];
  return db
    .select({
      pageId: pageVerification.pageId,
      verifiedBy: pageVerification.verifiedBy,
      name: user.name,
      verifiedAt: pageVerification.verifiedAt,
      expiresAt: pageVerification.expiresAt,
    })
    .from(pageVerification)
    .leftJoin(user, eq(user.id, pageVerification.verifiedBy))
    .where(inArray(pageVerification.pageId, pageIds));
}

const viewOf = (row: Awaited<ReturnType<typeof loadVerifications>>[number], now = new Date()): VerificationView => ({
  byId: row.verifiedBy,
  by: row.name,
  at: row.verifiedAt.toISOString(),
  until: row.expiresAt?.toISOString() ?? null,
  expired: verificationExpired(row.expiresAt, now),
});

/** The page's verification, expired or not; null when nobody verified it. The caller has checked the reader can see the page. */
export async function verificationOf(pageId: string): Promise<VerificationView | null> {
  const [row] = await loadVerifications([pageId]);
  return row ? viewOf(row) : null;
}

/** The verifications of these pages that hold now, by page; the caller has checked the reader can see them. */
export async function activeVerifications(pageIds: string[]): Promise<Map<string, VerificationView>> {
  const now = new Date();
  const rows = await loadVerifications([...new Set(pageIds)]);
  return new Map(rows.map((r) => [r.pageId, viewOf(r, now)] as const).filter(([, v]) => !v.expired));
}

/**
 * Verifies the page until `until` (null: with no end), or removes its verification (`until`
 * undefined), as `userId`, who needs full access to it. Templates and the pages in them aren't
 * verified, nor pages in the trash; a verification has to end later than now. Verifying isn't an
 * edit: the page's "edited" time and author stay.
 */
export async function setPageVerification(userId: string, pageId: string, until: Date | null | undefined) {
  const found = await requirePageAccess(userId, pageId, "full");
  if (found.isTemplate || found.inTemplate) throw new VerificationError("template", "Templates and the pages in them aren't verified");
  if (until !== undefined && found.archivedAt) throw new VerificationError("inTrash", "Restore the page from the trash first");
  const now = new Date();
  if (until && until.getTime() <= now.getTime()) throw new VerificationError("invalidEnd", "A verification has to end later than now");
  if (until === undefined) {
    const removed = await db.delete(pageVerification).where(eq(pageVerification.pageId, pageId)).returning({ pageId: pageVerification.pageId });
    if (removed.length) {
      await recordAudit({ workspaceId: found.workspaceId, actorId: userId, action: "page.unverified", target: { type: "page", id: pageId, label: found.title } });
    }
  } else {
    const values = {
      workspaceId: found.workspaceId,
      verifiedBy: userId,
      verifiedAt: now,
      expiresAt: until,
      // One that ends within the reminder's lead gets no "ends soon" reminder, only "ended".
      remindedAt: remindsBefore(until, now) ? null : now,
      expiredAt: null,
    };
    await db
      .insert(pageVerification)
      .values({ pageId, ...values })
      .onConflictDoUpdate({ target: pageVerification.pageId, set: values });
    await recordAudit({
      workspaceId: found.workspaceId,
      actorId: userId,
      action: "page.verified",
      target: { type: "page", id: pageId, label: found.title },
      details: { until: until?.toISOString() ?? null },
    });
  }
  // Its open tabs show the badge, or stop showing it.
  getCollab().broadcast(`page:${pageId}`, PAGE_HEADER_EVENT);
  return { workspaceId: found.workspaceId, verification: await verificationOf(pageId) };
}

/** A page's verification for someone who can see the page, and whether they may change it (full access). */
export async function verificationFor(userId: string, pageId: string): Promise<(VerificationView & { canChange: boolean }) | null> {
  const [row] = await db
    .select({ level: accessRank(userId, sql`${page.id}`) })
    .from(page)
    .where(eq(page.id, pageId));
  if (!row || Number(row.level) === 0) throw new AccessError();
  const view = await verificationOf(pageId);
  return view ? { ...view, canChange: Number(row.level) === FULL_RANK } : null;
}

export type ExpiredVerification = { id: string; title: string; icon: string | null; kind: string; by: string | null; until: string; canChange: boolean };

/** The pages of the workspace `userId` can open whose verification has ended, the longest ago first (the workspace check). */
export async function expiredVerifications(userId: string, workspaceId: string, limit = 200): Promise<ExpiredVerification[]> {
  const rows = await db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      kind: page.kind,
      by: user.name,
      until: pageVerification.expiresAt,
      level: accessRank(userId, sql`${page.id}`),
    })
    .from(pageVerification)
    .innerJoin(page, eq(page.id, pageVerification.pageId))
    .leftJoin(user, eq(user.id, pageVerification.verifiedBy))
    .where(
      and(
        eq(pageVerification.workspaceId, workspaceId),
        isNotNull(pageVerification.expiresAt),
        lte(pageVerification.expiresAt, new Date()),
        isNull(page.archivedAt),
        pageVisibleTo(userId),
      ),
    )
    .orderBy(pageVerification.expiresAt)
    .limit(limit);
  return rows.map((r) => ({ id: r.id, title: r.title, icon: r.icon, kind: r.kind, by: r.by, until: r.until!.toISOString(), canChange: Number(r.level) === FULL_RANK }));
}

/**
 * One round of reminders as of `now`: verifiers whose verification ends within REMIND_BEFORE_MS
 * hear that it ends soon, and those whose verification ended hear that it did, once each (the
 * marks are set before anyone is told, so two rounds at once can't both tell). Pages in the trash
 * and people who can no longer open the page hear nothing (recordVerificationReminder).
 */
export async function runVerificationReminders(now: Date = new Date()) {
  const soon = await db
    .update(pageVerification)
    .set({ remindedAt: now })
    .where(
      and(
        isNull(pageVerification.remindedAt),
        isNotNull(pageVerification.expiresAt),
        lte(pageVerification.expiresAt, new Date(now.getTime() + REMIND_BEFORE_MS)),
        sql`${pageVerification.expiresAt} > ${now}`,
      ),
    )
    .returning();
  const ended = await db
    .update(pageVerification)
    .set({ expiredAt: now, remindedAt: sql`coalesce(${pageVerification.remindedAt}, ${now})` })
    .where(and(isNull(pageVerification.expiredAt), isNotNull(pageVerification.expiresAt), lte(pageVerification.expiresAt, now)))
    .returning();
  for (const row of [...soon, ...ended]) {
    if (!row.verifiedBy || !row.expiresAt) continue;
    try {
      await recordVerificationReminder(row.verifiedBy, row.pageId, row.expiresAt, now);
    } catch (error) {
      console.error("[verification] could not record a reminder", error);
    }
  }
  return { soon: soon.length, ended: ended.length };
}

/** Server only: reminds verifiers as their verifications end. */
export function startVerificationReminders() {
  return startSweep(SWEEP_INTERVAL_MS, () => runVerificationReminders(), "could not send verification reminders");
}
