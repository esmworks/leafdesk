/**
 * End-to-end check of mentioning agents in comments, against the database and a fake
 * OpenAI-compatible server (src/server/ai/fake-openai.ts): the comments' @ menu offers the agents
 * that may comment on the page (not those that may only view it, paused or archived ones), apart
 * from the people, and never an agent as a person; a member's new thread or reply that mentions an
 * agent starts one run of it (once, however often it is mentioned), while an edit, a guest's
 * comment and an agent's own comment start none; the run reads the comment, the thread before it
 * and the page, within the member's access (no page the member can't open), may change the page
 * only where it may edit it, and
 * answers in the thread as the agent, which tells the member like any reply; a run that can't
 * answer (its monthly tokens used, AI off) says why there instead. The agent's runs list the
 * mention, with who wrote it and on which page, in the app and over MCP.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-mention-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, agentUsage, notification, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { changeComments, listComments } = await import("@/server/comments");
const { commentMentionCandidates } = await import("@/server/mentions");
const { commentText } = await import("@/lib/comments");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
const agents = await import("@/server/agents/manage");
const { flushAgentRuns } = await import("@/server/agents/run");
const { monthOf } = await import("@/server/agents/usage");
const { describeAgentRun } = await import("@/server/mcp/agents");
const { emailTranslator } = await import("@/server/mail/templates");

const RUN = `agent-mention-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
const AI_ON = { AI_PROVIDER: "openai-compatible", AI_MODEL: "fake-chat", AI_BASE_URL: fake.baseUrl, AI_WORKSPACE_RATE_LIMIT: "1000", AI_RATE_LIMIT: "1000" };
setAiEnv(AI_ON);
const en = emailTranslator("en");

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

const everything = (request: FakeChatRequest) => request.messages.map((m) => textOf(m.content)).join("\n");
const toolNames = (request: FakeChatRequest | undefined) => (request?.tools ?? []).map((t) => t.function.name);

type Mentioned = { userId: string; name: string };
/** A comment body as the comment box sends it: text with people and agents mentioned. */
const body = (...parts: (string | Mentioned)[]) => [
  {
    type: "paragraph",
    content: parts.map((p) => (typeof p === "string" ? { type: "text", text: p, styles: {} } : { type: "mention", props: { kind: "user", id: `m-${p.userId}`, userId: p.userId, name: p.name } })),
  },
];

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

