/**
 * End-to-end check of verified pages against the database: who may verify a page and what is
 * refused; the badge's data (who, until when, expired) and editing keeping it; search ranking a
 * verified page above an otherwise equal one and `is:verified`; MCP's get_page / update_page;
 * reminders before the end and at it (inbox and email, once each), not for pages the verifier
 * can no longer open; the workspace check's expired verifications; the audit log.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/verify-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own reminder sweep would send the reminders.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, notification, page, pageVerification, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createPage, archivePage, searchWithQuery } = await import("@/server/pages");
const verification = await import("@/server/verification");
const ops = await import("@/server/operations");
const { checkWorkspace } = await import("@/server/workspace-check");
const { flushShareEmails, setShareMailer } = await import("@/server/share-emails");
const { getPageHeaderInfo } = await import("@/server/page-meta");
const { AccessError } = await import("@/server/access");
const { REMIND_BEFORE_MS } = await import("@/lib/verification");

const RUN = `verify-e2e-${Date.now().toString(36)}`;

registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async disconnectLostAccess() {},
  async replaceContent() {},
  async setTitle() {},
  async pageVersion() {
    return "v1";
  },
  async readPage() {
    return { title: "", markdown: "" };
  },
  async blockMarkdown() {
    return [];
  },
} as unknown as Parameters<typeof registerCollab>[0]);

const sent: { to: string; subject: string; text: string }[] = [];
setShareMailer(async (mail) => void sent.push(mail));

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

async function refused(promise: Promise<unknown>, code: string) {
  return promise.then(
    () => false,
    (error: unknown) => (code === "access" ? error instanceof AccessError : (error as { code?: string }).code === code),
  );
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const DAY = 86_400_000;

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const owner = { userId: ids.owner };

  // ------------------------------------------------------------------------------ verifying
  const handbook = await createPage(owner, { workspaceId, title: "Expense policy" });
  const copy = await createPage(owner, { workspaceId, title: "Expense policy" });
  await db.update(page).set({ contentText: "expense policy travel receipts", contentMarkdown: "expense policy travel receipts" }).where(inArray(page.id, [handbook.id, copy.id]));
  const secret = await createPage(owner, { workspaceId, title: "Owner only", teamspaceId: null });

  check(await refused(verification.setPageVerification(ids.member, secret.id, null), "access"), "someone without full access can't verify a page");
  const month = new Date(Date.now() + 30 * DAY);
  const set = await verification.setPageVerification(ids.owner, handbook.id, month);
  check(set.verification?.by === "Owner Olcay" && !set.verification.expired && set.verification.until === month.toISOString(), "full access verifies a page until a time", set.verification);
  const header = await getPageHeaderInfo(ids.owner, handbook.id);
  check(header.verified?.byId === ids.owner, "the page header carries who verified it", header.verified);
  await db.update(page).set({ contentText: "expense policy travel receipts 2026", updatedAt: new Date() }).where(eq(page.id, handbook.id));
  check((await verification.verificationOf(handbook.id))?.until === month.toISOString(), "editing the page keeps it verified");
  // The same title and text again, and the unverified copy edited last: only being verified puts the handbook first.
  await db.update(page).set({ contentText: "expense policy travel receipts", updatedAt: new Date(Date.now() + 60_000) }).where(eq(page.id, copy.id));
  await db.update(page).set({ contentText: "expense policy travel receipts" }).where(eq(page.id, handbook.id));

  const template = await createPage(owner, { workspaceId, title: "A template", template: true });
  check(await refused(verification.setPageVerification(ids.owner, template.id, null), "template"), "templates aren't verified");
  const trashed = await createPage(owner, { workspaceId, title: "Old" });
  await archivePage(ids.owner, trashed.id);
  check(await refused(verification.setPageVerification(ids.owner, trashed.id, null), "inTrash"), "pages in the trash aren't verified");

  const audited = await db.select({ action: auditEvent.action }).from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "page.verified")));
  check(audited.length === 1, "verifying goes into the audit log", audited);

  // -------------------------------------------------------------------------------- search
  const hits = await searchWithQuery(ids.owner, workspaceId, "expense policy");
  const order = hits.map((h) => h.id).filter((id) => id === handbook.id || id === copy.id);
  check(order[0] === handbook.id && hits.find((h) => h.id === handbook.id)?.verified === true, "search ranks the verified page above an otherwise equal one and marks it", hits.map((h) => [h.id === handbook.id ? "handbook" : h.id === copy.id ? "copy" : h.title, h.verified]));
  const onlyVerified = await searchWithQuery(ids.owner, workspaceId, "is:verified");
  check(onlyVerified.length === 1 && onlyVerified[0].id === handbook.id, "is:verified lists only verified pages", onlyVerified.map((h) => h.title));

  // ----------------------------------------------------------------------------------- MCP
  const ctx = { userId: ids.owner, actor: { userId: ids.owner } };
  const read = (await ops.getPage(ctx, { page_id: handbook.id, offset: 0 })) as { verified: { by: string; until: string; expired: boolean } | null };
  check(read.verified?.by === "Owner Olcay" && read.verified.expired === false, "get_page says verified", read.verified);
  await ops.updatePage(ctx, { page_id: copy.id, verified: "forever" } as Parameters<typeof ops.updatePage>[1]);
  check((await verification.verificationOf(copy.id))?.until === null, "update_page verifies with no end");
  await ops.updatePage(ctx, { page_id: copy.id, verified: "none" } as Parameters<typeof ops.updatePage>[1]);
  check((await verification.verificationOf(copy.id)) === null, "…and verified: none removes it");
  const unverified = await db.select({ action: auditEvent.action }).from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "page.unverified")));
  check(unverified.length === 1, "removing it goes into the audit log too");

  // ------------------------------------------------------------------------------ reminders
  const soonPage = await createPage(owner, { workspaceId, title: "Soon" });
  const now = new Date();
  const end = new Date(now.getTime() + 10 * DAY);
  await verification.setPageVerification(ids.owner, soonPage.id, end);
  check((await verification.runVerificationReminders(now)).soon === 0, "no reminder while the end is far off");
  const inReach = new Date(end.getTime() - REMIND_BEFORE_MS + 3_600_000);
  const first = await verification.runVerificationReminders(inReach);
  check(first.soon === 1, "a reminder goes out a few days before the end", first);
  check((await verification.runVerificationReminders(inReach)).soon === 0, "…once");
  const inbox = await db.select().from(notification).where(and(eq(notification.userId, ids.owner), eq(notification.kind, "verification")));
  check(inbox.length === 1 && inbox[0].pageId === soonPage.id, "the verifier finds it in the inbox", inbox);
  await flushShareEmails();
  check(sent.some((m) => m.to === `${ids.owner}@example.test` && m.text.includes("Soon")), "…and by email", sent.map((m) => m.subject));

  const after = new Date(end.getTime() + 3_600_000);
  const ended = await verification.runVerificationReminders(after);
  check(ended.ended === 1, "when the end comes, the verifier hears again", ended);
  check((await verification.runVerificationReminders(after)).ended === 0, "…once");
  const expiredView = await verification.verificationOf(soonPage.id);
  check(expiredView?.until === end.toISOString(), "reminding leaves the verification and its end as they were", expiredView);
  // Make it expired as of the real clock too, for the workspace check.
  await db.update(pageVerification).set({ expiresAt: sql`now() - interval '1 day'` }).where(eq(pageVerification.pageId, soonPage.id));
  check((await verification.verificationOf(soonPage.id))?.expired === true, "a verification past its end reads as expired");
  const noLonger = await searchWithQuery(ids.owner, workspaceId, "is:verified");
  check(!noLonger.some((h) => h.id === soonPage.id), "…and is:verified leaves it out");
  const health = await checkWorkspace(ids.owner, workspaceId);
  check(health.expiredVerifications.items.some((p) => p.id === soonPage.id), "the workspace check lists expired verifications", health.expiredVerifications);

  // A page the verifier can no longer open: no reminder.
  const shared = await createPage({ userId: ids.member }, { workspaceId, title: "Mert's", teamspaceId: null });
  await db.insert(pageVerification).values({ pageId: shared.id, workspaceId, verifiedBy: ids.owner, expiresAt: new Date(Date.now() + DAY) });
  await verification.runVerificationReminders(new Date());
  const none = await db.select().from(notification).where(and(eq(notification.userId, ids.owner), eq(notification.pageId, shared.id)));
  check(none.length === 0, "nobody hears about a page they can no longer open", none);

  console.log(`\n${passed} checks passed`);
} finally {
  setShareMailer(null);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
