/**
 * End-to-end check of reports about published pages: a visitor reports a published page or one of
 * its subpages, the workspace's owners hear about it in their inbox (once a day per page) and see
 * it in their list, dismiss it or take the page off the web; reports about pages that aren't
 * served, filled-in honeypots and too many reports from one address go nowhere.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/page-reports-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, notification, pageReport, user, workspace, workspaceMember } = await import("@/db/schema");
const { getPublishedPage, publishPage } = await import("@/server/publication");
const { createPage } = await import("@/server/pages");
const { handlePageReport, listPageReports, reportPublishedPage, resetReportRateLimits, ReportError, REPORT_RATE_LIMITS } = await import(
  "@/server/page-reports"
);
const { AccessError } = await import("@/server/access");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");

const RUN = `page-reports-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);

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

async function failsWith(fn: () => Promise<unknown>, kind: typeof AccessError | typeof ReportError) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof kind;
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const reportsOf = (pageId: string) => db.select().from(pageReport).where(eq(pageReport.pageId, pageId));
const inboxOf = (userId: string) =>
  db.select().from(notification).where(and(eq(notification.userId, userId), eq(notification.kind, "page_reported")));

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const home = await createPage(actor, { workspaceId, title: "Handbook" });
  const sub = await createPage(actor, { workspaceId, parentId: home.id, title: "Holidays" });
  const hidden = await createPage(actor, { workspaceId, title: "Not on the web" });
  const { token } = await publishPage(ids.owner, home.id);
  check(await getPublishedPage(token, sub.id), "the subpage is served under the publication");
  resetReportRateLimits();

  // Reporting
  await reportPublishedPage(token, sub.id, { reason: "spam", details: "  Ads everywhere  ", email: "visitor@example.test" }, { ip: "203.0.113.1" });
  const [first] = await reportsOf(sub.id);
  check(
    first?.reason === "spam" && first.details === "Ads everywhere" && first.email === "visitor@example.test" && first.publishedPageId === home.id,
    "a visitor reports a subpage of a published page",
    first,
  );
  check(first.workspaceId === workspaceId && first.status === "open" && first.reporterId === null, "the report is the workspace's, open and anonymous", first);
  const ownerInbox = await inboxOf(ids.owner);
  check(ownerInbox.length === 1 && ownerInbox[0].pageId === sub.id && ownerInbox[0].message === "spam", "the owner hears about it in the inbox", ownerInbox);
  check((await inboxOf(ids.member)).length === 0, "members don't");
  const [audited] = await db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "page.reported")));
  check(audited?.actorUserId === null && audited.targetId === sub.id, "the report is in the audit log, by no one", audited);

  await reportPublishedPage(token, sub.id, { reason: "harmful" }, { ip: "203.0.113.2", userId: ids.member });
  check((await reportsOf(sub.id)).length === 2, "a second report is kept");
  check((await inboxOf(ids.owner)).length === 1, "…but owners hear about a page once a day");

  // What goes nowhere
  await reportPublishedPage(token, hidden.id, { reason: "spam" }, { ip: "203.0.113.3" });
  check((await reportsOf(hidden.id)).length === 0, "a page the publication doesn't serve can't be reported");
  await reportPublishedPage("no-such-token", home.id, { reason: "spam" }, { ip: "203.0.113.3" });
  check((await reportsOf(home.id)).length === 0, "an unknown address is dropped without a word");
  await reportPublishedPage(token, home.id, { reason: "spam", honeypot: "https://spam.example" }, { ip: "203.0.113.3" });
  check((await reportsOf(home.id)).length === 0, "a filled-in honeypot is dropped without a word");
  check(await failsWith(() => reportPublishedPage(token, home.id, { reason: "boring" }, { ip: "203.0.113.3" }), ReportError), "a reason must be one of the list");
  check(
    await failsWith(() => reportPublishedPage(token, home.id, { reason: "other", email: "not an address" }, { ip: "203.0.113.3" }), ReportError),
    "an email address must be one",
  );
  resetReportRateLimits();
  for (let i = 0; i < REPORT_RATE_LIMITS.perIp.limit; i++) await reportPublishedPage(token, home.id, { reason: "other" }, { ip: "203.0.113.9" });
  check(
    await failsWith(() => reportPublishedPage(token, home.id, { reason: "other" }, { ip: "203.0.113.9" }), ReportError),
    "one address can't send more than a few reports an hour",
  );
  resetReportRateLimits();

  // Handling
  check(await failsWith(() => listPageReports(ids.member, workspaceId), AccessError), "only owners list reports");
  const listed = await listPageReports(ids.owner, workspaceId);
  check(listed.total === 2 + REPORT_RATE_LIMITS.perIp.limit && listed.reports.every((r) => r.published), "owners list the open reports", listed.total);
  const spam = listed.reports.find((r) => r.id === first.id)!;
  check(spam.page.title === "Holidays" && spam.publishedPageId === home.id, "…with the page and its publication", spam);
  check(await failsWith(() => handlePageReport(ids.member, workspaceId, first.id, "dismiss"), AccessError), "members can't dismiss a report");
  await handlePageReport(ids.owner, workspaceId, first.id, "dismiss");
  check((await reportsOf(sub.id)).find((r) => r.id === first.id)?.status === "dismissed", "an owner dismisses a report");
  check(await failsWith(() => handlePageReport(ids.owner, workspaceId, first.id, "dismiss"), AccessError), "a handled report can't be handled again");
  const other = listed.reports.find((r) => r.page.id === sub.id && r.id !== first.id)!;
  await handlePageReport(ids.owner, workspaceId, other.id, "unpublish");
  check(!(await getPublishedPage(token)), "taking the page off the web unpublishes its publication");
  const after = await listPageReports(ids.owner, workspaceId);
  check(after.total === 0, "…and closes every open report it served", after.total);
  const closed = await db.select().from(pageReport).where(inArray(pageReport.pageId, [home.id, sub.id]));
  check(closed.filter((r) => r.status === "unpublished").length === 1 + REPORT_RATE_LIMITS.perIp.limit, "those reports read as unpublished");
  await reportPublishedPage(token, home.id, { reason: "spam" }, { ip: "203.0.113.4" });
  check((await reportsOf(home.id)).length === REPORT_RATE_LIMITS.perIp.limit, "a page off the web can't be reported");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