/** The agent's runs a comment started. */
const runsOf = (commentId: string) => db.select().from(agentRun).where(sql`${agentRun.source}->>'commentId' = ${commentId}`);
/** The thread's comments as plain text, with their authors. */
async function threadOf(pageId: string, threadId: string) {
  const thread = (await listComments(ids.owner, pageId)).find((t) => t.id === threadId);
  return (thread?.comments ?? []).map((c) => ({ userId: c.userId, text: commentText(c.body) }));
}

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
    { id: ids.guest, name: "Guest Gül", email: `${ids.guest}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const plan = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: general.id, title: "Launch plan", markdown: "Ship on Friday. PLAN-TEXT" });
  await setPagePermission(ids.owner, plan.id, ids.guest, "comment");

  const helper = await agents.createAgent(ids.owner, workspaceId, { name: "Helper", icon: "🤖", instructions: "Answer questions about the page." });
  const editor = await agents.createAgent(ids.owner, workspaceId, { name: "Helper Editor", instructions: "Fix pages when asked." });
  const reader = await agents.createAgent(ids.owner, workspaceId, { name: "Helper Reader", instructions: "" });
  const paused = await agents.createAgent(ids.owner, workspaceId, { name: "Helper Paused", instructions: "" });
  const archived = await agents.createAgent(ids.owner, workspaceId, { name: "Helper Archived", instructions: "" });
  await agents.setAgentAccess(ids.owner, helper.id, plan.id, "comment");
  await agents.setAgentAccess(ids.owner, editor.id, plan.id, "edit");
  await agents.setAgentAccess(ids.owner, reader.id, plan.id, "view");
  await agents.setAgentAccess(ids.owner, paused.id, plan.id, "comment");
  await agents.setAgentAccess(ids.owner, archived.id, plan.id, "comment");
  await agents.updateAgent(ids.owner, paused.id, { enabled: false });
  await agents.archiveAgent(ids.owner, archived.id);
  const asMention = (a: { userId: string; name: string }): Mentioned => ({ userId: a.userId, name: a.name });
  const agentUserIds = [helper, editor, reader, paused, archived].map((a) => a.userId);

  // ── The @ menu ────────────────────────────────────────────────────────────────────────────────
  const offered = await commentMentionCandidates(ids.member, plan.id, "");
  check(
    offered.agents.map((a) => a.id).sort().join() === [helper.userId, editor.userId].sort().join() &&
      offered.agents.find((a) => a.id === helper.userId)?.icon === "🤖",
    "the @ menu offers the agents that may comment on the page, with their icons: not those that only view it, paused or archived ones",
    offered.agents,
  );
  check(
    offered.people.some((p) => p.id === ids.owner) && !offered.people.some((p) => agentUserIds.includes(p.id)),
    "…apart from the people, where no agent shows up as a person",
    offered.people,
  );
  check((await commentMentionCandidates(ids.member, plan.id, "edit")).agents.map((a) => a.id).join() === editor.userId, "…matching what was typed");
  const forGuest = await commentMentionCandidates(ids.guest, plan.id, "");
  check(forGuest.agents.length === 0 && forGuest.people.length === 0, "a guest gets neither people nor agents", forGuest);

  // ── A new thread that mentions an agent (twice) ───────────────────────────────────────────────
  fake.chats.length = 0;
  fake.setChat(() => ({ text: "The plan ships on Friday." }));
  const asked = await changeComments(ids.member, plan.id, {
    type: "createThread",
    body: body(asMention(helper), " when do we ship? ", asMention(helper), " ", asMention(reader), " ", asMention(archived)),
  });
  const threadId = asked.thread!.id;
  const queued = await runsOf(asked.comment!.id);
  check(
    queued.length === 1 &&
      queued[0].agentId === helper.id &&
      queued[0].status === "pending" &&
      queued[0].source.kind === "mention" &&
      queued[0].source.mentionedBy === ids.member &&
      queued[0].source.threadId === threadId &&
      queued[0].prompt.includes("when do we ship?"),
    "posting a comment that mentions an agent twice queues one run of it, and none of agents that only view the page or are archived",
    queued,
  );
  check(
    !(await db.select({ id: agentRun.id }).from(agentRun).where(inArray(agentRun.agentId, [reader.id, archived.id]))).length,
    "…the view-only and archived agents have no runs at all",
  );
  await flushAgentRuns();
  const [done] = await runsOf(asked.comment!.id);
  check(done.status === "done" && done.answer === "The plan ships on Friday.", "the run finishes with the model's answer", done);
  const firstChat = fake.chats.at(-1)!;
  check(
    everything(firstChat).includes("PLAN-TEXT") &&
      everything(firstChat).includes("Member Mert mentioned you in a comment") &&
      everything(firstChat).includes("@Helper when do we ship?") &&
      everything(firstChat).includes("Your last message is posted, as you, as your reply in the thread"),
    "the agent reads the page, who mentioned it and the comment",
    everything(firstChat),
  );
  check(!toolNames(firstChat).some((n) => ["edit_page", "update_row", "add_comment", "remember"].includes(n)), "…and may not change a page it may only comment on", toolNames(firstChat));
  let thread = await threadOf(plan.id, threadId);
  check(
    thread.length === 2 && thread[1].userId === helper.userId && thread[1].text === "The plan ships on Friday.",
    "the agent answers in the thread, as itself",
    thread,
  );
  const told = await db
    .select({ actorId: notification.actorId })
    .from(notification)
    .where(and(eq(notification.userId, ids.member), eq(notification.kind, "comment"), eq(notification.threadId, threadId)));
  check(told.some((n) => n.actorId === helper.userId), "…and the member hears about the reply like any other", told);
  check(
    !(await db.select({ id: notification.id }).from(notification).where(inArray(notification.userId, agentUserIds))).length,
    "agents get no notifications for being mentioned",
  );

  // ── A reply that mentions an agent that may edit ──────────────────────────────────────────────
  fake.chats.length = 0;
  fake.setChat((request) =>
    request.messages.some((m) => m.role === "tool")
      ? { text: "Moved it to Monday." }
      : { toolCalls: [{ name: "edit_page", arguments: { page_id: plan.id, edits: [{ op: "append", markdown: "Moved to Monday." }] } }] },
  );
  const reply = await changeComments(ids.member, plan.id, { type: "addComment", threadId, body: body(asMention(editor), " please move it to Monday") });
  check((await runsOf(reply.comment!.id)).length === 1, "a reply that mentions an agent starts a run too");
  await flushAgentRuns();
  const replyChat = fake.chats[0];
  check(
    toolNames(replyChat).includes("edit_page") && !toolNames(replyChat).includes("update_row") && !toolNames(replyChat).includes("add_comment"),
    "an agent that may edit the page may change it (and only it, a page rather than a row)",
    toolNames(replyChat),
  );
  check(
    everything(replyChat).includes("<thread>") && everything(replyChat).includes("Member Mert: @Helper when do we ship?") && everything(replyChat).includes("Helper (agent): The plan ships on Friday."),
    "…and reads the thread before the reply, oldest first, agents marked",
    everything(replyChat),
  );
  const [edited] = await runsOf(reply.comment!.id);
  check(edited.status === "done" && edited.steps.some((s) => s.kind === "write"), "…which it did", edited.steps);
  thread = await threadOf(plan.id, threadId);
  check(thread.at(-1)?.userId === editor.userId && thread.at(-1)?.text === "Moved it to Monday.", "…and answers in the same thread", thread);

  // ── Held to the member's access ───────────────────────────────────────────────────────────────
  const secret = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: null, title: "Owner's notes", markdown: "SECRET-NOTES" });
  await agents.setAgentAccess(ids.owner, helper.id, secret.id, "view");
  fake.chats.length = 0;
  fake.setChat((request) =>
    request.messages.some((m) => m.role === "tool") ? { text: "I can't open it." } : { toolCalls: [{ name: "read_page", arguments: { page_id: secret.id } }] },
  );
  const prying = await changeComments(ids.member, plan.id, { type: "createThread", body: body(asMention(helper), " what is in the owner's notes?") });
  await flushAgentRuns();
  check(
    (await runsOf(prying.comment!.id))[0]?.status === "done" && !fake.chats.some((c) => everything(c).includes("SECRET-NOTES")),
    "the agent reads only what the member who mentioned it may open",
  );

  // ── What starts no run ────────────────────────────────────────────────────────────────────────
  const before = (await db.select({ id: agentRun.id }).from(agentRun).where(eq(agentRun.workspaceId, workspaceId))).length;
  const plain = await changeComments(ids.member, plan.id, { type: "createThread", body: body("No one mentioned") });
  await changeComments(ids.member, plan.id, { type: "updateComment", threadId: plain.thread!.id, commentId: plain.comment!.id, body: body(asMention(helper), " added later") });
  const byGuest = await changeComments(ids.guest, plan.id, { type: "createThread", body: body(asMention(helper), " from a guest") });
  await changeComments(helper.userId, plan.id, { type: "addComment", threadId, body: body(asMention(editor), " over to you") });
  const after = (await db.select({ id: agentRun.id }).from(agentRun).where(eq(agentRun.workspaceId, workspaceId))).length;
  check(after === before, "editing a comment to add a mention, a guest's mention and an agent's own mention start no run", { before, after });
  check((await threadOf(plan.id, byGuest.thread!.id))[0]?.text === "@Helper from a guest", "…a guest's mention stays as the agent's name");

  // ── When the agent can't answer, it says why ──────────────────────────────────────────────────
  await agents.updateAgent(ids.owner, helper.id, { monthlyTokenLimit: 1 });
  await db
    .insert(agentUsage)
    .values({ agentId: helper.id, month: monthOf(new Date()), runs: 1, inputTokens: 5, outputTokens: 5, costUsd: 0 })
    .onConflictDoUpdate({ target: [agentUsage.agentId, agentUsage.month], set: { inputTokens: 5, outputTokens: 5 } });
  const overLimit = await changeComments(ids.member, plan.id, { type: "createThread", body: body(asMention(helper), " again?") });
  await flushAgentRuns();
  const [limited] = await runsOf(overLimit.comment!.id);
  check(limited.status === "failed" && limited.code === "limitReached", "a run over the agent's monthly limit fails", limited);
  check(
    (await threadOf(plan.id, overLimit.thread!.id)).at(-1)?.text === en("agentReply.limitReached"),
    "…and the agent says so in the thread",
    await threadOf(plan.id, overLimit.thread!.id),
  );
  await agents.updateAgent(ids.owner, helper.id, { monthlyTokenLimit: null });
  setAiEnv({});
  const aiOff = await changeComments(ids.member, plan.id, { type: "createThread", body: body(asMention(helper), " anyone?") });
  await flushAgentRuns();
  setAiEnv(AI_ON);
  check((await runsOf(aiOff.comment!.id))[0]?.code === "aiOff", "with AI off, the run fails");
  check((await threadOf(plan.id, aiOff.thread!.id)).at(-1)?.text === en("agentReply.aiOff"), "…and the agent says AI is off");
  const toPaused = await changeComments(ids.member, plan.id, { type: "createThread", body: body(asMention(paused), " hello") });
  await flushAgentRuns();
  check(
    (await threadOf(plan.id, toPaused.thread!.id)).at(-1)?.text === en("agentReply.agentDisabled"),
    "a paused agent (mentioned from a menu opened before it was paused) says it is paused",
  );

  // ── The agent's runs ──────────────────────────────────────────────────────────────────────────
  const history = await agents.listAgentRuns(ids.owner, helper.id);
  const listed = history.find((r) => r.id === done.id);
  check(
    listed?.mention?.byName === "Member Mert" && listed.mention.pageTitle === "Launch plan" && listed.mention.threadId === threadId && listed.mention.task.includes("when do we ship?") && listed.answer === "The plan ships on Friday.",
    "the agent's runs show who mentioned it, on which page, the comment and the answer",
    listed,
  );
  const viaMcp = describeAgentRun(workspaceId, listed!) as unknown as { source: Record<string, unknown> };
  check(
    viaMcp.source.kind === "mention" &&
      (viaMcp.source.mentioned_by as { id: string }).id === ids.member &&
      (viaMcp.source.page as { title: string }).title === "Launch plan" &&
      viaMcp.source.thread_id === threadId,
    "…and so does list_agent_runs over MCP",
    viaMcp,
  );

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(agentRun).where(eq(agentRun.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...userIds, ...botUsers]));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
