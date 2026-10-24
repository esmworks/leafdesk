import { createHmac, hkdfSync } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, sensitiveFinding, sensitiveScan } from "@/db/schema";
import { env } from "@/lib/env";
import { pageLabel } from "@/lib/labels";
import { findSensitive, MAX_SCAN_CHARS, valueText, type Fingerprint, type SensitiveKind } from "@/lib/sensitive-content";
import { AccessError, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { recordSensitiveContent } from "@/server/notifications";
import { startSweep } from "@/server/sweep";

/**
 * Sensitive content detection (Settings > Security, `sensitiveContent`, off by default): pages and
 * rows of the workspaces that turned it on are read for payment card numbers, IBANs, national ID
 * numbers and secrets (lib/sensitive-content.ts) after they change, and what is found is listed to
 * the owners, recorded in the audit log, and told to them in their inbox.
 *
 * A sweep does the reading, apart from saving: `sensitive_scan` keeps the `updated_at` of each page
 * as last read, and a page whose `updated_at` moved on (an edit saved, a row's values changed, a
 * page restored) is read again, at most ROUND_PAGES a round. Turning detection on reads every page
 * so, a round at a time. Templates and the trash aren't read.
 *
 * A value is never kept: a finding holds its kind, a masked excerpt and a keyed hash of the value
 * (to know it again, never to get it back). A finding whose value is gone from the page resolves
 * itself; one found again after that opens again. Owners hear of a page and kind at most once a
 * day; a finding they dismissed stays dismissed while the page holds it.
 */

/** How often the scanner looks for changed pages. */
const SWEEP_INTERVAL_MS = 30_000;
/** Pages one round reads at most; the next round goes on. */
const ROUND_PAGES = 200;
/** Owners hear of the same page and kind at most this often. */
const NOTIFY_EVERY_MS = 86_400_000;
/** Open findings the settings list at most. */
const LIST_LIMIT = 200;

/** The key of the fingerprints, derived from the server's secret under a label of its own. */
let fingerprintKey: Buffer | null = null;
const fingerprint: Fingerprint = (kind, value) => {
  fingerprintKey ??= Buffer.from(hkdfSync("sha256", env.authSecret, "leafdesk-sensitive-content", "fingerprint", 32));
  return createHmac("sha256", fingerprintKey).update(`${kind}:${value}`).digest("base64url");
};

type Candidate = {
  id: string;
  workspaceId: string;
  title: string;
  text: string;
  properties: unknown;
  /** `updated_at` as Postgres writes it, to the microsecond, to record what was read. */
  version: string;
};

/** Changed pages (or never read) of the workspaces that detect sensitive content, oldest change first. */
async function changedPages(limit: number): Promise<Candidate[]> {
  return db.execute<Candidate>(sql`
    select p.id, p.workspace_id as "workspaceId", p.title, left(p.content_text, ${MAX_SCAN_CHARS}) as text, p.properties,
      p.updated_at::text as version
    from ${page} p
    join workspace w on w.id = p.workspace_id and coalesce((w.settings->>'sensitiveContent')::boolean, false)
    left join ${sensitiveScan} s on s.page_id = p.id
    where p.archived_at is null and not p.in_template and not p.is_template
      and (s.page_id is null or p.updated_at > s.source_updated_at)
    order by p.updated_at
    limit ${limit}
  `);
}

type Opened = { id: string; kind: SensitiveKind; excerpt: string };

/**
 * Reads one page and settles its findings; returns those that opened (new, or found again). Skips
 * a page another server is reading.
 */
async function scanPage(candidate: Candidate, now: Date): Promise<Opened[] | null> {
  const text = [candidate.title, candidate.text, valueText(candidate.properties)].join("\n");
  const matches = findSensitive(text, fingerprint);
  return db.transaction(async (tx) => {
    const [{ locked }] = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${`leafdesk:sensitive-scan:${candidate.id}`})) as locked`);
    if (!locked) return null;
    const existing = await tx.select().from(sensitiveFinding).where(eq(sensitiveFinding.pageId, candidate.id));
    const byValue = new Map(existing.map((f) => [`${f.kind}:${f.fingerprint}`, f]));
    const seen = new Set<string>();
    const opened: Opened[] = [];
    for (const match of matches) {
      const key = `${match.kind}:${match.fingerprint}`;
      seen.add(key);
      const found = byValue.get(key);
      if (!found) {
        const [row] = await tx
          .insert(sensitiveFinding)
          .values({ workspaceId: candidate.workspaceId, pageId: candidate.id, kind: match.kind, fingerprint: match.fingerprint, excerpt: match.masked, foundAt: now, lastSeenAt: now })
          .onConflictDoNothing()
          .returning({ id: sensitiveFinding.id });
        if (row) opened.push({ id: row.id, kind: match.kind, excerpt: match.masked });
      } else if (found.status === "resolved") {
        await tx
          .update(sensitiveFinding)
          .set({ status: "open", foundAt: now, lastSeenAt: now, resolvedAt: null, excerpt: match.masked })
          .where(eq(sensitiveFinding.id, found.id));
        opened.push({ id: found.id, kind: match.kind, excerpt: match.masked });
      } else {
        await tx.update(sensitiveFinding).set({ lastSeenAt: now }).where(eq(sensitiveFinding.id, found.id));
      }
    }
    const gone = existing.filter((f) => f.status === "open" && !seen.has(`${f.kind}:${f.fingerprint}`)).map((f) => f.id);
    if (gone.length) await tx.update(sensitiveFinding).set({ status: "resolved", resolvedAt: now }).where(inArray(sensitiveFinding.id, gone));
    await tx.execute(sql`
      insert into ${sensitiveScan} (page_id, workspace_id, source_updated_at, scanned_at)
      values (${candidate.id}, ${candidate.workspaceId}, ${candidate.version}::timestamptz, ${now.toISOString()}::timestamptz)
      on conflict (page_id) do update set source_updated_at = excluded.source_updated_at, scanned_at = excluded.scanned_at
    `);
    return opened;
  });
}

/** Records what opened in the audit log, and tells the owners of each kind not told about on this page today. */
async function announce(candidate: Candidate, opened: Opened[], now: Date) {
  await recordAudit(
    opened.map((f) => ({
      workspaceId: candidate.workspaceId,
      actorId: null,
      action: "sensitive_content.found" as const,
      target: { type: "page" as const, id: candidate.id, label: candidate.title },
      details: { kind: f.kind, excerpt: f.excerpt, findingId: f.id },
    })),
  );
  for (const kind of new Set(opened.map((f) => f.kind))) {
    const [told] = await db
      .select({ id: sensitiveFinding.id })
      .from(sensitiveFinding)
      .where(
        and(
          eq(sensitiveFinding.pageId, candidate.id),
          eq(sensitiveFinding.kind, kind),
          gt(sensitiveFinding.notifiedAt, new Date(now.getTime() - NOTIFY_EVERY_MS)),
        ),
      )
      .limit(1);
    if (told) continue;
    await db
      .update(sensitiveFinding)
      .set({ notifiedAt: now })
      .where(inArray(sensitiveFinding.id, opened.filter((f) => f.kind === kind).map((f) => f.id)));
    await recordSensitiveContent(candidate.workspaceId, candidate.id, kind);
  }
}

/** One round as of `now`: changed pages are read and their findings settled. Returns how many pages were read. */
export async function runSensitiveContentScans(now: Date = new Date(), limit = ROUND_PAGES) {
  const candidates = await changedPages(limit);
  let read = 0;
  for (const candidate of candidates) {
    try {
      const opened = await scanPage(candidate, now);
      if (opened === null) continue;
      read++;
      if (opened.length) await announce(candidate, opened, now);
    } catch (error) {
      // A page deleted meanwhile has nothing left to record.
      if ((error as { code?: string }).code !== "23503") console.error("[sensitive-content] could not scan a page", error);
    }
  }
  return read;
}

/** Starts the scanner. */
export function startSensitiveContentScans() {
  return startSweep(SWEEP_INTERVAL_MS, () => runSensitiveContentScans(), "could not scan for sensitive content");
}

// ------------------------------------------------------------------------------------ owners

export type SensitiveFindingView = {
  id: string;
  kind: SensitiveKind;
  excerpt: string;
  foundAt: string;
  lastSeenAt: string;
  page: { id: string; title: string; icon: string | null; kind: string };
};

/** The open findings of pages out of the trash, newest first (up to LIST_LIMIT), and how many there are. Owners only. */
export async function listSensitiveFindings(actorId: string, workspaceId: string): Promise<{ findings: SensitiveFindingView[]; total: number }> {
  await requireMembership(actorId, workspaceId, "owner");
  const where = and(eq(sensitiveFinding.workspaceId, workspaceId), eq(sensitiveFinding.status, "open"), isNull(page.archivedAt));
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ finding: sensitiveFinding, title: page.title, icon: page.icon, kind: page.kind })
      .from(sensitiveFinding)
      .innerJoin(page, eq(page.id, sensitiveFinding.pageId))
      .where(where)
      .orderBy(desc(sensitiveFinding.foundAt), desc(sensitiveFinding.id))
      .limit(LIST_LIMIT),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(sensitiveFinding)
      .innerJoin(page, eq(page.id, sensitiveFinding.pageId))
      .where(where),
  ]);
  return {
    total,
    findings: rows.map(({ finding, title, icon, kind }) => ({
      id: finding.id,
      kind: finding.kind,
      excerpt: finding.excerpt,
      foundAt: finding.foundAt.toISOString(),
      lastSeenAt: finding.lastSeenAt.toISOString(),
      page: { id: finding.pageId, title: pageLabel(title), icon, kind },
    })),
  };
}

/**
 * Dismisses an open finding: it leaves the list, and stays dismissed while the page holds the
 * value. Recorded in the audit log. Owners only; AccessError for a finding of another workspace.
 */
export async function dismissSensitiveFinding(actorId: string, workspaceId: string, findingId: string) {
  await requireMembership(actorId, workspaceId, "owner");
  const [updated] = await db
    .update(sensitiveFinding)
    .set({ status: "dismissed", dismissedAt: new Date(), dismissedBy: actorId })
    .where(and(eq(sensitiveFinding.id, findingId), eq(sensitiveFinding.workspaceId, workspaceId), eq(sensitiveFinding.status, "open")))
    .returning();
  if (!updated) throw new AccessError();
  await recordAudit({
    workspaceId,
    actorId,
    action: "sensitive_content.dismissed",
    target: { type: "page", id: updated.pageId },
    details: { kind: updated.kind, excerpt: updated.excerpt, findingId: updated.id },
  });
}
