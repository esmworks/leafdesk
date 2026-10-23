/**
 * End-to-end check of automations' approval step against the database: a run that asks the people
 * named and the row's people under For review and waits; approving goes on with the next steps
 * (which read who approved), rejecting stops the run; nobody answering in time stops it or lets it
 * go on, as set; only the people asked can answer, nobody can edit it, and answers are final and
 * audited; a run taken again, woken twice or restarted after asking asks only once; test runs ask
 * nobody; the checks on saving; MCP's arguments and descriptions. Creates its own users and
 * workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/automation-approval-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own automation worker would take the queued runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, automationRun, notification, page, pendingChange, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, createRows, updateRowProperties } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const manage = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");
const { wakeRun } = await import("@/server/automations/queue");
const reviews = await import("@/server/pending-changes");
const { toAutomationInput } = await import("@/server/mcp/automations");
const { describePendingChange } = await import("@/server/mcp/reviews");
const { AccessError } = await import("@/server/access");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `automation-approval-e2e-${Date.now().toString(36)}`;

registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async disconnectLostAccess() {},
  async replaceContent() {},
  async setTitle(pageId: string, title: string) {
    await db.update(page).set({ title }).where(eq(page.id, pageId));
  },
} as unknown as Parameters<typeof registerCollab>[0]);

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

async function refused(promise: Promise<unknown>, reason?: RegExp) {
  return promise.then(
    () => false,
    (error: unknown) => error instanceof PropertyValueError && error.code === "invalidAutomation" && (!reason || reason.test(String(error.params?.reason ?? error.message))),
  );
}
/** The error a review answer fails with: its code, or "access" for AccessError. */
async function answerError(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (error: unknown) => (error instanceof reviews.PendingChangeError ? error.code : error instanceof AccessError ? "access" : String(error)),
  );
}

const ids = { owner: `${RUN}-owner`, approver: `${RUN}-approver`, other: `${RUN}-other` };
const workspaceId = `${RUN}-ws`;

