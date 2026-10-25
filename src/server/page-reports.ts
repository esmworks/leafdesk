import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pagePublication, pageReport } from "@/db/schema";
import { pageLabel } from "@/lib/labels";
import { isReportReason, MAX_REPORT_DETAILS, MAX_REPORT_EMAIL, type ReportReason } from "@/lib/page-reports";
import { isEmailAddress } from "@/lib/properties";
import { sharedLimiter, takeAll } from "@/lib/rate-limit";
import { AccessError, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { recordPageReport } from "@/server/notifications";
import { revokePublication } from "@/server/publication";
import { servedPublication } from "@/server/site";

/**
 * Visitors' reports about published pages. Anyone reading a published page (or a page of a
 * workspace's site) may report it from the link at its foot: why (lib/page-reports), a few words
 * and, if they like, an email address to be answered at. The workspace's owners hear about it in
 * their inbox and see the open reports in Settings > Security, where they dismiss one or take the
 * page off the web. Nothing leaves the server: there is no one else to report to.
 */

/** Reports per IP address, and per public address (a publication or site) from everyone together. */
export const REPORT_RATE_LIMITS = {
  perIp: { limit: 5, windowMs: 60 * 60_000 },
  perPublication: { limit: 30, windowMs: 24 * 60 * 60_000 },
};
const ipLimiter = () => sharedLimiter("page-report-ip", REPORT_RATE_LIMITS.perIp.limit, REPORT_RATE_LIMITS.perIp.windowMs);
const publicationLimiter = () =>
  sharedLimiter("page-report-publication", REPORT_RATE_LIMITS.perPublication.limit, REPORT_RATE_LIMITS.perPublication.windowMs);

/** Scripts and tests: start counting again. */
export function resetReportRateLimits() {
  ipLimiter().reset();
  publicationLimiter().reset();
}

/** Owners hear about a page at most this often, however many reports come. */
const NOTIFY_EVERY_MS = 24 * 60 * 60_000;

export class ReportError extends Error {
  constructor(readonly code: "invalid" | "rateLimited") {
    super(code);
  }
}

export type ReportInput = { reason: unknown; details?: unknown; email?: unknown; honeypot?: unknown };

/**
 * Records a report about page `pageId` as served at the public address `key` (a publication's
 * token or a site's slug). A page that isn't served there, and a filled-in honeypot, are dropped
 * without a word, so the answer says nothing about which pages are published. Throws ReportError
 * for a reason or address that isn't one, or too many reports.
 */
export async function reportPublishedPage(
  key: string,
  pageId: string,
  input: ReportInput,
  { userId = null, ip, now = new Date() }: { userId?: string | null; ip: string; now?: Date },
): Promise<void> {
  if (!isReportReason(input.reason)) throw new ReportError("invalid");
  const details = typeof input.details === "string" ? input.details.trim().slice(0, MAX_REPORT_DETAILS) : "";
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (email && (email.length > MAX_REPORT_EMAIL || !isEmailAddress(email))) throw new ReportError("invalid");
  if (typeof key !== "string" || typeof pageId !== "string" || key.length > 128 || pageId.length > 64) return;
  if (input.honeypot) return;
  if (takeAll([[ipLimiter(), ip], [publicationLimiter(), key]], now.getTime()) > 0) throw new ReportError("rateLimited");

  const served = await servedPublication(key, pageId);
  if (!served) return;
  const publishedPageId = served.rootId;
  const [publication] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, publishedPageId)).limit(1);
  if (!publication) return;

  const reason: ReportReason = input.reason;
  const [recent] = await db
    .select({ id: pageReport.id })
    .from(pageReport)
    .where(and(eq(pageReport.pageId, pageId), gt(pageReport.createdAt, new Date(now.getTime() - NOTIFY_EVERY_MS))))
    .limit(1);
  const [report] = await db
    .insert(pageReport)
    .values({ workspaceId: publication.workspaceId, pageId, publishedPageId, reason, details, email: email || null, reporterId: userId, createdAt: now })
    .returning({ id: pageReport.id });
  await recordAudit({ workspaceId: publication.workspaceId, actorId: null, action: "page.reported", target: { type: "page", id: pageId }, details: { reason, reportId: report.id } });
  if (!recent) await recordPageReport(publication.workspaceId, pageId, reason);
}

export type PageReportView = {
  id: string;
  reason: ReportReason;
  details: string;
  email: string | null;
  createdAt: string;
  page: { id: string; title: string; icon: string | null; kind: string };
  /** The page whose publication served it; taking it off the web unpublishes this one. */
  publishedPageId: string;
  /** Whether that page is still on the web. */
  published: boolean;
};

const LIST_LIMIT = 100;

/** The open reports of the workspace, newest first (up to LIST_LIMIT), and how many there are. Owners only. */
export async function listPageReports(actorId: string, workspaceId: string): Promise<{ reports: PageReportView[]; total: number }> {
  await requireMembership(actorId, workspaceId, "owner");
  const where = and(eq(pageReport.workspaceId, workspaceId), eq(pageReport.status, "open"));
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        report: pageReport,
        title: page.title,
        icon: page.icon,
        kind: page.kind,
        published: sql<boolean>`exists (select 1 from ${pagePublication} where ${pagePublication.pageId} = ${pageReport.publishedPageId})`,
      })
      .from(pageReport)
      .innerJoin(page, eq(page.id, pageReport.pageId))
      .where(where)
      .orderBy(desc(pageReport.createdAt), desc(pageReport.id))
      .limit(LIST_LIMIT),
    db.select({ total: sql<number>`count(*)::int` }).from(pageReport).where(where),
  ]);
  return {
    total,
    reports: rows.map(({ report, title, icon, kind, published }) => ({
      id: report.id,
      reason: report.reason,
      details: report.details,
      email: report.email,
      createdAt: report.createdAt.toISOString(),
      page: { id: report.pageId, title: pageLabel(title), icon, kind },
      publishedPageId: report.publishedPageId,
      published,
    })),
  };
}

/**
 * Handles an open report: "dismiss" closes it; "unpublish" takes the page whose publication served
 * the reported page off the web (whoever published it) and closes every open report served by it.
 * Recorded in the audit log. Owners only; AccessError for a report of another workspace or one
 * already handled.
 */
export async function handlePageReport(actorId: string, workspaceId: string, reportId: string, action: "dismiss" | "unpublish") {
  await requireMembership(actorId, workspaceId, "owner");
  const [report] = await db
    .select()
    .from(pageReport)
    .where(and(eq(pageReport.id, reportId), eq(pageReport.workspaceId, workspaceId), eq(pageReport.status, "open")))
    .limit(1);
  if (!report) throw new AccessError();
  const handled = { handledAt: new Date(), handledBy: actorId };
  if (action === "unpublish") {
    await revokePublication(actorId, workspaceId, report.publishedPageId);
    await db
      .update(pageReport)
      .set({ status: "unpublished", ...handled })
      .where(and(eq(pageReport.workspaceId, workspaceId), eq(pageReport.publishedPageId, report.publishedPageId), eq(pageReport.status, "open")));
    return;
  }
  await db
    .update(pageReport)
    .set({ status: "dismissed", ...handled })
    .where(and(eq(pageReport.id, report.id), ne(pageReport.status, "dismissed")));
  await recordAudit({
    workspaceId,
    actorId,
    action: "page.report_dismissed",
    target: { type: "page", id: report.pageId },
    details: { reason: report.reason, reportId: report.id },
  });
}
