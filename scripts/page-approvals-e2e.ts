/**
 * End-to-end check of page approvals against the database: who may ask (edit access) and whom
 * (people who can open the page); a round of two approvers staying open after one approval and
 * ending approved after the second, its version named and kept; an edit after it showing
 * "changed since approval" and leaving `is:approved`; a comment needed to request changes, which
 * ends the round; people not asked, or asked once already, refused; a new request withdrawing the
 * open one; "any" ending on the first approval; withdrawing; the inbox items to approvers and to the
 * requester; the history and the audit log. Creates its own users and workspace and deletes them
 * afterwards.
 *
 *   pnpm tsx scripts/page-approvals-e2e.ts
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
const { auditEvent, notification, pageApproval, pageSnapshot, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab, getCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage, searchWithQuery } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const approvals = await import("@/server/page-approvals");
const { getPageHeaderInfo } = await import("@/server/page-meta");
const { AccessError } = await import("@/server/access");
const { badgeState } = await import("@/lib/page-approvals");

const RUN = `approvals-e2e-${Date.now().toString(36)}`;

// The real collab service: requests save the page as a version, and edits go through the document.
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

/** Whether `promise` fails with AccessError ("access") or an ApprovalError of `code`. */
async function refused(promise: Promise<unknown>, code: string) {
  return promise.then(
    () => false,
    (error: unknown) => (code === "access" ? error instanceof AccessError : (error as { code?: string }).code === code),
  );
}

