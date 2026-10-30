/**
 * End-to-end check of the "For review" queue (server/pending-changes.ts) against the database,
 * with a fake OpenAI-compatible server scripted per run (src/server/ai/fake-openai.ts): an agent
 * set to propose its row changes gets update_row with a reason and changes nothing; its proposals
 * wait in the queue, a newer one from the same run for the same row taking the older one's place,
 * and the person the run worked for hears about them once in their inbox; whoever may edit the
 * row sees and answers them, someone who may only view sees them but can't; an edit keeps to the
 * values proposed; approving makes the change as the approver, the row's activity crediting the
 * agent, and a row that changed since needs force; a new row is made where the agent proposed it;
 * dismissing makes nothing; unanswered proposals expire and old ones go with the daily cleanup;
 * the audit log records each answer. An agent on a row whose mail goes to someone with a mailbox
 * drafts email with draft_email: a draft that isn't a finished message is refused, one that is
 * waits for its sender alone, answering the row's latest message where there is one; approving
 * queues it from the sender's mailbox, dismissing sends nothing; a run for someone without a
 * mailbox has no draft_email.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/review-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, auditEvent, mailbox, notification, page, pendingChange, rowActivity, rowEmail, user, workspace, workspaceMember } = await import("@/db/schema");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { setMailDatabases } = await import("@/server/row-mail/settings");
const { listNotifications } = await import("@/server/notifications");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const databases = await import("@/server/databases");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const agents = await import("@/server/agents/manage");
const { flushAgentRuns } = await import("@/server/agents/run");
const automations = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");
const review = await import("@/server/pending-changes");
const { AccessError } = await import("@/server/access");
const { runRetention } = await import("@/server/retention");

const RUN = `review-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
setAiEnv({
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
});

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

async function fails(promise: Promise<unknown>, what: (error: unknown) => boolean) {
  try {
    await promise;
    return false;
  } catch (error) {
    return what(error);
  }
}
const isCode = (code: string) => (e: unknown) => e instanceof review.PendingChangeError && e.code === code;
const isAccess = (e: unknown) => e instanceof AccessError;

type ToolSpec = { function: { name: string; description?: string; parameters?: { required?: string[] } } };
const toolsOf = (request: FakeChatRequest) => (request.tools ?? []) as unknown as ToolSpec[];
const toolResults = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
const everything = (request: FakeChatRequest) => request.messages.map((m) => textOf(m.content)).join("\n");

/** A model that makes these tool calls (each entry one turn), then says `done`. */
function caller(turns: (FakeReply["toolCalls"] | ((request: FakeChatRequest) => NonNullable<FakeReply["toolCalls"]>))[], done = "Done.") {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (made < turns.length) {
      const turn = turns[made];
      return { toolCalls: typeof turn === "function" ? turn(request) : turn };
    }
    return { text: done };
  };
}

