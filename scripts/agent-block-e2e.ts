/**
 * End-to-end check of the Agent block (lib/agent-block.ts) against the database: a page holding
 * the block lets the people who can open it ask the agent in a conversation of their own for that
 * page (chat id `pageAgent:<page>`), under the agent's own sharing rule (a member it is shared with
 * asks read-only, a guest not at all); a page without the block, another page's id in the place or
 * a page the person can't open refuses with `notOnPage`; removing the block takes the place away;
 * conversations are their person's alone; a search finds the page holding a block's conversation;
 * exported Markdown names the agent and nothing said. No model is called: the agents' worker
 * never runs in this script, so the messages' runs stay queued and are deleted with the workspace.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-block-e2e.ts
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
const { conversation: agentConversation, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setAiEnv } = await import("@/server/ai/testing");
const agents = await import("@/server/agents/manage");
const chat = await import("@/server/agents/chat");
const { pageMarkdown } = await import("@/server/export");
const { agentBlockLine, pageAgentChatId, pageAgentPlace } = await import("@/lib/agent-block");

const RUN = `agent-block-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
// A configured model that is never called: nothing here runs an agent.
setAiEnv({ AI_PROVIDER: "openai-compatible", AI_MODEL: "unused", AI_BASE_URL: "http://127.0.0.1:9", AI_WORKSPACE_RATE_LIMIT: "1000", AI_RATE_LIMIT: "1000" });

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
  const withBlock = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Ask the helper", markdown: `Ask here:\n\n${agentBlockLine(helper.id)}\n` });
  const without = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Plain page", markdown: "Nothing to ask here." });
  const privateWithBlock = await createPage(owner, { workspaceId, teamspaceId: null, title: "Private ask", markdown: `${agentBlockLine(helper.id)}\n` });
  const place = pageAgentPlace(withBlock.id);

  // ── The block in Markdown ──────────────────────────────────────────────────────────────────
  const [stored] = await db.execute<{ content_markdown: string }>(sql`select content_markdown from page where id = ${withBlock.id}`);
  check(stored.content_markdown.includes(agentBlockLine(helper.id)), "the page's stored Markdown keeps the block's line", stored.content_markdown);
  const exported = await pageMarkdown(ids.owner, withBlock.id);
  check(exported.body.includes("Agent chat: Helper") && !exported.body.includes("leafdesk:agent"), "exported Markdown names the agent and nothing else", exported.body);

  // ── Where people stand ─────────────────────────────────────────────────────────────────────
  check((await chat.agentChatInfo(ids.owner, workspaceId, helper.id, place)).state === "full", "an owner asks with full tools");
  check((await chat.agentChatInfo(ids.member, workspaceId, helper.id, place)).state === "readOnly", "a member the agent is shared with asks read-only");
  const guest = await chat.agentChatInfo(ids.guest, workspaceId, helper.id, place);
  check(guest.state === "guest" && guest.agent === null, "a guest gets no block and learns nothing of the agent", guest);

  // ── Asking ─────────────────────────────────────────────────────────────────────────────────
  const sent = await chat.sendAgentChat(ids.member, { workspaceId, agentId: helper.id, place, conversationId: null, message: "Where is lunch? BLOCK-NEEDLE" });
  const [row] = await db.select().from(agentConversation).where(eq(agentConversation.id, sent.conversation.id));
  check(row.chatId === pageAgentChatId(withBlock.id) && row.userId === ids.member && row.agentId === helper.id, "a message is kept in the person's conversation for this page and agent", row);
  const again = await chat.sendAgentChat(ids.member, { workspaceId, agentId: helper.id, place, conversationId: sent.conversation.id, message: "Thanks" });
  check(again.conversation.id === sent.conversation.id, "later messages go on in the same conversation");
  check((await chat.agentChatInfo(ids.member, workspaceId, helper.id, place)).conversations.length === 1, "which the block finds again");

  check((await chat.agentChatInfo(ids.other, workspaceId, helper.id, place)).conversations.length === 0, "another member sees none of it");
  check((await refusal(chat.getAgentConversation(ids.other, workspaceId, helper.id, sent.conversation.id, place))) === "noAccess", "and can't open it");
  check((await refusal(chat.getAgentConversation(ids.owner, workspaceId, helper.id, sent.conversation.id, place))) === "noAccess", "nor can an owner");

  // ── Where it may be asked ──────────────────────────────────────────────────────────────────
  const ask = (as: string, at: { chatId: string; pageId: string }) => refusal(chat.sendAgentChat(as, { workspaceId, agentId: helper.id, place: at, conversationId: null, message: "Hi" }));
  check((await ask(ids.member, pageAgentPlace(without.id))) === "notOnPage", "a page without the block takes no message");
  check((await ask(ids.member, { chatId: pageAgentChatId(without.id), pageId: withBlock.id })) === "notOnPage", "nor does another page's id in the place");
  check((await ask(ids.member, { chatId: "pageAgent:", pageId: withBlock.id })) === "notOnPage", "nor an empty one");
  check((await ask(ids.other, pageAgentPlace(privateWithBlock.id))) === "notOnPage", "a page the person can't open takes none, whatever it holds");
  check((await ask(ids.guest, place)) === "guest", "a guest can't ask");

  // ── Finding it again ───────────────────────────────────────────────────────────────────────
  const hits = await chat.searchAgentChats(ids.member, workspaceId, helper.id, "BLOCK-NEEDLE");
  check(hits.length === 1 && hits[0].pageId === withBlock.id && hits[0].chatId === pageAgentChatId(withBlock.id), "a search finds the page holding the block's conversation", hits);
  check((await chat.searchAgentChats(ids.other, workspaceId, helper.id, "BLOCK-NEEDLE")).length === 0, "and only the person's own");

  // ── The block goes ─────────────────────────────────────────────────────────────────────────
  await db.execute(sql`update page set content_markdown = 'Gone.' where id = ${withBlock.id}`);
  check((await ask(ids.member, place)) === "notOnPage", "once the page no longer holds the block, nothing more is taken");
  check((await chat.searchAgentChats(ids.member, workspaceId, helper.id, "BLOCK-NEEDLE"))[0]?.pageId === null, "and the search no longer names the page");

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...Object.values(ids), ...botUsers]));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