const runsOf = (automationId: string) => db.select().from(automationRun).where(eq(automationRun.automationId, automationId)).orderBy(automationRun.createdAt);
const runOf = async (runId: string) => (await db.select().from(automationRun).where(eq(automationRun.id, runId)))[0];
const changesOf = (runId: string) => db.select().from(pendingChange).where(eq(pendingChange.automationRunId, runId));
async function propertiesOf(rowId: string) {
  const [row] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId));
  return row.properties;
}
/** Moves an approval's expiry (and its run's next look) into the past, as if its days went by. */
async function timeGoesBy(runId: string) {
  await db.update(pendingChange).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(pendingChange.automationRunId, runId));
  await db.update(automationRun).set({ nextAt: sql`now()` }).where(eq(automationRun.id, runId));
}

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.approver, name: "Approver Ayla", email: `${ids.approver}@example.test` },
    { id: ids.other, name: "Other Onur", email: `${ids.other}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.approver, role: "guest" },
    { workspaceId, userId: ids.other, role: "member" },
  ]);
  const deals = await createPage({ userId: ids.owner }, { workspaceId, kind: "database", title: "Deals" });
  const stage = await addProperty(ids.owner, deals.id, { name: "Stage", type: "select", options: ["Open", "Review", "Won", "Lost"] });
  await addProperty(ids.owner, deals.id, { name: "Owner", type: "person" });
  await addProperty(ids.owner, deals.id, { name: "Note", type: "text" });
  const option = (name: string) => stage.options.options!.find((o) => o.name === name)!.id;
  // The approver is a guest who can edit the deals, not manage the database (nor see its runs).
  await setPagePermission(ids.owner, deals.id, ids.approver, "edit");

  // ------------------------------------------------------------------ the checks on saving
  const save = (actions: unknown[], trigger: unknown = { type: "row_created" }) =>
    manage.createAutomation(ids.owner, deals.id, { name: "x", trigger, actions } as Parameters<typeof manage.createAutomation>[2]);
  check(await refused(save([{ type: "approval", message: "x" }]), /people to ask|who to ask|ask/i), "an approval needs people to ask");
  check(await refused(save([{ type: "approval", people: [ids.approver], timeoutDays: 31 }])), "…and at most 30 days");
  check(await refused(save([{ type: "approval", people: [ids.approver], timeoutDays: 0 }])), "…and at least a day");
  check(await refused(save([{ type: "approval", people: [ids.approver], onTimeout: "later" }])), "…and stops or goes on without an answer, nothing else");
  check(
    await refused(
      save([{ id: "all", type: "find_rows", database: "Deals" }, { type: "approval", people: [ids.approver], forEach: "all" }], { type: "schedule", schedule: { frequency: "daily", time: "09:00" } }),
      /for each/,
    ),
    "an approval can't go for each found row",
  );
  check(
    await refused(save([{ type: "approval", properties: ["Owner"] }], { type: "schedule", schedule: { frequency: "daily", time: "09:00" } }), /has no row/),
    "an automation without a row can't ask a row's people",
  );

  // ------------------------------------------------------------------ approving goes on
  const closing = await manage.createAutomation(ids.owner, deals.id, {
    name: "Approve before closing",
    trigger: { type: "property_changed", properties: ["Stage"], to: "Review" },
    actions: [
      { id: "approval", type: "approval", people: [ids.approver], properties: ["Owner"], message: "Can {{trigger.title}} be closed?", timeoutDays: 3 },
      { type: "set_properties", values: { Stage: "Won" } },
      { type: "log", message: "approved by {{approval.approved_by}} at {{approval.answered_at}}" },
    ],
  });
  check(closing.actions[0].type === "approval" && closing.actions[0].timeoutDays === 3 && closing.actions[0].onTimeout === "stop", "an approval is saved, stopping without an answer by default", closing.actions[0]);
  const [deal] = await createRows(ids.owner, deals.id, [{ title: "Deal one", properties: { Stage: "Open", Owner: [ids.owner] } }]);
  await updateRowProperties(ids.owner, deal.id, { Stage: "Review" });
  await flushAutomations();
  const [run] = await runsOf(closing.id);
  check(run.status === "pending" && run.steps[0].status === "pending" && run.steps[1].status === "pending", "the run waits at the approval", run.steps);
  const [asked] = await changesOf(run.id);
  check(
    asked &&
      asked.kind === "automation_approval" &&
      asked.status === "pending" &&
      asked.rowId === deal.id &&
      asked.automationId === closing.id &&
      asked.databaseId === deals.id,
    "it asks under For review, for the run, its automation and its row",
    asked,
  );
  const payload = asked.payload as { message: string; approverIds: string[]; version: number; nextSteps: { type: string }[] };
  check(payload.message === "Can Deal one be closed?" && payload.version === run.version, "…with the message written in, and the version the run is pinned to", payload);
  check([...payload.approverIds].sort().join() === [ids.approver, ids.owner].sort().join(), "…asking the people named and the row's people", payload.approverIds);
  check(payload.nextSteps.map((s) => s.type).join() === "set_properties,log", "…and says what the next steps do", payload.nextSteps);
  const days = (asked.expiresAt.getTime() - Date.now()) / 86_400_000;
  check(days > 2.9 && days <= 3, "…for the days set", days);
  check(run.steps[0].approval?.changeId === asked.id && run.steps[0].approval.approvers.length === 2, "the step keeps whom it asked", run.steps[0].approval);
  const told = await db.select().from(notification).where(and(eq(notification.workspaceId, workspaceId), eq(notification.kind, "review")));
  check(told.some((n) => n.userId === ids.approver) && told.some((n) => n.userId === ids.owner) && !told.some((n) => n.userId === ids.other), "the people asked are notified, nobody else", told);
  check((await reviews.countPendingFor(ids.approver, workspaceId)) === 1 && (await reviews.countPendingFor(ids.other, workspaceId)) === 0, "it counts as waiting for the people asked only");

  // Taken again while it waits: nothing new.
  await db.update(automationRun).set({ nextAt: sql`now()` }).where(eq(automationRun.id, run.id));
  await flushAutomations();
  await flushAutomations();
  check((await changesOf(run.id)).length === 1 && (await runOf(run.id)).status === "pending", "a run taken again while it waits asks once");
  check((await runOf(run.id)).steps[0].attempts === 1, "…and the wait isn't counted as tries", (await runOf(run.id)).steps[0]);

  // A restart between asking and saving the run: it finds what it asked.
  await db
    .update(automationRun)
    .set({ nextAt: sql`now()`, steps: sql`jsonb_set(steps, '{0}', (steps->0) - 'approval')` })
    .where(eq(automationRun.id, run.id));
  await flushAutomations();
  check((await changesOf(run.id)).length === 1 && (await runOf(run.id)).steps[0].approval?.changeId === asked.id, "a run restarted after it asked finds its question instead of asking again");

  const shown = await reviews.getPendingChange(ids.approver, asked.id);
  check(
    shown?.approval?.message === "Can Deal one be closed?" &&
      shown.approval.automation?.name === "Approve before closing" &&
      shown.approval.runId === run.id &&
      shown.approval.nextSteps.length === 2 &&
      shown.approval.approvers.some((a) => a.name === "Approver Ayla") &&
      shown.canApprove,
    "the approver sees the message, the automation, the run, the next steps and can answer",
    shown,
  );
  check(shown.approval.runPath === null, "…and the run's link only shows with full access to the database", shown.approval.runPath);
  const ownerView = await reviews.getPendingChange(ids.owner, asked.id);
  check(ownerView?.approval?.runPath?.includes(`run=${run.id}`), "the database's owner gets the link to the run", ownerView?.approval);
  const otherView = await reviews.getPendingChange(ids.other, asked.id);
  check(otherView !== null && !otherView.canApprove, "someone who can see the row but wasn't asked sees it read-only", otherView);
  check((await answerError(reviews.approvePendingChange(ids.other, asked.id))) !== null, "…and can't approve it");
  check((await answerError(reviews.dismissPendingChange(ids.other, asked.id))) !== null, "…nor reject it");
  check((await answerError(reviews.editPendingChange(ids.approver, asked.id, { title: "x" }))) === "invalid", "nobody can edit an approval");
  const described = describePendingChange(shown) as { approval?: { message: string; next_steps: unknown[] } };
  check(described.approval?.message === "Can Deal one be closed?" && described.approval.next_steps.length === 2, "MCP describes the approval and what comes next", described);

  const approved = await reviews.approvePendingChange(ids.approver, asked.id);
  check(approved.status === "approved", "the approver approves");
  check((await answerError(reviews.approvePendingChange(ids.owner, asked.id))) === "decided", "an answer is final: the other person asked can't answer again");
  check((await answerError(reviews.dismissPendingChange(ids.approver, asked.id))) === "decided", "…nor can the approver take it back");
  await wakeRun(run.id);
  await flushAutomations();
  await flushAutomations();
  const done = await runOf(run.id);
  check(done.status === "done" && done.steps.every((s) => s.status === "done"), "the run goes on from the next step", done.steps);
  check((await propertiesOf(deal.id))[stage.id] === option("Won"), "…which sets the stage");
  const logged = (done.steps[2].output as { message: string }).message;
  check(logged.startsWith("approved by Approver Ayla at 20"), "later steps read who approved and when", logged);
  check(done.steps[0].approval?.answer === "approved" && done.steps[0].approval.answeredBy?.id === ids.approver, "the history says who approved", done.steps[0].approval);
  const audited = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "review.approved")));
  check(
    audited.length === 1 && audited[0].actorUserId === ids.approver && audited[0].details.kind === "automation_approval" && audited[0].details.automationRunId === run.id,
    "the answer is in the audit log, with the automation's run",
    audited,
  );
  const listed = await manage.listAutomationRuns(ids.owner, closing.id);
  check(listed[0].status === "done" && listed[0].steps[0].approval?.answer === "approved", "the run history shows the approval");
  // Woken again after it ended: nothing runs twice.
  await updateRowProperties(ids.owner, deal.id, { Note: "kept" });
  await wakeRun(run.id);
  await flushAutomations();
  check((await runsOf(closing.id)).length === 1 && (await runOf(run.id)).steps[2].attempts === 1, "a finished run woken again doesn't run again");

  // ------------------------------------------------------------------ rejecting stops
  const [second] = await createRows(ids.owner, deals.id, [{ title: "Deal two", properties: { Stage: "Open" } }]);
  await updateRowProperties(ids.owner, second.id, { Stage: "Review" });
  await flushAutomations();
  const secondRun = (await runsOf(closing.id)).find((r) => r.rowId === second.id)!;
  const [secondAsked] = await changesOf(secondRun.id);
  check((secondAsked.payload as { approverIds: string[] }).approverIds.join() === ids.approver, "a row without people asks the people named only");
  await reviews.dismissPendingChange(ids.approver, secondAsked.id);
  await flushAutomations();
  const rejected = await runOf(secondRun.id);
  check(rejected.status === "stopped" && rejected.steps[0].status === "stopped" && rejected.steps[0].code === "rejected", "rejecting stops the run", rejected.steps);
  check(rejected.steps.slice(1).every((s) => s.status === "skipped"), "…skipping the steps after it", rejected.steps);
  check(rejected.steps[0].approval?.answer === "rejected" && rejected.steps[0].approval.answeredBy?.id === ids.approver, "…recorded as rejected by that person", rejected.steps[0].approval);
  check((await propertiesOf(second.id))[stage.id] === option("Review"), "…and the stage stays");
  const dismissedAudit = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "review.dismissed")));
  check(dismissedAudit.length === 1 && dismissedAudit[0].details.automation === "Approve before closing", "rejecting is audited too", dismissedAudit);

  // ------------------------------------------------------------------ nobody answers: stop
  const [third] = await createRows(ids.owner, deals.id, [{ title: "Deal three", properties: { Stage: "Open" } }]);
  await updateRowProperties(ids.owner, third.id, { Stage: "Review" });
  await flushAutomations();
  const thirdRun = (await runsOf(closing.id)).find((r) => r.rowId === third.id)!;
  const [thirdAsked] = await changesOf(thirdRun.id);
  check(
    thirdRun.status === "pending" && Math.abs(thirdRun.nextAt.getTime() - thirdAsked.expiresAt.getTime()) < 5_000,
    "a waiting run looks again when its approval expires",
    { nextAt: thirdRun.nextAt, expiresAt: thirdAsked.expiresAt },
  );
  await timeGoesBy(thirdRun.id);
  await flushAutomations();
  const timedOut = await runOf(thirdRun.id);
  check(timedOut.status === "stopped" && timedOut.steps[0].code === "timedOut" && timedOut.steps[0].approval?.answer === "timedOut", "unanswered in time, it stops", timedOut.steps);
  check((await changesOf(thirdRun.id))[0].status === "expired", "…and its question expires");
  check((await propertiesOf(third.id))[stage.id] === option("Review"), "…without the next steps");

  // ------------------------------------------------------------------ nobody answers: go on (as MCP writes it)
  const goOn = await manage.createAutomation(
    ids.owner,
    deals.id,
    await toAutomationInput(ids.owner, {
      name: "Go on anyway",
      trigger: { type: "property_changed", properties: ["Note"] },
      actions: [
        { id: "ask", type: "approval", people: [ids.approver], message: "Note changed", timeout_days: 1, on_timeout: "continue" },
        { type: "set_properties", values: { Stage: "Lost" } },
      ],
    } as Parameters<typeof toAutomationInput>[1]),
  );
  check(goOn.actions[0].type === "approval" && goOn.actions[0].onTimeout === "continue" && goOn.actions[0].timeoutDays === 1, "MCP's arguments save an approval", goOn.actions[0]);
  await updateRowProperties(ids.owner, third.id, { Note: "hello" });
  await flushAutomations();
  const [goOnRun] = await runsOf(goOn.id);
  check(goOnRun.status === "pending", "it waits");
  // The daily cleanup expires it; the run reads that when it looks again.
  await reviews.expirePendingChanges({ now: new Date(Date.now() + 2 * 86_400_000), workspaceIds: [workspaceId] });
  await db.update(automationRun).set({ nextAt: sql`now()` }).where(eq(automationRun.id, goOnRun.id));
  await flushAutomations();
  const wentOn = await runOf(goOnRun.id);
  check(wentOn.status === "done" && wentOn.steps[0].status === "done" && wentOn.steps[0].code === "timedOut", "unanswered in time, it goes on when set to", wentOn.steps);
  check((wentOn.steps[0].output as { timed_out?: boolean; approved_by: unknown }).timed_out === true, "…its output saying nobody answered", wentOn.steps[0].output);
  check((await propertiesOf(third.id))[stage.id] === option("Lost"), "…and the next step runs");
  await manage.deleteAutomation(ids.owner, goOn.id);

  // ------------------------------------------------------------------ test runs ask nobody
  const [fourth] = await createRows(ids.owner, deals.id, [{ title: "Deal four", properties: { Stage: "Open", Owner: [ids.owner] } }]);
  const before = (await db.select({ id: pendingChange.id }).from(pendingChange).where(eq(pendingChange.workspaceId, workspaceId))).length;
  const { runId: testId } = await manage.testAutomation(ids.owner, closing.id, { rowId: fourth.id });
  await flushAutomations();
  const tested = await runOf(testId);
  check(tested.status === "done" && tested.steps[0].status === "skipped" && tested.steps[0].approval?.test === true, "a test run skips the approval", tested.steps);
  check(tested.steps[0].approval.approvers.length === 2 && tested.steps.slice(1).every((s) => s.status === "done"), "…saying whom it would ask, and goes on", tested.steps);
  const after = (await db.select({ id: pendingChange.id }).from(pendingChange).where(eq(pendingChange.workspaceId, workspaceId))).length;
  check(after === before && (await changesOf(testId)).length === 0, "…asking nobody");

  // ------------------------------------------------------------------ nobody to ask
  const rowPeople = await manage.createAutomation(ids.owner, deals.id, {
    name: "Ask the owner",
    trigger: { type: "row_created" },
    actions: [{ type: "approval", properties: ["Owner"] }, { type: "log", message: "never" }],
  });
  const [ownerless] = await createRows(ids.owner, deals.id, [{ title: "Nobody's" }]);
  await flushAutomations();
  const failed = (await runsOf(rowPeople.id)).find((r) => r.rowId === ownerless.id)!;
  check(failed.status === "failed" && failed.steps[0].code === "noApprovers" && /Nobody to ask/.test(failed.steps[0].error ?? ""), "a run with nobody to ask fails, saying why", failed.steps);
  check((await changesOf(failed.id)).length === 0, "…without asking");
  await manage.deleteAutomation(ids.owner, rowPeople.id);

  // ------------------------------------------------------------------ a run that ends otherwise
  const [fifth] = await createRows(ids.owner, deals.id, [{ title: "Deal five", properties: { Stage: "Open" } }]);
  await updateRowProperties(ids.owner, fifth.id, { Stage: "Review" });
  await flushAutomations();
  const fifthRun = (await runsOf(closing.id)).find((r) => r.rowId === fifth.id)!;
  await manage.updateAutomation(ids.owner, closing.id, { enabled: false });
  await db.update(automationRun).set({ nextAt: sql`now()` }).where(eq(automationRun.id, fifthRun.id));
  await flushAutomations();
  const ended = await runOf(fifthRun.id);
  const [closed] = await changesOf(fifthRun.id);
  check(ended.status !== "pending" && closed.status === "expired", "turning the automation off ends a waiting run and closes its question", { status: ended.status, change: closed.status });
  check((await answerError(reviews.approvePendingChange(ids.approver, closed.id))) === "decided", "…which can't be approved any more");
  const deletedChange = inArray(pendingChange.automationRunId, [run.id]);
  await manage.deleteAutomation(ids.owner, closing.id);
  check((await db.select().from(pendingChange).where(deletedChange)).length === 0, "deleting the automation removes its questions");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