const ids = { owner: `${RUN}-owner`, editor: `${RUN}-editor`, viewer: `${RUN}-viewer` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.editor, name: "Editor Ece", email: `${ids.editor}@example.test` },
    { id: ids.viewer, name: "Viewer Veli", email: `${ids.viewer}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
  ]);

  const leads = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: null, kind: "database", title: "Leads" });
  await setPagePermission(ids.owner, leads.id, ids.editor, "edit");
  await setPagePermission(ids.owner, leads.id, ids.viewer, "view");
  const stage = await databases.addProperty(ids.owner, leads.id, { name: "Stage", type: "select", options: ["Lead", "Qualified", "Won"] });
  const amount = await databases.addProperty(ids.owner, leads.id, { name: "Amount", type: "number" });
  const note = await databases.addProperty(ids.owner, leads.id, { name: "Note", type: "text" });

  const qualifier = await agents.createAgent(ids.owner, workspaceId, { name: "Lead qualifier", instructions: "Qualify new leads.", rowChanges: "review" });
  check(qualifier.rowChanges === "review", "an agent can be set to propose its row changes for review");
  check((await agents.createAgent(ids.owner, workspaceId, { name: "Plain" })).rowChanges === "direct", "agents write directly unless set otherwise");
  await automations.createAutomation(ids.owner, leads.id, {
    name: "Qualify",
    trigger: { type: "row_created" },
    actions: [{ type: "run_agent", agent: qualifier.id, prompt: "Qualify this lead." }],
  });
  const settle = async () => {
    await flushAutomations();
    await flushAgentRuns();
    await flushAutomations();
  };
  const latestRun = async () => (await db.select().from(agentRun).where(eq(agentRun.agentId, qualifier.id)).orderBy(agentRun.createdAt)).at(-1)!;
  const rowOf = async (id: string) => (await db.select().from(page).where(eq(page.id, id)))[0];
  const queueOf = (userId: string, filter = {}) => review.listPendingChanges(userId, workspaceId, { filter });

  // ── A run proposes instead of writing ───────────────────────────────────────────────────────
  // The row the run is on: made just below, read when the model is asked.
  let rowId = "";
  fake.chats.length = 0;
  fake.setChat(
    caller([
      () => [{ name: "update_row", arguments: { row_id: rowId, properties: { Stage: "Qualified" }, reason: "First guess." } }],
      () => [
        { name: "update_row", arguments: { row_id: rowId, properties: { Stage: "Qualified", Amount: 18500, Note: "Budget confirmed" }, reason: "The buyer confirmed a budget of 18,500." } },
      ],
    ]),
  );
  const [acme] = await databases.createRows(ids.editor, leads.id, [{ title: "Acme", properties: { [amount.id]: 12000 } }]);
  rowId = acme.id;
  await settle();
  const run = await latestRun();
  check(run.status === "done", "the run is done", run);
  const updateTool = toolsOf(fake.chats[0]).find((t) => t.function.name === "update_row");
  check(
    updateTool && updateTool.function.parameters?.required?.includes("reason") && /waits for a person to approve it/.test(updateTool.function.description ?? ""),
    "its update_row proposes, with a reason, and says nothing is saved until approved",
    updateTool,
  );
  check(/are proposals: each waits for a person to approve it/.test(everything(fake.chats[0])), "the model is told its changes wait for review");
  check(/isn't made yet/.test(toolResults(fake.chats.at(-1)!)[0] ?? ""), "the model hears the change is queued, not made", toolResults(fake.chats.at(-1)!));
  check((await rowOf(acme.id)).properties[amount.id] === 12000 && !(await rowOf(acme.id)).properties[stage.id], "the row isn't changed");
  const proposals = await db.select().from(pendingChange).where(eq(pendingChange.agentRunId, run.id));
  check(proposals.length === 1 && proposals[0].status === "pending", "a newer proposal from the run for the same row takes the older one's place", proposals);
  const [proposal] = proposals;
  check(proposal.reason === "The buyer confirmed a budget of 18,500." && proposal.proposedBy === qualifier.userId, "it keeps the latest reason and who proposed it");
  check(run.steps.some((s) => s.kind === "write" && s.outcome === "proposed"), "the run's step says it was proposed", run.steps);

  // ── Who sees it and hears about it ──────────────────────────────────────────────────────────
  const editorQueue = await queueOf(ids.editor);
  const view = editorQueue.find((c) => c.id === proposal.id);
  check(view && view.canApprove && view.fields.length === 3 && !view.conflict, "whoever may edit the row sees it and may answer it", view);
  const amountField = view.fields.find((f) => f.property?.id === amount.id);
  check(amountField?.before?.type === "number" && amountField.before.value === 12000 && amountField.after.type === "number" && amountField.after.value === 18500, "with what each value was and would become", amountField);
  const viewerView = (await queueOf(ids.viewer)).find((c) => c.id === proposal.id);
  check(viewerView && !viewerView.canApprove, "someone who may only view the row sees it, but may not answer it");
  check(await fails(review.approvePendingChange(ids.viewer, proposal.id, { actor: { userId: ids.viewer } }), isAccess), "and approving it is refused");
  check(await fails(review.dismissPendingChange(ids.viewer, proposal.id), isAccess), "as is dismissing it");
  check((await review.countPendingFor(ids.editor, workspaceId)) === 1 && (await review.countPendingFor(ids.viewer, workspaceId)) === 0, "the sidebar counts what each person may answer");
  const editorInbox = (await listNotifications(ids.editor, { workspaceId })).filter((n) => n.kind === "review");
  check(editorInbox.length === 1 && editorInbox[0].review?.count === 1 && editorInbox[0].actorName === "Lead qualifier", "the person the run worked for hears about it in their inbox", editorInbox);
  check(!(await listNotifications(ids.viewer, { workspaceId })).some((n) => n.kind === "review"), "someone who can't answer it doesn't");
  const reviewPrefs = await db.select().from(notification).where(and(eq(notification.workspaceId, workspaceId), eq(notification.kind, "review")));
  check(reviewPrefs.length === 1, "one notification, however many proposals", reviewPrefs);

  // ── Editing ─────────────────────────────────────────────────────────────────────────────────
  check(await fails(review.editPendingChange(ids.editor, proposal.id, { properties: { Stage: "Qualified", Title: "x", Missing: 1 } }), isCode("invalid")), "an edit can't set values the agent didn't propose");
  const edited = await review.editPendingChange(ids.editor, proposal.id, { properties: { Amount: 19000, Stage: "Qualified" } });
  check(edited.edited && edited.fields.length === 2 && edited.fields.some((f) => f.after.type === "number" && f.after.value === 19000), "an edit changes a value and leaves another out", edited.fields);

  // ── A row that changed since ────────────────────────────────────────────────────────────────
  await databases.updateRowProperties(ids.owner, acme.id, { [amount.id]: 15000 });
  const changed = (await queueOf(ids.editor)).find((c) => c.id === proposal.id)!;
  check(changed.conflict && changed.fields.find((f) => f.property?.id === amount.id)?.conflict, "a row changed since in a value it sets shows the conflict", changed);
  check(await fails(review.approvePendingChange(ids.editor, proposal.id, { actor: { userId: ids.editor } }), isCode("conflict")), "and approving it needs force");
  const approved = await review.approvePendingChange(ids.editor, proposal.id, { force: true, actor: { userId: ids.editor } });
  check(approved.status === "approved" && approved.decidedBy?.id === ids.editor, "approving anyway makes it", approved);
  const after = await rowOf(acme.id);
  const qualified = (await databases.getProperties(leads.id)).find((p) => p.id === stage.id)!.options.options!.find((o) => o.name === "Qualified")!;
  check(after.properties[amount.id] === 19000 && after.properties[stage.id] === qualified.id && !after.properties[note.id], "the row has the edited values, and not the one left out", after.properties);
  const activity = await db.select().from(rowActivity).where(eq(rowActivity.rowId, acme.id));
  const credited = activity.filter((a) => a.proposedBy === qualifier.userId);
  check(credited.length === 2 && credited.every((a) => a.actorUserId === ids.editor), "the row's activity names the approver and credits the agent", activity);
  check(await fails(review.approvePendingChange(ids.editor, proposal.id, { actor: { userId: ids.editor } }), isCode("decided")), "an answered change can't be answered again");
  check((await queueOf(ids.editor)).every((c) => c.id !== proposal.id), "it leaves the waiting list");
  check(
    (await review.listPendingChanges(ids.editor, workspaceId, { status: "decided" })).some((c) => c.id === proposal.id),
    "and shows among the answered ones",
  );
  check(!(await listNotifications(ids.editor, { workspaceId })).some((n) => n.kind === "review"), "with nothing waiting, the inbox item goes");

  // ── A new row, and dismissing ───────────────────────────────────────────────────────────────
  const propose = (kind: "create_row" | "update_row", rowId: string | null, payload: object, before: object | null = null) =>
    review.proposeChange({
      workspaceId,
      kind,
      databaseId: leads.id,
      rowId,
      payload: payload as never,
      before: before as never,
      reason: "Seen on the contact form.",
      source: { kind: "agent_run", runId: run.id },
      agent: { id: qualifier.id, userId: qualifier.userId },
      runId: run.id,
      for: [ids.editor],
    });
  const newRow = await propose("create_row", null, { title: "Birch Foods", properties: { [note.id]: "Asked for a price" } });
  const made = await review.approvePendingChange(ids.editor, newRow.id, { actor: { userId: ids.editor } });
  check(made.status === "approved" && made.row, "approving a new row makes it", made);
  const birch = await rowOf(made.row.id);
  check(birch.parentId === leads.id && birch.title === "Birch Foods" && birch.properties[note.id] === "Asked for a price", "in the database the agent proposed it for, as proposed", birch);
  const second = await propose("create_row", null, { title: "Cedar Hotels", properties: {} });
  check((await queueOf(ids.editor)).filter((c) => c.kind === "create_row").length === 1, "proposals of new rows don't replace each other");
  const dismissed = await review.dismissPendingChange(ids.editor, second.id);
  check(dismissed.status === "dismissed", "dismissing answers it");
  check((await db.select().from(page).where(and(eq(page.parentId, leads.id), eq(page.title, "Cedar Hotels")))).length === 0, "and makes nothing");
  const bulk = [await propose("update_row", acme.id, { properties: { [note.id]: "A" } }, { properties: { [note.id]: null } })];
  const outcomes = await review.decidePendingChanges(ids.viewer, [bulk[0].id], "approve", { actor: { userId: ids.viewer } });
  check(outcomes[0].ok === false && outcomes[0].code === "accessDenied", "answering several at once skips what the person may not answer, with why", outcomes);
  const bulkOk = await review.decidePendingChanges(ids.editor, [bulk[0].id, second.id], "dismiss");
  check(bulkOk[0].ok && !bulkOk[1].ok && bulkOk[1].code === "decided", "and answers the rest", bulkOk);

  const audit = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), inArray(auditEvent.action, ["review.approved", "review.dismissed"])));
  check(audit.filter((a) => a.action === "review.approved").length === 2 && audit.filter((a) => a.action === "review.dismissed").length === 2, "the audit log records each answer", audit.map((a) => a.action));

  // ── Email drafts ────────────────────────────────────────────────────────────────────────────
  await updateWorkspaceSettings(ids.owner, workspaceId, { email: true });
  const contacts = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: null, kind: "database", title: "Contacts" });
  await setPagePermission(ids.owner, contacts.id, ids.editor, "edit");
  const emailProp = await databases.addProperty(ids.owner, contacts.id, { name: "Email", type: "email" });
  await setMailDatabases(ids.owner, workspaceId, [{ databaseId: contacts.id, propertyIds: [emailProp.id] }]);
  // A mailbox for the editor only, as connecting one would leave it (its password is never used here).
  await db.insert(mailbox).values({
    workspaceId,
    userId: ids.editor,
    isDefault: true,
    address: "ece@example.test",
    imapHost: "imap.example.test",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.example.test",
    smtpPort: 465,
    smtpSecure: true,
    username: "ece@example.test",
    secret: "not-a-sealed-secret",
    status: "ok",
    consentedAt: new Date(),
  });
  const mailer = await agents.createAgent(ids.owner, workspaceId, { name: "Follow-up writer", instructions: "Write follow-ups." });
  await automations.createAutomation(ids.owner, contacts.id, {
    name: "Follow up",
    trigger: { type: "row_created" },
    actions: [{ type: "run_agent", agent: mailer.id, prompt: "Write a follow-up email." }],
  });
  const mailerRun = async () => (await db.select().from(agentRun).where(eq(agentRun.agentId, mailer.id)).orderBy(agentRun.createdAt)).at(-1)!;
  const finished = "Hello Defne,\n\nThank you for your time today. The quote follows this week.\n\nBest regards,\nEce";
  fake.chats.length = 0;
  fake.setChat(
    caller([
      [{ name: "draft_email", arguments: { subject: "Your quote", text: "Hello {{first_name}},\n\n**Thanks** for your time.\n\n[Your Name]", reason: "A follow-up after the call." } }],
      [{ name: "draft_email", arguments: { subject: "Your quote", text: finished, reason: "A follow-up after the call." } }],
    ]),
  );
  const [defne] = await databases.createRows(ids.editor, contacts.id, [{ title: "Defne", properties: { [emailProp.id]: "defne@example.test" } }]);
  await settle();
  const drafted = await mailerRun();
  check(drafted.status === "done", "the run that drafts is done", drafted);
  // The other agent's runs (on rows approved above) ask the model too: the follow-up writer's turns.
  const mailChats = fake.chats.filter((c) => everything(c).includes("Defne"));
  const draftTool = toolsOf(mailChats[0]).find((t) => t.function.name === "draft_email");
  check(draftTool && /Editor Ece's mailbox \(ece@example\.test\)/.test(draftTool.function.description ?? ""), "a run for someone with a mailbox may draft email from it, and is told whose", draftTool);
  check(/draft_email drafts an email on the row/.test(everything(mailChats[0])), "the model is told how to write a draft");
  const refused = toolResults(mailChats[1])[0] ?? "";
  check(/isn't a finished message/.test(refused) && /gap to fill/.test(refused) && /Markdown/.test(refused), "a draft with placeholders and Markdown goes back to the model with why", refused);
  check(/isn't sent yet/.test(toolResults(mailChats[2]).at(-1) ?? ""), "the model hears a finished draft waits, unsent", toolResults(mailChats[2]));
  const drafts = await db.select().from(pendingChange).where(and(eq(pendingChange.agentRunId, drafted.id), eq(pendingChange.kind, "email_draft")));
  check(drafts.length === 1 && drafts[0].senderId === ids.editor, "one draft waits, from the person the run worked for", drafts);
  const [draft] = drafts;
  const payload = draft.payload as { to: string[]; subject: string; text: string; replyTo: string | null };
  check(payload.to.join() === "defne@example.test" && payload.replyTo === null && payload.subject === "Your quote" && payload.text === finished, "a new message to the row's own address", payload);
  check(drafted.steps.some((s) => s.kind === "email" && s.outcome === "proposed"), "the run's step says it drafted an email", drafted.steps);
  check((await db.select().from(rowEmail).where(eq(rowEmail.rowId, defne.id))).length === 0, "nothing is sent by the agent");
  const ownerSees = (await queueOf(ids.owner)).find((c) => c.id === draft.id);
  check(!ownerSees || !ownerSees.canApprove, "someone else, full access or not, may not send it", ownerSees);
  check(await fails(review.approvePendingChange(ids.owner, draft.id, { actor: { userId: ids.owner } }), isAccess), "approving it from someone else's mailbox is refused");
  check(await fails(review.dismissPendingChange(ids.owner, draft.id), isAccess), "as is dismissing it");
  const senderSees = (await queueOf(ids.editor)).find((c) => c.id === draft.id);
  check(senderSees?.canApprove && senderSees.email?.sender?.id === ids.editor, "its sender sees it and may send it", senderSees);
  const senderInbox = (await listNotifications(ids.editor, { workspaceId })).filter((n) => n.kind === "review");
  check(senderInbox.length === 1 && (await review.countPendingFor(ids.editor, workspaceId)) === 1, "its sender hears about it in their inbox", senderInbox);
  check((await review.countPendingFor(ids.owner, workspaceId)) === 0, "and no one else counts it");
  // The sender's own words aren't checked: they send what they mean to.
  const ownWords = `${finished}\n\n**P.S.** See you on [Friday].`;
  const editedDraft = await review.editPendingChange(ids.editor, draft.id, { text: ownWords });
  check(editedDraft.edited && editedDraft.email?.text === ownWords, "its sender may edit the text, unchecked", editedDraft.email);
  const sent = await review.approvePendingChange(ids.editor, draft.id, { actor: { userId: ids.editor } });
  check(sent.status === "approved", "approving it sends it", sent);
  const queued = await db.select().from(rowEmail).where(eq(rowEmail.rowId, defne.id));
  check(
    queued.length === 1 && queued[0].direction === "out" && queued[0].sentBy === ids.editor && queued[0].fromAddress === "ece@example.test" && queued[0].to.join() === "defne@example.test" && queued[0].text === ownWords,
    "from the sender's mailbox, on the row, to the row's address, as the sender edited it",
    queued,
  );
  // Sending is tried at once in the background (and fails here, with no real server): wait for it.
  for (let i = 0; i < 50 && (await db.select({ attempts: rowEmail.attempts }).from(rowEmail).where(eq(rowEmail.id, queued[0].id)))[0].attempts === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // A reply: the draft answers the row's latest message, to its sender, keeping its subject.
  const incoming = await db
    .insert(rowEmail)
    .values({
      workspaceId,
      databaseId: contacts.id,
      rowId: defne.id,
      direction: "in",
      messageId: `${RUN}-in@example.test`,
      fromAddress: "defne.other@example.test",
      to: ["ece@example.test"],
      subject: "Price list",
      text: "Could you send the price list?",
      sentAt: new Date(Date.now() + 60_000),
      status: "received",
    })
    .returning({ id: rowEmail.id });
  const reply = await (await import("@/server/agents/email-drafts")).draftRowEmail({
    workspaceId,
    agent: { id: mailer.id, userId: mailer.userId },
    runId: drafted.id,
    automationRunId: null,
    sender: { userId: ids.editor, name: "Editor Ece", address: "ece@example.test" },
    rowId: defne.id,
    args: { subject: "Prices", text: "Hello Defne,\n\nThe price list is attached.\n\nEce", reason: "She asked for prices." },
  });
  check(!reply.isError, "a draft on a row with mail", reply);
  const [answer] = await db.select().from(pendingChange).where(and(eq(pendingChange.rowId, defne.id), eq(pendingChange.status, "pending")));
  const answerPayload = answer.payload as { to: string[]; subject: string; replyTo: string | null };
  check(answerPayload.replyTo === incoming[0].id && answerPayload.to.join() === "defne.other@example.test" && answerPayload.subject === "Re: Price list", "answers its latest message, to who wrote it, keeping the subject", answerPayload);
  const thrown = await review.dismissPendingChange(ids.editor, answer.id);
  check(thrown.status === "dismissed" && (await db.select().from(rowEmail).where(and(eq(rowEmail.rowId, defne.id), eq(rowEmail.direction, "out")))).length === 1, "dismissing a draft sends nothing");

  // A run for someone without a mailbox (the owner) has no draft_email, and calling it anyway fails.
  fake.chats.length = 0;
  fake.setChat(caller([[{ name: "draft_email", arguments: { subject: "Hi", text: "Hello.", reason: "x" } }]]));
  await databases.createRows(ids.owner, contacts.id, [{ title: "Ferhat", properties: { [emailProp.id]: "ferhat@example.test" } }]);
  await settle();
  const ownerChats = fake.chats.filter((c) => everything(c).includes("Ferhat"));
  check(ownerChats.length === 2 && !toolsOf(ownerChats[0]).some((t) => t.function.name === "draft_email"), "a run for someone without a mailbox isn't offered draft_email", ownerChats.length);
  check(/There is no tool "draft_email"/.test(toolResults(ownerChats[1])[0] ?? ""), "and calling it anyway gets an error", toolResults(ownerChats[1]));
  check((await db.select().from(pendingChange).where(and(eq(pendingChange.workspaceId, workspaceId), eq(pendingChange.kind, "email_draft")))).length === 2, "no draft is made");

  // ── Expiry and cleanup ──────────────────────────────────────────────────────────────────────
  const stale = await propose("update_row", acme.id, { properties: { [note.id]: "B" } }, { properties: { [note.id]: null } });
  const now = new Date();
  await db.update(pendingChange).set({ expiresAt: new Date(now.getTime() - 1000) }).where(eq(pendingChange.id, stale.id));
  const cleaned = await runRetention({ now, workspaceIds: [workspaceId] });
  check(cleaned && cleaned.expiredProposals === 1, "the daily cleanup expires what waited too long", cleaned);
  check((await db.select().from(pendingChange).where(eq(pendingChange.id, stale.id)))[0].status === "expired", "it is kept as expired");
  check(!(await queueOf(ids.editor)).some((c) => c.id === stale.id), "and leaves the queue");
  const later = await runRetention({ now: new Date(now.getTime() + 31 * 24 * 60 * 60_000), workspaceIds: [workspaceId] });
  check(later && later.deletedProposals >= 4, "answered and expired ones go a month later", later);
  check((await db.select().from(pendingChange).where(eq(pendingChange.workspaceId, workspaceId))).length === 0, "leaving none");

  console.log(`\n${passed} checks passed`);
} finally {
  await fake.close();
  await db.delete(notification).where(eq(notification.workspaceId, workspaceId));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
