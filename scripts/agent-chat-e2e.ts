/**
 * End-to-end check of chatting with agents (lib/agent-chat.ts) against the database, with a fake
 * OpenAI-compatible server scripted per message: an owner chats with an agent in its dialog and in
 * a page's block with its full tools (pages it may change, its memory), each message one of its
 * runs (source `chat`, in its history and usage); a member it is shared with to view and interact
 * chats in its dialog, or in a block on a page they can open that holds that chat, read-only and
 * within what both they and the agent can open (a page only the agent and the owner see is not
 * found for them, whatever the model asks for); guests, archived agents and agents over their
 * monthly limit don't chat; each person's conversations are theirs alone (owners don't see a
 * member's, members don't see each other's); one answer at a time; exported Markdown names the
 * agent and nothing said. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-chat-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentConversation, agentRun, agentUsage, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const agents = await import("@/server/agents/manage");
const chat = await import("@/server/agents/chat");
const { flushAgentRuns } = await import("@/server/agents/run");
const { pageMarkdown } = await import("@/server/export");
const { agentChatLine } = await import("@/lib/agent-chat");

const RUN = `agent-chat-e2e-${Date.now().toString(36)}`;

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

async function refusal(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof chat.AgentChatRefusal ? error.code : `other: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const everything = (request: FakeChatRequest) => request.messages.map((m) => textOf(m.content)).join("\n");
const toolResults = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
const toolNames = (request: FakeChatRequest) => (request.tools ?? []).map((t) => t.function.name);

/** A model that makes these tool calls, one per turn, then says `done`. */
function caller(calls: { name: string; arguments: Record<string, unknown> }[], done = "Done.") {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (made < calls.length) return { toolCalls: [calls[made]] };
    return { text: done };
  };
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, other: `${RUN}-other`, guest: `${RUN}-guest` };
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
    { id: ids.other, name: "Other Oya", email: `${ids.other}@example.test` },
    { id: ids.guest, name: "Guest Gül", email: `${ids.guest}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.other, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const owner = { userId: ids.owner };

  const helper = await agents.createAgent(ids.owner, workspaceId, { name: "Helper", instructions: "Answer from the workspace." });
  // Everyone's page, shared with the agent; and the owner's private page, shared with the agent only.
  const handbook = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Handbook", markdown: "Lunch is at noon. KB-HANDBOOK" });
  const minutes = await createPage(owner, { workspaceId, teamspaceId: null, title: "Board minutes", markdown: "Merger talks with Acme. BOARD-SECRET" });
  await agents.setAgentAccess(ids.owner, helper.id, handbook.id, "view");
  await agents.setAgentAccess(ids.owner, helper.id, minutes.id, "view");
  const chatId = crypto.randomUUID();
  const chatPage = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Ask the helper", markdown: `Ask here:\n\n${agentChatLine(helper.id, chatId)}\n` });
  const place = { chatId, pageId: chatPage.id };

  // ── The block in Markdown ──────────────────────────────────────────────────────────────────
  const exported = await pageMarkdown(ids.owner, chatPage.id);
  check(exported.body.includes("Agent chat: Helper") && !exported.body.includes(chatId), "exported Markdown names the agent, not its chat", exported.body);
  const [stored] = await db.execute<{ content_markdown: string }>(sql`select content_markdown from page where id = ${chatPage.id}`);
  check(stored.content_markdown.includes(agentChatLine(helper.id, chatId)), "the page's stored Markdown keeps the block's line", stored.content_markdown);

  // ── Where people stand ─────────────────────────────────────────────────────────────────────
  check((await chat.agentChatInfo(ids.owner, workspaceId, helper.id, null)).state === "full", "an owner chats in the dialog with full tools");
  check((await chat.agentChatInfo(ids.owner, workspaceId, helper.id, place)).state === "full", "and in the block");
  check((await chat.agentChatInfo(ids.member, workspaceId, helper.id, place)).state === "readOnly", "a member chats in the block, read-only");
  check((await chat.agentChatInfo(ids.member, workspaceId, helper.id, null)).state === "readOnly", "a member it is shared with chats in its dialog too, read-only");
  const guestInfo = await chat.agentChatInfo(ids.guest, workspaceId, helper.id, place);
  check(guestInfo.state === "guest" && guestInfo.agent === null, "a guest gets no chat and learns nothing of the agent", guestInfo);

  // ── The owner's chat ───────────────────────────────────────────────────────────────────────
  fake.setChat(caller([{ name: "read_page", arguments: { page_id: minutes.id } }], "The board discussed a merger."));
  fake.chats.length = 0;
  const first = await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: null, message: "What did the board discuss?" });
  check(
    (await refusal(chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: first.conversation.id, message: "And?" }))) === "busy",
    "one answer at a time in a conversation",
  );
  await flushAgentRuns();
  const [ownerRun] = await db.select().from(agentRun).where(eq(agentRun.id, first.runId));
  check(ownerRun.status === "done" && ownerRun.source.kind === "chat" && ownerRun.source.userId === ids.owner, "the owner's message is a run with the chat source", ownerRun);
  const ownerTools = toolNames(fake.chats[0]);
  check(["create_row", "update_row", "create_page", "edit_page"].every((n) => ownerTools.includes(n)), "an owner's chat is offered the tools that change pages", ownerTools);
  check(toolResults(fake.chats.at(-1)!).some((r) => r.includes("BOARD-SECRET")), "an owner's chat reads what both the owner and the agent can open");
  const turn = await chat.chatTurn(ids.owner, workspaceId, first.runId);
  check(turn.status === "done" && turn.answer === "The board discussed a merger." && turn.steps.some((s) => s.kind === "read"), "the turn shows its answer and steps", turn);
  const ownerConversation = await chat.getAgentConversation(ids.owner, workspaceId, helper.id, first.conversation.id, null);
  check(
    ownerConversation.messages.length === 2 && ownerConversation.messages[1].content === "The board discussed a merger." && ownerConversation.running === null,
    "the answer is kept in the conversation",
    ownerConversation,
  );
  // The next message carries the conversation so far.
  fake.setChat(() => ({ text: "Noted." }));
  fake.chats.length = 0;
  const second = await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: first.conversation.id, message: "Thanks!" });
  await flushAgentRuns();
  check(everything(fake.chats[0]).includes("The board discussed a merger.") && second.conversation.id === first.conversation.id, "a message goes with the conversation before it");
  const [usage] = await db.select().from(agentUsage).where(eq(agentUsage.agentId, helper.id));
  check(usage?.runs === 2, "each message counts as one of the agent's runs", usage);

  // ── Leafdesk's further tools ───────────────────────────────────────────────────────────────
  const orders = await createPage(owner, { workspaceId, teamspaceId: general.id, kind: "database", title: "Orders" });
  await agents.setAgentAccess(ids.owner, helper.id, orders.id, "edit");
  fake.setChat(
    caller(
      [
        { name: "find_tools", arguments: { query: "board view" } },
        { name: "use_tool", arguments: { name: "create_database_view", arguments: { database_id: orders.id, name: "Order board", type: "board" } } },
        { name: "use_tool", arguments: { name: "create_automation", arguments: {} } },
      ],
      "Added it.",
    ),
  );
  fake.chats.length = 0;
  const archiving = await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: null, message: "Add a board view to Orders." });
  await flushAgentRuns();
  check(["find_tools", "use_tool"].every((n) => toolNames(fake.chats[0]).includes(n)), "an owner's chat is offered Leafdesk's further tools", toolNames(fake.chats[0]));
  const further = toolResults(fake.chats.at(-1)!);
  check(further[0].startsWith("## create_database_view (") && !further[0].includes("create_automation"), "find_tools shows those that fit, none a person is asked about each time", further[0]);
  const [board] = await db.execute<{ type: string }>(sql`select type from database_view where database_id = ${orders.id} and name = 'Order board'`);
  check(board?.type === "board", "an owner's chat makes a change through one at once", further[1]);
  check(/no tool "create_automation"/.test(further[2]), "one a person is asked about each time isn't there", further[2]);
  const archivingTurn = await chat.chatTurn(ids.owner, workspaceId, archiving.runId);
  check(
    archivingTurn.steps.some((s) => s.kind === "leafdesk" && s.tool === "create_database_view" && s.outcome === "done"),
    "the turn shows the call among its steps",
    archivingTurn.steps,
  );

  // ── A member's chat ────────────────────────────────────────────────────────────────────────
  fake.setChat(
    caller(
      [
        { name: "read_page", arguments: { page_id: minutes.id } },
        { name: "search_pages", arguments: { query: "merger BOARD-SECRET" } },
        { name: "update_row", arguments: { row_id: handbook.id, title: "Changed" } },
        { name: "read_page", arguments: { page_id: handbook.id } },
        { name: "use_tool", arguments: { name: "list_pages", arguments: { workspace_id: workspaceId } } },
        { name: "use_tool", arguments: { name: "set_page_archived", arguments: { page_id: handbook.id, archived: true } } },
      ],
      "Lunch is at noon.",
    ),
  );
  fake.chats.length = 0;
  check(
    (await refusal(chat.sendAgentChat(ids.guest, { workspaceId, agentId: helper.id, place: null, conversationId: null, message: "Hi" }))) === "guest",
    "a guest can't chat in the dialog either",
  );
  check(
    (await refusal(chat.sendAgentChat(ids.member, { workspaceId, agentId: helper.id, place: { chatId: "elsewhere", pageId: chatPage.id }, conversationId: null, message: "Hi" }))) ===
      "notOnPage",
    "nor in a chat the page doesn't hold",
  );
  check(
    (await refusal(chat.sendAgentChat(ids.member, { workspaceId, agentId: helper.id, place: { chatId, pageId: minutes.id }, conversationId: null, message: "Hi" }))) === "notOnPage",
    "nor on a page they can't open",
  );
  const memberSent = await chat.sendAgentChat(ids.member, { workspaceId, agentId: helper.id, place, conversationId: null, message: "What did the board discuss, and when is lunch?" });
  await flushAgentRuns();
  const [memberRun] = await db.select().from(agentRun).where(eq(agentRun.id, memberSent.runId));
  check(memberRun.status === "done", "the member's message is answered", memberRun);
  const memberTools = toolNames(fake.chats[0]);
  check(
    !["create_row", "update_row", "create_page", "edit_page", "remember", "forget"].some((n) => memberTools.includes(n)) && memberTools.includes("read_page"),
    "a member's chat is offered reading tools only (no changes, no notes)",
    memberTools,
  );
  const memberSeen = fake.chats.map(everything).join("\n");
  check(!memberSeen.includes("BOARD-SECRET") && !memberSeen.includes("Board minutes"), "a page only the agent (and owner) can open is not found for the member: not read, searched or mapped");
  const memberResults = toolResults(fake.chats.at(-1)!);
  check(memberResults.some((r) => /no tool "update_row"/.test(r)), "a change asked for anyway isn't made", memberResults);
  check(memberResults.some((r) => r.includes("KB-HANDBOOK")), "what both can open is read", memberResults);
  check(memberTools.includes("use_tool") && memberResults.some((r) => r.includes("Handbook") && r.includes(handbook.id)), "a member's chat reads through Leafdesk's further tools too", memberResults);
  check(memberResults.some((r) => /no tool "set_page_archived"/.test(r)), "…but none of them changes anything", memberResults);
  const [handbookNow] = await db.execute<{ title: string }>(sql`select title from page where id = ${handbook.id}`);
  const [handbookArchived] = await db.execute<{ archived_at: string | null }>(sql`select archived_at from page where id = ${handbook.id}`);
  check(handbookNow.title === "Handbook" && handbookArchived.archived_at === null, "nothing was changed");
  check(everything(fake.chats[0]).includes("can't change anything"), "the agent is told the chat is read-only");

  // ── Conversations are each person's own ────────────────────────────────────────────────────
  check(
    (await refusal(chat.getAgentConversation(ids.other, workspaceId, helper.id, memberSent.conversation.id, place))) === "noAccess",
    "another member can't open a member's conversation",
  );
  check((await refusal(chat.getAgentConversation(ids.owner, workspaceId, helper.id, memberSent.conversation.id, place))) === "noAccess", "nor can an owner");
  check((await refusal(chat.chatTurn(ids.owner, workspaceId, memberSent.runId))) === "noAccess", "nor follow its run");
  check((await chat.agentChatInfo(ids.other, workspaceId, helper.id, place)).conversations.length === 0, "another member's block shows their own conversations only");
  check(
    (await refusal(chat.sendAgentChat(ids.other, { workspaceId, agentId: helper.id, place, conversationId: memberSent.conversation.id, message: "Hi" }))) === "noAccess",
    "nor can anyone write in it",
  );
  const runs = await agents.listAgentRuns(ids.owner, helper.id);
  const memberView = runs.find((r) => r.id === memberSent.runId);
  const ownerView = runs.find((r) => r.id === first.runId);
  check(
    memberView?.chat?.byName === "Member Mert" && memberView.chat.message === "" && memberView.answer === "" && memberView.steps.length === 0,
    "the run history shows a member's chat run without what was said",
    memberView,
  );
  check(ownerView?.chat?.message === "What did the board discuss?" && ownerView.answer !== "", "and the owner's own with it", ownerView);

  // ── The agent's own chat: one that goes on, where its other runs come in ───────────────────
  const thread = await chat.agentThread(ids.owner, workspaceId, helper.id);
  check(
    thread.conversationId === archiving.conversation.id &&
      thread.messages.length === 6 &&
      thread.messages[0].content === "What did the board discuss?" &&
      thread.messages.at(-1)?.content === "Added it.",
    "the dialog's conversations read as one, oldest first, a new message joining the latest",
    thread,
  );
  await db.insert(agentRun).values([
    {
      agentId: helper.id,
      workspaceId,
      source: { kind: "schedule" as const, scheduleId: `${RUN}-schedule`, scheduledBy: ids.owner },
      context: { actorId: ids.owner },
      prompt: "List the late orders.",
      status: "done" as const,
      answer: "Two orders are late. ORD-LATE",
    },
    {
      agentId: helper.id,
      workspaceId,
      source: { kind: "schedule" as const, scheduleId: `${RUN}-schedule-2`, scheduledBy: ids.member },
      context: { actorId: ids.member },
      prompt: "Count the orders.",
      status: "done" as const,
      answer: "Nine orders. ORD-COUNT",
    },
  ]);
  const ownerRuns = (await chat.threadRuns(ids.owner, workspaceId, helper.id)).runs;
  check(
    ownerRuns.length === 1 && ownerRuns[0].kind === "schedule" && ownerRuns[0].answer === "Two orders are late. ORD-LATE" && ownerRuns[0].task === "List the late orders.",
    "a schedule's run the owner set comes into their chat with the agent, and no one else's",
    ownerRuns,
  );
  check(!ownerRuns.some((r) => r.id === first.runId), "chat runs don't come in twice");
  const memberRuns = (await chat.threadRuns(ids.member, workspaceId, helper.id)).runs;
  check(memberRuns.length === 1 && memberRuns[0].answer.includes("ORD-COUNT"), "a member's chat shows only the runs they started", memberRuns);
  fake.setChat(() => ({ text: "Yes, two." }));
  fake.chats.length = 0;
  await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: thread.conversationId, message: "Are orders late?" });
  await flushAgentRuns();
  const asked = everything(fake.chats[0]);
  check(asked.includes("ORD-LATE") && asked.includes("on a schedule they set") && !asked.includes("ORD-COUNT"), "what it did on its own goes with the next message", asked);
  fake.chats.length = 0;
  await chat.sendAgentChat(ids.member, { workspaceId, agentId: helper.id, place, conversationId: memberSent.conversation.id, message: "Anything late?" });
  await flushAgentRuns();
  check(!everything(fake.chats[0]).includes("ORD-COUNT"), "a block's conversation doesn't take them");

  // ── Guests, limits and archived agents ─────────────────────────────────────────────────────
  check(
    (await refusal(chat.sendAgentChat(ids.guest, { workspaceId, agentId: helper.id, place, conversationId: null, message: "Hi" }))) === "guest",
    "a guest can't chat",
  );
  // A member who became a guest while their message waited gets no answer.
  fake.setChat(() => ({ text: "Should not answer." }));
  const late = await chat.sendAgentChat(ids.other, { workspaceId, agentId: helper.id, place, conversationId: null, message: "Hello" });
  await db.update(workspaceMember).set({ role: "guest" }).where(sql`${workspaceMember.userId} = ${ids.other} and ${workspaceMember.workspaceId} = ${workspaceId}`);
  await flushAgentRuns();
  const [lateRun] = await db.select().from(agentRun).where(eq(agentRun.id, late.runId));
  const lateConversation = await db.select().from(agentConversation).where(eq(agentConversation.id, late.conversation.id));
  check(
    lateRun.status === "failed" && lateRun.code === "noAccess" && lateConversation[0].messages.at(-1)?.code === "noAccess",
    "a run whose person is now a guest fails, and the chat says why",
    { lateRun, messages: lateConversation[0].messages },
  );

  await agents.updateAgent(ids.owner, helper.id, { monthlyTokenLimit: 1 });
  check((await chat.agentChatInfo(ids.member, workspaceId, helper.id, place)).state === "limitReached", "an agent over its monthly limit shows so");
  check(
    (await refusal(chat.sendAgentChat(ids.member, { workspaceId, agentId: helper.id, place, conversationId: null, message: "Hi" }))) === "limitReached",
    "and takes no message",
  );
  await agents.updateAgent(ids.owner, helper.id, { monthlyTokenLimit: null });
  await agents.archiveAgent(ids.owner, helper.id);
  const archivedInfo = await chat.agentChatInfo(ids.member, workspaceId, helper.id, place);
  check(archivedInfo.state === "gone" && archivedInfo.agent === null, "an archived agent is no longer available", archivedInfo);
  check(
    (await refusal(chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: null, message: "Hi" }))) === "gone",
    "not even to an owner",
  );

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...Object.values(ids), ...botUsers]));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
