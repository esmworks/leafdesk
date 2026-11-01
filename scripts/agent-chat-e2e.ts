/**
 * End-to-end check of chatting with agents (lib/agent-chat.ts) against the database, with a fake
 * OpenAI-compatible server scripted per message: an owner chats with an agent in its dialog and in
 * a page's block with its full tools (pages it may change, its memory), each message one of its
 * runs (source `chat`, in its history and usage); a member it is shared with to view and interact
 * chats in its dialog, or in a block on a page they can open that holds that chat, read-only and
 * within what both they and the agent can open (a page only the agent and the owner see is not
 * found for them, whatever the model asks for); guests, archived agents and agents over their
 * monthly limit don't chat; each person's conversations are theirs alone (owners don't see a
 * member's, members don't see each other's); messages written while it answers wait (five at most,
 * each removable until it went) and go as one next turn, one holding another app's message never
 * keeping a correction at once, and messages left waiting going with the next one; text files go to
 * the model framed, and a file it attaches is the person's alone; a conversation goes on from its
 * summary; a person searches their own conversations only; the last turn is done again or edited
 * (as it was asked, its answer's files gone); exported Markdown names the agent and nothing said.
 * Creates its own users and workspace and deletes them afterwards.
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
const { conversationFile: agentChatFile, conversation: agentConversation, agentRun, agentUsage, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { asWrite, runAsConnectedApp } = await import("@/server/connected-app");
const { purgeOrphanFiles } = await import("@/server/files");
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
const { followLiveText } = await import("@/server/agents/live-text");
const { chatFileOfPerson } = await import("@/server/agents/chat-files");
const { refOf, storageOf } = await import("@/server/storage/workspace");
const { pageMarkdown } = await import("@/server/export");
const { agentChatLine, agentMessages, applyLiveEdit } = await import("@/lib/agent-chat");

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
  check(first.runId !== null && first.queued === null, "a message to a conversation with no answer under way starts a run at once");
  await flushAgentRuns();
  const [ownerRun] = await db.select().from(agentRun).where(eq(agentRun.id, first.runId!));
  check(ownerRun.status === "done" && ownerRun.source.kind === "chat" && ownerRun.source.userId === ids.owner, "the owner's message is a run with the chat source", ownerRun);
  const ownerTools = toolNames(fake.chats[0]);
  check(["create_row", "update_row", "create_page", "edit_page"].every((n) => ownerTools.includes(n)), "an owner's chat is offered the tools that change pages", ownerTools);
  check(toolResults(fake.chats.at(-1)!).some((r) => r.includes("BOARD-SECRET")), "an owner's chat reads what both the owner and the agent can open");
  const turn = await chat.chatTurn(ids.owner, workspaceId, first.runId!);
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

  // ── The answer as it is written ────────────────────────────────────────────────────────────
  const written = "Orders ship on Tuesdays and Thursdays, from the north depot, before noon.";
  fake.setChat(() => ({ text: written }));
  fake.delayMs = 15;
  const writing = await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: first.conversation.id, message: "When do orders ship?" });
  check(await chat.mayFollowChatTurn(ids.owner, workspaceId, writing.runId!), "the person chatting may follow what the run writes");
  check(!(await chat.mayFollowChatTurn(ids.member, workspaceId, writing.runId!)), "no one else may");
  const followingWriting = new AbortController();
  const seen: string[] = [];
  let liveText = "";
  const following = (async () => {
    for await (const edit of followLiveText(writing.runId!, followingWriting.signal)) {
      liveText = applyLiveEdit(liveText, edit);
      seen.push(liveText);
    }
  })();
  await flushAgentRuns();
  followingWriting.abort();
  await following;
  fake.delayMs = 0;
  const grown = seen.filter(Boolean);
  check(grown.length >= 5 && grown.every((t, i) => i === 0 || t.startsWith(grown[i - 1])), "the answer is followed as it grows, word by word", seen);
  check(liveText === written && (await chat.chatTurn(ids.owner, workspaceId, writing.runId!)).answer === written, "and ends as the answer the run keeps", liveText);

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
  const archivingTurn = await chat.chatTurn(ids.owner, workspaceId, archiving.runId!);
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
  const [memberRun] = await db.select().from(agentRun).where(eq(agentRun.id, memberSent.runId!));
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
  check((await refusal(chat.chatTurn(ids.owner, workspaceId, memberSent.runId!))) === "noAccess", "nor follow its run");
  check((await chat.agentChatInfo(ids.other, workspaceId, helper.id, place)).conversations.length === 0, "another member's block shows their own conversations only");
  check(
    (await refusal(chat.sendAgentChat(ids.other, { workspaceId, agentId: helper.id, place, conversationId: memberSent.conversation.id, message: "Hi" }))) === "noAccess",
    "nor can anyone write in it",
  );
  const runs = await agents.listAgentRuns(ids.owner, helper.id);
  const memberView = runs.find((r) => r.id === memberSent.runId!);
  const ownerView = runs.find((r) => r.id === first.runId!);
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
      thread.messages.length === 8 &&
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
  check(!ownerRuns.some((r) => r.id === first.runId!), "chat runs don't come in twice");
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

  // ── Messages written while it answers wait, and go as one turn ─────────────────────────────
  fake.setChat((request) => ({ text: everything(request).includes("QUEUED-ONE") ? "Answered both." : "Answered the first." }));
  fake.chats.length = 0;
  const asking = await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: null, message: "First question" });
  const talk = asking.conversation.id;
  const queue = (message: string) => chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: talk, message });
  const one = await queue("Also QUEUED-ONE");
  check(one.runId === null && one.queued?.content === "Also QUEUED-ONE", "a message written while the agent answers waits in the queue", one);
  await queue("And QUEUED-TWO");
  const dropped = await queue("Never mind QUEUED-DROPPED");
  const fourth = await queue("QUEUED-FOUR");
  const fifth = await queue("QUEUED-FIVE");
  check((await refusal(queue("A sixth"))) === "queueFull", "a sixth is refused while five wait");
  const removals = [];
  for (const item of [dropped, fourth, fifth]) removals.push(await chat.removeQueuedAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: talk, queuedId: item.queued!.id }));
  check(removals.every((r) => r.removed) && removals.at(-1)?.queued.length === 2, "a message taken out of the queue says it was there", removals);
  check(one.runId === null && one.behind === asking.runId, "a queued message names the answer it waits for", one);
  check(
    (await refusal(chat.removeQueuedAgentChat(ids.member, { workspaceId, agentId: helper.id, place, conversationId: talk, queuedId: one.queued!.id }))) === "noAccess",
    "no one else takes a message out of the queue",
  );
  const waiting = await chat.getAgentConversation(ids.owner, workspaceId, helper.id, talk, place);
  check(waiting.queued.map((q) => q.content).join("|") === "Also QUEUED-ONE|And QUEUED-TWO" && waiting.running === asking.runId, "a removed message leaves the queue; the rest wait in order", waiting.queued);
  await flushAgentRuns();
  const answered = await chat.getAgentConversation(ids.owner, workspaceId, helper.id, talk, place);
  check(
    answered.messages.map((m) => `${m.role}:${m.content}`).join("|") === "user:First question|assistant:Answered the first.|user:Also QUEUED-ONE|user:And QUEUED-TWO|assistant:Answered both." &&
      answered.queued.length === 0 &&
      answered.running === null,
    "once the answer ends, the waiting messages go together as the next turn, each kept as asked",
    answered.messages,
  );
  const nextRunId = answered.messages[2].runId;
  check(nextRunId === answered.messages[3].runId && nextRunId !== asking.runId, "…in one run");
  const [nextRun] = await db.select().from(agentRun).where(eq(agentRun.id, nextRunId));
  check(
    nextRun.prompt === "Also QUEUED-ONE\n\nAnd QUEUED-TWO" && nextRun.source.kind === "chat" && nextRun.source.after === asking.runId && !nextRun.source.fromApp,
    "its prompt is the messages in order, and it follows the run before",
    nextRun,
  );
  const queuedAsked = everything(fake.chats.at(-1)!);
  check(queuedAsked.includes("First question") && queuedAsked.includes("Answered the first.") && !queuedAsked.includes("QUEUED-DROPPED"), "the model reads the turn after the one before it, without the removed message");
  check((await chat.chatTurn(ids.owner, workspaceId, asking.runId!)).next === nextRunId, "the ended turn names the run that took the queue");
  const alreadySent = await chat.removeQueuedAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: talk, queuedId: one.queued!.id });
  check(!alreadySent.removed && alreadySent.queued.length === 0, "taking out a message that went meanwhile says it was already sent", alreadySent);

  // ── Another app's message and a Telegram one in one turn ───────────────────────────────────
  fake.setChat((request) =>
    everything(request).includes("MIXED-TG") ? caller([{ name: "remember", arguments: { text: "Mixed turns go to Finance.", kind: "correction" } }], "Noted both.")(request) : { text: "Answered the opener." },
  );
  const opener = await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: null, message: "Opener" });
  const mixedId = opener.conversation.id;
  const asApp = (message: string, via?: "telegram") =>
    runAsConnectedApp({ userId: ids.owner }, () => asWrite(() => chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: mixedId, message, ...(via ? { via } : {}) })));
  await asApp("From another app MIXED-MCP");
  await asApp("From Telegram MIXED-TG", "telegram");
  fake.chats.length = 0;
  await flushAgentRuns();
  const mixed = await chat.getAgentConversation(ids.owner, workspaceId, helper.id, mixedId, place);
  const [mixedRun] = await db.select().from(agentRun).where(eq(agentRun.id, mixed.messages.at(-1)!.runId));
  check(
    mixedRun.source.kind === "chat" && mixedRun.source.fromApp === true && mixedRun.source.telegram === true && mixedRun.source.otherApp === true,
    "a turn of another app's message and a Telegram one is marked as holding another app's words",
    mixedRun.source,
  );
  const mixedResults = toolResults(fake.chats.at(-1)!);
  check(
    toolNames(fake.chats.at(-1)!).includes("remember") && mixedResults.length === 1 && !mixedResults[0].startsWith("Kept at once"),
    "…so a correction in it is only proposed, never kept at once",
    mixedResults,
  );
  const single = await runAsConnectedApp({ userId: ids.owner }, () =>
    asWrite(() => chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: null, message: "Only from Telegram", via: "telegram" })),
  );
  const [singleRun] = await db.select({ source: agentRun.source }).from(agentRun).where(eq(agentRun.id, single.runId!));
  check(singleRun.source.kind === "chat" && singleRun.source.telegram === true && !singleRun.source.otherApp, "a message from Telegram alone isn't another app's", singleRun.source);
  await flushAgentRuns();

  // ── Messages left waiting go with the next one ─────────────────────────────────────────────
  await db
    .update(agentConversation)
    .set({ queue: [{ id: `${RUN}-left`, content: "LEFTOVER-ONE", at: new Date().toISOString() }] })
    .where(eq(agentConversation.id, mixedId));
  fake.setChat(() => ({ text: "- A summary LEFT-SUMMARY" }));
  const leftSummary = await chat.summarizeAgentConversation(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: mixedId });
  check(leftSummary.summary.includes("LEFT-SUMMARY"), "messages left waiting with no answer under way don't hold up a summary");
  fake.setChat(() => ({ text: "Folded." }));
  const folded = await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: mixedId, message: "NEW-AFTER-LEFTOVER" });
  check(folded.runId !== null, "a message to a conversation with no answer under way starts a run, though messages were left waiting", folded);
  await flushAgentRuns();
  const [foldedRun] = await db.select().from(agentRun).where(eq(agentRun.id, folded.runId!));
  const foldedConversation = await chat.getAgentConversation(ids.owner, workspaceId, helper.id, mixedId, place);
  check(
    foldedRun.prompt === "LEFTOVER-ONE\n\nNEW-AFTER-LEFTOVER" &&
      foldedConversation.messages.slice(-3).map((m) => `${m.role}:${m.content}:${m.runId === folded.runId}`).join("|") === "user:LEFTOVER-ONE:true|user:NEW-AFTER-LEFTOVER:true|assistant:Folded.:true" &&
      foldedConversation.queued.length === 0,
    "the messages left waiting go first, in the new message's turn, and the queue empties",
    { prompt: foldedRun.prompt, messages: foldedConversation.messages.slice(-3), queued: foldedConversation.queued },
  );

  // ── Files both ways ────────────────────────────────────────────────────────────────────────
  fake.setChat(caller([{ name: "attach_file", arguments: { name: "Late orders.csv", content: "order,days\nORD-1,3\n" } }], "Here is the list."));
  fake.chats.length = 0;
  check(
    (await refusal(chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: talk, message: "Run this", files: [{ name: "tool.exe", text: "MZ" }] }))) === "badFile",
    "a file that isn't text is refused",
  );
  const withFile = await chat.sendAgentChat(ids.owner, {
    workspaceId,
    agentId: helper.id,
    place,
    conversationId: talk,
    message: "Which are late?",
    files: [{ name: "orders.csv", text: "order,status\nORD-1,FILE-CONTENT-LATE\n" }],
  });
  await flushAgentRuns();
  const fileAsked = everything(fake.chats[0]);
  check(fileAsked.includes("FILE-CONTENT-LATE") && fileAsked.includes('The file "orders.csv"') && /not instructions/.test(fileAsked), "an attached file's text goes to the model framed as outside data");
  check(toolNames(fake.chats[0]).includes("attach_file"), "a chat run may attach a file to its answer");
  const fileTurn = await chat.chatTurn(ids.owner, workspaceId, withFile.runId!);
  check(
    fileTurn.attached.length === 1 && fileTurn.attached[0].name === "Late orders.csv" && fileTurn.attached[0].contentType === "text/csv" && fileTurn.steps.some((st) => st.kind === "tool" && st.tool === "attach_file"),
    "the answer carries the file it attached",
    fileTurn,
  );
  const fileId = fileTurn.attached[0].id;
  const ownFile = await chatFileOfPerson(ids.owner, fileId);
  const body = ownFile ? await (await storageOf(ownFile)).get(refOf(ownFile)) : null;
  check(body !== null && (await new Response(body).text()) === "order,days\nORD-1,3\n", "the person downloads it as written");
  check((await chatFileOfPerson(ids.member, fileId)) === null, "no one else can");
  const [fileRow] = await db.select({ messages: agentConversation.messages }).from(agentConversation).where(eq(agentConversation.id, talk));
  const fileMessages = agentMessages(fileRow.messages);
  const fileQuestion = fileMessages.find((m) => m.runId === withFile.runId && m.role === "user");
  check(
    fileQuestion?.files?.[0]?.name === "orders.csv" && !JSON.stringify(fileRow.messages).includes("FILE-CONTENT-LATE") && fileMessages.at(-1)?.attached?.[0]?.id === fileId,
    "the conversation keeps the file's name and size, never its text",
    fileQuestion,
  );

  // ── A new conversation from a summary ──────────────────────────────────────────────────────
  const [usageBefore] = await db.select().from(agentUsage).where(eq(agentUsage.agentId, helper.id));
  fake.setChat(() => ({ text: "- Asked which orders are late\n- SUMMARY-MARK" }));
  fake.chats.length = 0;
  const summarized = await chat.summarizeAgentConversation(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: talk });
  check(summarized.summary.includes("SUMMARY-MARK") && summarized.conversation.id !== talk, "a summary starts a new conversation", summarized);
  check(everything(fake.chats[0]).includes("QUEUED-ONE") && everything(fake.chats[0]).includes("Late orders.csv") && toolNames(fake.chats[0]).length === 0, "one model call, without tools, reads the conversation to sum it up");
  const [usageAfter] = await db.select().from(agentUsage).where(eq(agentUsage.agentId, helper.id));
  check(usageAfter.inputTokens > usageBefore.inputTokens && usageAfter.runs === usageBefore.runs, "the call counts in the agent's usage, not as a run", { usageBefore, usageAfter });
  const fresh = await chat.getAgentConversation(ids.owner, workspaceId, helper.id, summarized.conversation.id, place);
  check(fresh.messages.length === 1 && fresh.messages[0].summary === true && fresh.messages[0].content.includes("SUMMARY-MARK"), "the new conversation begins with the summary");
  fake.setChat(() => ({ text: "Go on with ORD-1." }));
  fake.chats.length = 0;
  await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: summarized.conversation.id, message: "What next?" });
  await flushAgentRuns();
  const afterSummary = everything(fake.chats[0]);
  check(afterSummary.includes("SUMMARY-MARK") && !afterSummary.includes("QUEUED-ONE"), "the model reads the summary as what was said before, not the old conversation");

  // ── Searching one's own conversations ──────────────────────────────────────────────────────
  const hits = await chat.searchAgentChats(ids.owner, workspaceId, helper.id, "queued-two");
  check(
    hits.length === 1 && hits[0].conversationId === talk && hits[0].chatId === chatId && hits[0].pageId === chatPage.id && hits[0].snippet.match === "QUEUED-TWO",
    "a search finds the person's message, in the block it was written in, on a page they open",
    hits,
  );
  const threadHits = await chat.searchAgentChats(ids.owner, workspaceId, helper.id, "board discuss");
  check(threadHits.length > 0 && threadHits.every((h) => h.chatId === null && h.pageId === null), "and messages of the agent's own chat", threadHits);
  check((await chat.searchAgentChats(ids.member, workspaceId, helper.id, "QUEUED-TWO")).length === 0, "never someone else's");
  const memberHits = await chat.searchAgentChats(ids.member, workspaceId, helper.id, "lunch");
  check(memberHits.length > 0 && memberHits.every((h) => h.conversationId === memberSent.conversation.id), "a member finds their own", memberHits);
  check((await chat.searchAgentChats(ids.owner, workspaceId, helper.id, "q")).length === 0, "a search of one letter finds nothing");

  // ── Doing the last turn again ──────────────────────────────────────────────────────────────
  const freshId = summarized.conversation.id;
  const lastBefore = (await chat.getAgentConversation(ids.owner, workspaceId, helper.id, freshId, place)).messages;
  const oldRunId = lastBefore.at(-1)!.runId;
  fake.setChat(() => ({ text: "Second try." }));
  fake.chats.length = 0;
  await chat.redoAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: freshId, message: null });
  await flushAgentRuns();
  const regenerated = (await chat.getAgentConversation(ids.owner, workspaceId, helper.id, freshId, place)).messages;
  check(
    regenerated.map((m) => m.content).join("|") === `${lastBefore[0].content}|What next?|Second try.` && regenerated[1].runId !== oldRunId,
    "Regenerate drops the last answer and asks again in a new run",
    regenerated,
  );
  check(!everything(fake.chats[0]).includes("Go on with ORD-1."), "the dropped answer isn't in what the model reads");
  const [oldRun] = await db.select({ status: agentRun.status }).from(agentRun).where(eq(agentRun.id, oldRunId));
  check(oldRun?.status === "done", "the old run stays in the agent's history");
  fake.setChat(() => ({ text: "Edited answer." }));
  await chat.redoAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: freshId, message: "What now, EDITED?" });
  await flushAgentRuns();
  const edited = (await chat.getAgentConversation(ids.owner, workspaceId, helper.id, freshId, place)).messages;
  check(edited.length === 3 && edited[1].content === "What now, EDITED?" && edited[2].content === "Edited answer.", "Edit changes the last question and answers it anew", edited);
  fake.setChat(() => ({ text: "Later." }));
  await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: freshId, message: "Wait" });
  check(
    (await refusal(chat.redoAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: freshId, message: null }))) === "nothingToRedo",
    "nothing is done again while an answer is under way",
  );
  check(
    (await refusal(chat.redoAgentChat(ids.member, { workspaceId, agentId: helper.id, place, conversationId: freshId, message: null }))) === "noAccess",
    "nor in someone else's conversation",
  );
  await flushAgentRuns();

  // A turn asked from a connected app, on its clock, whose answer attached a file: done again as it was asked, the file gone with the answer.
  fake.setChat(caller([{ name: "attach_file", arguments: { name: "Redo.csv", content: "a,b\n1,2\n" } }], "Attached."));
  const appTurn = await runAsConnectedApp({ userId: ids.owner }, () =>
    asWrite(() => chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: null, message: "Make a file", timeZone: "Europe/Istanbul" })),
  );
  await flushAgentRuns();
  const appTurnFile = (await chat.chatTurn(ids.owner, workspaceId, appTurn.runId!)).attached[0];
  check(appTurnFile?.name === "Redo.csv", "the turn's answer attached a file", appTurnFile);
  fake.setChat(() => ({ text: "Again, without a file." }));
  const redone = await chat.redoAgentChat(ids.owner, { workspaceId, agentId: helper.id, place, conversationId: appTurn.conversation.id, message: null });
  const [redoneRun] = await db.select().from(agentRun).where(eq(agentRun.id, redone.runId));
  check(
    redoneRun.source.kind === "chat" && redoneRun.source.fromApp === true && redoneRun.source.otherApp === true && "timeZone" in redoneRun.context && redoneRun.context.timeZone === "Europe/Istanbul",
    "Regenerate in the app asks again as the question was asked: from the connected app, on its clock",
    { source: redoneRun.source, context: redoneRun.context },
  );
  const filesLeft = await db.select().from(agentChatFile).where(eq(agentChatFile.runId, appTurn.runId!));
  await purgeOrphanFiles(workspaceId);
  check(filesLeft.length === 0 && (await chatFileOfPerson(ids.owner, appTurnFile.id)) === null, "the dropped answer's file goes from the chat, and the orphan sweep removes it", filesLeft);
  await flushAgentRuns();

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
  const [lateRun] = await db.select().from(agentRun).where(eq(agentRun.id, late.runId!));
  const lateConversation = await db.select().from(agentConversation).where(eq(agentConversation.id, late.conversation.id));
  check(
    lateRun.status === "failed" && lateRun.code === "noAccess" && agentMessages(lateConversation[0].messages).at(-1)?.code === "noAccess",
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