const ids = { owner: `${RUN}-owner`, alice: `${RUN}-alice`, bob: `${RUN}-bob`, carol: `${RUN}-carol`, dave: `${RUN}-dave` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const actor = { userId: ids.owner };

const notices = (pageId: string, kind: "approval_requested" | "approval_decided") =>
  db.select({ userId: notification.userId, message: notification.message }).from(notification).where(and(eq(notification.pageId, pageId), eq(notification.kind, kind)));
const statusOf = async (id: string) => (await db.select({ status: pageApproval.status }).from(pageApproval).where(eq(pageApproval.id, id)))[0]?.status;
const header = async (userId: string, pageId: string) => (await getPageHeaderInfo(userId, pageId)).approval;

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.alice, name: "Alice Aksoy", email: `${ids.alice}@example.test` },
    { id: ids.bob, name: "Bob Bilgin", email: `${ids.bob}@example.test` },
    { id: ids.carol, name: "Carol Cengiz", email: `${ids.carol}@example.test` },
    { id: ids.dave, name: "Dave Demir", email: `${ids.dave}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.alice, role: "member" },
    { workspaceId, userId: ids.bob, role: "member" },
    { workspaceId, userId: ids.carol, role: "member" },
    { workspaceId, userId: ids.dave, role: "member" },
  ]);

  // ------------------------------------------------------------------------- who may ask whom
  const secret = await createPage(actor, { workspaceId, title: "Board minutes", teamspaceId: null });
  await setPagePermission(ids.owner, secret.id, ids.carol, "view");
  check(await refused(approvals.requestApproval(ids.carol, secret.id, { approverIds: [ids.owner] }), "access"), "someone who can only read the page can't ask for approval");
  check(await refused(approvals.requestApproval(ids.owner, secret.id, { approverIds: [ids.dave] }), "approvers"), "someone who can't open the page isn't accepted as an approver");
  const candidates = (await approvals.approvalCandidates(ids.owner, secret.id)).map((c) => c.id);
  check(candidates.includes(ids.carol) && !candidates.includes(ids.dave) && !candidates.includes(ids.owner), "the dialog offers only others who can open the page", candidates);
  check(await refused(approvals.requestApproval(ids.owner, secret.id, { approverIds: [ids.owner] }), "approvers"), "the requester isn't their own approver");
  check(await refused(approvals.requestApproval(ids.owner, secret.id, { approverIds: [] }), "approvers"), "a request needs an approver");
  const template = await createPage(actor, { workspaceId, title: "A template", template: true });
  check(await refused(approvals.requestApproval(ids.owner, template.id, { approverIds: [ids.alice] }), "template"), "templates aren't approved");

  // ------------------------------------------------------------------------ a round of two
  const doc = await createPage(actor, { workspaceId, title: "Travel policy" });
  await getCollab().replaceContent(doc.id, "Travel is booked two weeks ahead.\n\nReceipts within a month.", actor);
  const first = await approvals.requestApproval(ids.owner, doc.id, { approverIds: [ids.alice, ids.bob], note: "Ready for review" });
  const [sent] = await db.select({ id: pageSnapshot.id, name: pageSnapshot.name }).from(pageSnapshot).innerJoin(pageApproval, eq(pageApproval.snapshotId, pageSnapshot.id)).where(eq(pageApproval.id, first.id));
  check(sent?.name === "Sent for approval", "asking saves the page as a version named for it", sent);
  const asked = await notices(doc.id, "approval_requested");
  check(asked.length === 2 && asked.some((n) => n.userId === ids.alice) && asked.some((n) => n.userId === ids.bob), "both approvers get an inbox item", asked);

  const forAlice = await header(ids.alice, doc.id);
  check(forAlice?.status === "open" && forAlice.ask?.note === "Ready for review" && forAlice.ask.snapshotId === sent.id && !forAlice.changed, "an approver's header carries the request to decide", forAlice);
  check((await header(ids.owner, doc.id))?.ask === null, "the requester has nothing to decide");

  check(await refused(approvals.decideApproval(ids.dave, first.id, "approved", null), "notApprover"), "someone not asked can't decide");
  check(await refused(approvals.decideApproval(ids.alice, first.id, "changes_requested", "  "), "commentNeeded"), "requesting changes needs a comment");
  check(await refused(approvals.decideApproval(ids.alice, first.id, "maybe", null), "decision"), "an unknown decision is refused");

  const one = await approvals.decideApproval(ids.alice, first.id, "approved", "Looks right");
  check(one.status === "open", "one of two approvals leaves the round open");
  const halfway = await header(ids.owner, doc.id);
  check(halfway?.approvedBy.length === 1 && halfway.total === 2 && badgeState(halfway) === "open", "the badge counts one of two", halfway);
  check(await refused(approvals.decideApproval(ids.alice, first.id, "approved", null), "decided"), "an approver decides once");

  const two = await approvals.decideApproval(ids.bob, first.id, "approved", null);
  check(two.status === "approved" && (await statusOf(first.id)) === "approved", "the second approval ends the round approved");
  const [kept] = await db.select({ name: pageSnapshot.name }).from(pageSnapshot).where(eq(pageSnapshot.id, sent.id));
  check(kept?.name === "Approved", "the version sent is renamed Approved and kept", kept);
  const decided = await notices(doc.id, "approval_decided");
  check(decided.length === 1 && decided[0].userId === ids.owner && decided[0].message === "approved", "the requester hears it was approved", decided);
  check((await notices(doc.id, "approval_requested")).length === 0, "the approvers' unread requests go once the round ends");
  const approved = await header(ids.owner, doc.id);
  check(approved && badgeState(approved) === "approved" && approved.approvedBy.join() === "Alice Aksoy,Bob Bilgin", "the badge says approved, by whom", approved);
  const listed = await searchWithQuery(ids.owner, workspaceId, "is:approved");
  check(listed.length === 1 && listed[0].id === doc.id, "is:approved lists the approved page", listed.map((h) => h.title));

  await getCollab().replaceContent(doc.id, "Travel is booked three weeks ahead.\n\nReceipts within a month.", actor);
  const changed = await header(ids.owner, doc.id);
  check(changed?.changed === true && badgeState(changed) === "changed", "editing after approval shows changed since approval", changed);
  check((await searchWithQuery(ids.owner, workspaceId, "is:approved")).length === 0, "…and is:approved no longer lists it");
  check((await db.select({ id: pageSnapshot.id }).from(pageSnapshot).where(eq(pageSnapshot.id, sent.id))).length === 1, "the approved version stays after the edit");

  // ------------------------------------------------------------ a new request, changes asked
  const second = await approvals.requestApproval(ids.owner, doc.id, { approverIds: [ids.alice, ids.bob] });
  const third = await approvals.requestApproval(ids.owner, doc.id, { approverIds: [ids.alice, ids.bob], rule: "all" });
  check(third.withdrew === second.id && (await statusOf(second.id)) === "withdrawn", "a new request withdraws the open one");
  check(await refused(approvals.decideApproval(ids.alice, second.id, "approved", null), "closed"), "a withdrawn request takes no decisions");
  check((await notices(doc.id, "approval_requested")).length === 2, "the withdrawn round's inbox items are replaced by the new one's");
  const changes = await approvals.decideApproval(ids.alice, third.id, "changes_requested", "Name the booking tool");
  check(changes.status === "changes_requested", "a request for changes ends the round");
  check(await refused(approvals.decideApproval(ids.bob, third.id, "approved", null), "closed"), "…and the others can't approve it after");
  const told = await notices(doc.id, "approval_decided");
  check(told.length === 2 && told.some((n) => n.message === "changes_requested"), "the requester hears changes were requested", told);

  // --------------------------------------------------------------------------- any one, withdraw
  const anyOne = await approvals.requestApproval(ids.owner, doc.id, { approverIds: [ids.alice, ids.bob], rule: "any" });
  const quick = await approvals.decideApproval(ids.bob, anyOne.id, "approved", null);
  check(quick.status === "approved", "with any, the first approval ends the round");
  const pending = await approvals.requestApproval(ids.owner, doc.id, { approverIds: [ids.alice] });
  const onSecret = await approvals.requestApproval(ids.owner, secret.id, { approverIds: [ids.carol] });
  check(await refused(approvals.withdrawApproval(ids.carol, onSecret.id), "notRequester"), "an approver without full access can't withdraw it");
  await approvals.withdrawApproval(ids.owner, onSecret.id);
  await approvals.withdrawApproval(ids.owner, pending.id);
  check((await statusOf(pending.id)) === "withdrawn" && (await notices(doc.id, "approval_requested")).length === 0, "the requester withdraws it, and its inbox item goes");
  const afterWithdraw = await header(ids.owner, doc.id);
  check(afterWithdraw?.id === anyOne.id, "the badge goes back to the latest round not withdrawn", afterWithdraw);

  // ------------------------------------------------------------------------ history and audit
  const history = await approvals.approvalHistory(ids.alice, doc.id);
  check(history.length === 5 && history[0].id === pending.id && history.at(-1)?.id === first.id, "the history lists every round, newest first", history.map((r) => r.status));
  const roundThree = history.find((r) => r.id === third.id);
  check(roundThree?.decisions.some((d) => d.decision === "changes_requested" && d.comment === "Name the booking tool"), "the history keeps comments", roundThree);
  check(await refused(approvals.approvalHistory(ids.dave, secret.id), "access"), "someone who can't open the page can't read its approvals");
  const audit = await db.select({ action: auditEvent.action }).from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), inArray(auditEvent.action, ["page.approval_requested", "page.approval_decided", "page.approval_withdrawn"])));
  const count = (action: string) => audit.filter((a) => a.action === action).length;
  check(count("page.approval_requested") === 6 && count("page.approval_decided") === 4 && count("page.approval_withdrawn") === 3, "requests, decisions and withdrawals go into the audit log", audit);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
