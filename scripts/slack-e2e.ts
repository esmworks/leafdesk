/**
 * End-to-end check of the AI chat from Slack (src/server/slack, over the chat-app bot in
 * src/server/chat-apps) against the database, with a fake Slack Web API and a fake Socket Mode
 * websocket server (written by hand here: no websocket package), and a fake OpenAI-compatible model
 * (src/server/ai/fake-openai.ts), all reached over the network as the server reaches Slack:
 * Socket Mode opened and every envelope acknowledged; linking an account with `/leafdesk link
 * <code>`; a question in the direct message answered in mrkdwn with its sources as links;
 * `/leafdesk new`; a change approved and one declined with the message's buttons; notifications
 * delivered with Mark read and marked read from there, kept out by the chat apps' preference
 * column; an agent's call sent back with a note written in the message's thread; chatting with an
 * agent picked with `/leafdesk agent`; and messages in a channel ignored (a command there answered
 * only to its writer). Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/slack-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server on
 * the same database (a server's agents' worker would take the agent's runs).
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

try {
  process.loadEnvFile();
} catch {}

const APP_TOKEN = "xapp-1-test-app-token";
const BOT_TOKEN = "xoxb-test-bot-token";

// ── A fake Web API ──────────────────────────────────────────────────────────────────────────────
type Call = { method: string; params: Record<string, unknown>; ts?: string };
const calls: Call[] = [];
let tsCounter = 0;
const nextTs = () => `1800000000.${String(++tsCounter).padStart(6, "0")}`;
const SUFFIX = Date.now().toString(36).toUpperCase();
const SLACK_ALICE = `UA${SUFFIX}`;
const SLACK_MALLORY = `UM${SUFFIX}`;
const imOf = (userId: string) => `D${userId.slice(1)}`;
const IM_ALICE = imOf(SLACK_ALICE);
const IM_MALLORY = imOf(SLACK_MALLORY);
const CHANNEL = `C${SUFFIX}`;

const paramsOf = (raw: string): Record<string, unknown> => {
  const params: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    params[key] = (key === "blocks" || key === "files") && value.startsWith("[") ? JSON.parse(value) : value;
  }
  return params;
};

const slack: Server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const method = (req.url ?? "").replace(/^\/api\//, "").replace(/^\//, "");
  const answer = (result: Record<string, unknown>) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...result }));
  if (method === "respond") {
    calls.push({ method, params: JSON.parse(raw) as Record<string, unknown> });
    return void res.writeHead(200).end("ok");
  }
  const auth = String(req.headers.authorization ?? "");
  const wants = method === "apps.connections.open" ? APP_TOKEN : BOT_TOKEN;
  if (auth !== `Bearer ${wants}`) return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "invalid_auth" }));
  const params = paramsOf(raw);
  const call: Call = { method, params };
  calls.push(call);
  const port = (slack.address() as AddressInfo).port;
  switch (method) {
    case "auth.test":
      return answer({ user: "leafdesk", user_id: "UBOT", team_id: "T1", bot_id: "B1" });
    case "bots.info":
      return answer({ bot: { id: "B1", app_id: "A1" } });
    case "apps.connections.open":
      return answer({ url: `ws://127.0.0.1:${port}/socket?ticket=secret-ticket` });
    case "conversations.open":
      return answer({ channel: { id: imOf(String(params.users)) } });
    case "users.info": {
      const id = String(params.user);
      const name = id === SLACK_ALICE ? "Alice" : "Mallory";
      return answer({ user: { id, name: name.toLowerCase(), real_name: name, profile: { display_name: name }, locale: "en-US" } });
    }
    case "chat.postMessage":
      call.ts = nextTs();
      return answer({ channel: params.channel, ts: call.ts });
    case "chat.update":
      return answer({ channel: params.channel, ts: params.ts });
    case "chat.postEphemeral":
      return answer({ message_ts: nextTs() });
    case "conversations.history":
      return answer({ messages: [] });
    default:
      return answer({});
  }
});

// ── A fake Socket Mode server ───────────────────────────────────────────────────────────────────
/** The connected client (the server's Slack bot) and the envelopes it acknowledged. */
let client: Duplex | null = null;
const acked = new Set<string>();
let connections = 0;

/** A text frame from the server (unmasked). */
function frame(text: string, opcode = 0x1) {
  const data = Buffer.from(text);
  let head: Buffer;
  if (data.length < 126) head = Buffer.from([0x80 | opcode, data.length]);
  else if (data.length < 65_536) head = Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([head, data]);
}

slack.on("upgrade", (req, socket: Duplex) => {
  const key = String(req.headers["sec-websocket-key"] ?? "");
  if (!req.url?.startsWith("/socket?ticket=secret-ticket") || !key) return void socket.destroy();
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  connections += 1;
  client = socket;
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i % 4)];
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x1) {
        const { envelope_id: id } = JSON.parse(payload.toString()) as { envelope_id?: string };
        if (id) acked.add(id);
      } else if (opcode === 0x8) {
        socket.end(frame("", 0x8));
        if (client === socket) client = null;
        return;
      } else if (opcode === 0x9) socket.write(frame(payload.toString(), 0xa));
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    if (client === socket) client = null;
  });
  socket.write(frame(JSON.stringify({ type: "hello", num_connections: 1 })));
});

await new Promise<void>((resolve) => slack.listen(0, "127.0.0.1", resolve));
const API = `http://127.0.0.1:${(slack.address() as AddressInfo).port}/api`;
process.env.SLACK_APP_TOKEN = APP_TOKEN;
process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
process.env.SLACK_API_URL = API;
delete process.env.TELEGRAM_BOT_TOKEN;
process.env.APP_URL = "https://leaf.test";

// Imported after the env is set: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, auditEvent, channelLink, channelLinkCode, conversation, notification, page, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { recordShare } = await import("@/server/notifications");
const { flushPush } = await import("@/server/push");
const { setNotificationPreference } = await import("@/server/notification-preferences");
const { createAgent } = await import("@/server/agents/manage");
const { flushAgentRuns } = await import("@/server/agents/run");
const { notifyApprovers } = await import("@/server/connections/approvals");
const { resetAi, setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const { startSlack, flushSlack } = await import("@/server/slack");
const { createSlackLinkCode, getSlackStatus } = await import("@/server/slack/links");

const RUN = `slack-e2e-${Date.now().toString(36)}`;
const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
setAiEnv({ AI_PROVIDER: "openai-compatible", AI_MODEL: "fake-chat", AI_BASE_URL: fake.baseUrl, AI_WORKSPACE_RATE_LIMIT: "1000", AI_RATE_LIMIT: "1000" });

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(find: () => T | undefined | null | false | Promise<T | undefined | null | false>, label: string, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const found = await find();
    if (found) return found;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(20);
  }
}

// ── Envelopes as Slack sends them ───────────────────────────────────────────────────────────────
let envelopes = 0;
/** Sends an envelope over the socket; resolves once the bot acknowledged it (and so is handling it). */
async function envelope(type: string, payload: Record<string, unknown>) {
  const socket = await until(() => client, "the Socket Mode connection");
  const id = `env-${++envelopes}`;
  socket.write(frame(JSON.stringify({ envelope_id: id, type, payload, accepts_response_payload: false })));
  await until(() => acked.has(id), `the ack of ${id}`);
}
const message = (from: string, text: string, extra: Record<string, unknown> = {}) =>
  envelope("events_api", {
    event_id: `Ev${++envelopes}`,
    event: { type: "message", channel: imOf(from), channel_type: "im", user: from, text, ts: nextTs(), ...extra },
  });
const command = (from: string, text: string, channel = imOf(from)) =>
  envelope("slash_commands", { command: "/leafdesk", text, user_id: from, channel_id: channel, response_url: `${API.replace(/\/api$/, "")}/respond` });
/** A press of the button with this value on a message the bot sent. */
const press = (from: string, value: string, sentMessage: Call) =>
  envelope("interactive", {
    type: "block_actions",
    user: { id: from, username: from === SLACK_ALICE ? "alice" : "mallory", name: from === SLACK_ALICE ? "alice" : "mallory" },
    channel: { id: String(sentMessage.params.channel) },
    container: { type: "message", message_ts: sentMessage.ts, channel_id: String(sentMessage.params.channel) },
    message: { ts: sentMessage.ts, text: String(sentMessage.params.text ?? ""), blocks: sentMessage.params.blocks },
    actions: [{ action_id: "b0", value, action_ts: nextTs() }],
    trigger_id: `trigger-${envelopes}`,
  });

/** What the blocks of a posted or updated message say, sections joined. */
const textOfBlocks = (call: Call) =>
  ((call.params.blocks as { type: string; text?: { text: string } }[] | undefined) ?? []).filter((b) => b.type === "section").map((b) => b.text?.text ?? "").join("\n");
const valuesOf = (call: Call) =>
  ((call.params.blocks as { type: string; elements?: { value?: string; text: { text: string } }[] }[] | undefined) ?? []).flatMap((b) => (b.type === "actions" ? (b.elements ?? []) : []));
/** Messages the bot posted to a chat since `from` (an index into `calls`). */
const postedTo = (chat: string, from = 0) => calls.slice(from).filter((c) => c.method === "chat.postMessage" && c.params.channel === chat);
const said = (chat: string, from = 0) => postedTo(chat, from).map(textOfBlocks).join("\n---\n");
/** What a chat showed since `from`, posted or updated, in order. */
const shownIn = (chat: string, from = 0) =>
  calls.slice(from).filter((c) => (c.method === "chat.postMessage" || c.method === "chat.update") && c.params.channel === chat).map(textOfBlocks);
const ephemeralTo = (userId: string, from = 0) => calls.slice(from).filter((c) => c.method === "chat.postEphemeral" && c.params.user === userId).map((c) => String(c.params.text));
/** The first message posted since `from` with a button whose value starts with `prefix`. */
const buttonMessage = (chat: string, prefix: string, from: number) =>
  until(() => postedTo(chat, from).find((c) => valuesOf(c).some((b) => b.value?.startsWith(prefix))), `a message with ${prefix} buttons`);
const valueOf = (call: Call, prefix: string) => valuesOf(call).find((b) => b.value?.startsWith(prefix))?.value ?? "";

const sourcesIn = (request: FakeChatRequest) =>
  [...request.messages.flatMap((m) => [...textOf(m.content).matchAll(/<source n="(\d+)" page_id="([^"]+)" title="([^"]*)">/g)])].map((s) => ({ n: Number(s[1]), title: s[3] }));
const caller =
  (toolCalls: { name: string; arguments: Record<string, unknown> }[], answer = (title: string, n: number) => `See **${title}** [${n}].`) =>
  (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (made < toolCalls.length) return { toolCalls: [toolCalls[made]] };
    const last = sourcesIn(request).at(-1);
    return { text: last ? answer(last.title, last.n) : "Nothing found." };
  };

const ids = { alice: `${RUN}-alice`, mallory: `${RUN}-mallory` };
const ws = `${RUN}-ws`;
let bot: { stop: () => void } | null = null;

try {
  await db.insert(user).values([
    { id: ids.alice, name: "Alice", email: `${ids.alice}@example.test` },
    { id: ids.mallory, name: "Mallory", email: `${ids.mallory}@example.test` },
  ]);
  await db.insert(workspace).values({ id: ws, name: `${RUN} main` });
  await db.insert(workspaceMember).values([
    { workspaceId: ws, userId: ids.alice, role: "owner" },
    { workspaceId: ws, userId: ids.mallory, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, ws));
  const vendors = await createPage({ userId: ids.alice }, { workspaceId: ws, teamspaceId: general.id, title: "Tyre vendors", markdown: "Northwind sells winter tyres." });

  // ── Socket Mode ───────────────────────────────────────────────────────────────────────────────
  bot = startSlack();
  check(bot, "the bot starts when both tokens are set");
  await until(() => client, "the Socket Mode connection");
  check(
    calls.some((c) => c.method === "apps.connections.open") && connections === 1,
    "it opens Socket Mode with the app token and connects to the address Slack gave",
  );

  // ── Linking ───────────────────────────────────────────────────────────────────────────────────
  let mark = calls.length;
  await message(SLACK_ALICE, "hello");
  await flushSlack();
  check(/isn't linked to a Leafdesk account.*Slack/s.test(said(IM_ALICE, mark)), "someone who hasn't linked is told how to, in Slack's words", said(IM_ALICE, mark));

  const status = await getSlackStatus(ids.alice);
  check(status.enabled && status.bot === "leafdesk" && status.openUrl === "https://slack.com/app_redirect?app=A1&team=T1" && status.link === null, "the settings see the app, where it opens and no link yet", status);
  const { command: linkCommand, expiresAt } = await createSlackLinkCode(ids.alice);
  const code = /^\/leafdesk link ([\w-]+)$/.exec(linkCommand)?.[1];
  check(code && code.length >= 30 && expiresAt.getTime() > Date.now() + 9 * 60_000, "a link code comes as the command to send, for ten minutes", linkCommand);
  const [stored] = await db.select().from(channelLinkCode).where(and(eq(channelLinkCode.userId, ids.alice), eq(channelLinkCode.channel, "slack")));
  check(stored && stored.codeHash !== code, "only a hash of the code is kept");

  mark = calls.length;
  await command(SLACK_ALICE, `link ${code}`);
  await flushSlack();
  const linked = said(IM_ALICE, mark);
  check(linked.includes("Linked to Leafdesk as Alice") && linked.includes("/leafdesk help"), "the command links the account, naming commands as Slack takes them", linked);
  const [link] = await db.select().from(channelLink).where(and(eq(channelLink.userId, ids.alice), eq(channelLink.channel, "slack")));
  check(link?.externalUserId === SLACK_ALICE && link.chatId === IM_ALICE && link.workspaceId === ws && link.mode === "ask", "the link keeps the Slack account, its direct message and the first workspace", link);
  mark = calls.length;
  await command(SLACK_MALLORY, `link ${code}`);
  await flushSlack();
  check(said(IM_MALLORY, mark).includes("has run out or was used already"), "a code works once", said(IM_MALLORY, mark));

  // ── Questions ─────────────────────────────────────────────────────────────────────────────────
  fake.setChat(caller([{ name: "read_page", arguments: { page_id: vendors.id } }]));
  mark = calls.length;
  await message(SLACK_ALICE, "Who sells <https://tyres.test|winter tyres> &amp; rims?");
  await flushSlack();
  const answer = said(IM_ALICE, mark);
  const pageUrl = `https://leaf.test/w/${ws}/p/${vendors.id}`;
  check(answer.includes(`See *Tyre vendors* <${pageUrl}|[1]>.`), "the answer comes in mrkdwn, its citation a link to the page", answer);
  check(answer.includes(`*Sources*\n[1] <${pageUrl}|Tyre vendors>`), "…with its sources listed as links", answer);
  const [afterFirst] = await db.select().from(channelLink).where(eq(channelLink.id, link.id));
  check(afterFirst.conversationId, "the conversation is kept on the link");
  const [asked] = await db.select().from(conversation).where(eq(conversation.id, afterFirst.conversationId!));
  check(asked?.userId === ids.alice && JSON.stringify(asked.messages).includes("Who sells winter tyres & rims?"), "the question reaches the chat as plain text, in the person's own conversation");

  mark = calls.length;
  await command(SLACK_ALICE, "new");
  await flushSlack();
  const [afterNew] = await db.select().from(channelLink).where(eq(channelLink.id, link.id));
  check(afterNew.conversationId === null && said(IM_ALICE, mark).includes("New conversation"), "/leafdesk new starts a new conversation", said(IM_ALICE, mark));

  // ── Approvals ─────────────────────────────────────────────────────────────────────────────────
  fake.setChat(caller([{ name: "create_page", arguments: { parent_id: vendors.id, title: "Price list", content: "Winter tyres: 80 each" } }], () => "Added it."));
  mark = calls.length;
  await message(SLACK_ALICE, "Add a price list under the vendors");
  const approval = await buttonMessage(IM_ALICE, "ap:", mark);
  check(/Add the page \*Price list\* under \*Tyre vendors\*\?/.test(textOfBlocks(approval)) && valuesOf(approval).length === 3, "a change is asked about first, with Yes, No and Yes, don't ask again", textOfBlocks(approval));
  await press(SLACK_ALICE, valueOf(approval, "ap:").replace(/:[a-z]+$/, ":y"), approval);
  await flushSlack();
  const made = await db.select().from(page).where(eq(page.parentId, vendors.id));
  check(made.some((p) => p.title === "Price list"), "Yes makes the change", made.map((p) => p.title));
  check(
    calls.slice(mark).some((c) => c.method === "chat.update" && c.params.ts === approval.ts && textOfBlocks(c).endsWith("_Approved._") && valuesOf(c).length === 0),
    "the approval message says so, its buttons gone",
  );
  check(/Done: <https:\/\/leaf\.test\/w\/[^|]+\|Price list>/.test(said(IM_ALICE, mark)), "the answer lists the change with a link", said(IM_ALICE, mark));

  fake.setChat(caller([{ name: "create_page", arguments: { parent_id: vendors.id, title: "Declined list" } }], () => "Left it."));
  mark = calls.length;
  await message(SLACK_ALICE, "Add another");
  const second = await buttonMessage(IM_ALICE, "ap:", mark);
  await press(SLACK_ALICE, valueOf(second, "ap:").replace(/:[a-z]+$/, ":n"), second);
  await flushSlack();
  check((await db.select().from(page).where(eq(page.title, "Declined list"))).length === 0, "No makes nothing");
  check(said(IM_ALICE, mark).includes("Not done: Declined list"), "…and the answer says it wasn't done", said(IM_ALICE, mark));

  // ── Notifications ─────────────────────────────────────────────────────────────────────────────
  const notes = await Promise.all(["Launch plan", "Budget"].map((title) => createPage({ userId: ids.alice }, { workspaceId: ws, teamspaceId: general.id, title, markdown: "…" })));
  const share = async (n: number) => {
    const from = calls.length;
    await recordShare(ids.mallory, ws, ids.alice, notes[n].id);
    await flushPush();
    return postedTo(IM_ALICE, from);
  };
  const [first] = await share(0);
  const [note0] = await db.select().from(notification).where(eq(notification.pageId, notes[0].id));
  check(
    first && textOfBlocks(first).startsWith("*Launch plan*\nMallory shared this page with you") && valueOf(first, "nr:") === `nr:${note0.id}` && valueOf(first, "nz:"),
    "a new notification comes to the direct message, with Mark read and Snooze",
    first && textOfBlocks(first),
  );
  mark = calls.length;
  await press(SLACK_ALICE, `nr:${note0.id}`, first);
  await flushSlack();
  const [read] = await db.select().from(notification).where(eq(notification.id, note0.id));
  check(read.readAt !== null, "Mark read marks it read in the inbox");
  check(
    ephemeralTo(SLACK_ALICE, mark).includes("Marked as read.") && calls.slice(mark).some((c) => c.method === "chat.update" && c.params.ts === first.ts && valuesOf(c).length === 0),
    "…saying so to the presser alone and taking the buttons away",
    calls.slice(mark),
  );
  await setNotificationPreference(ids.alice, "page_shared", "telegram", false);
  check((await share(1)).length === 0, "the chat apps' column of the preferences keeps a kind out of Slack too");
  await setNotificationPreference(ids.alice, "page_shared", "telegram", true);

  // ── An agent's call sent back with a note ─────────────────────────────────────────────────────
  const agent = await createAgent(ids.alice, ws, { name: "Filer" });
  const [agentUser] = await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.id, agent.id));
  const args = { title: "Q1 plan" };
  const [run] = await db
    .insert(agentRun)
    .values({
      agentId: agent.id,
      workspaceId: ws,
      source: { kind: "request", requestedBy: ids.alice, via: "api" },
      context: { actorId: ids.alice },
      status: "awaiting_approval",
      pending: { callId: "call-1", connectionId: null, tool: "create_row", arguments: args, askedAt: new Date().toISOString() },
      state: { queue: [{ id: "call-1", name: "create_row", arguments: args }] } as never,
      nextAt: new Date(Date.now() + 86_400_000),
    })
    .returning();
  mark = calls.length;
  await notifyApprovers(run, agentUser.userId);
  await flushPush();
  const callMessage = await buttonMessage(IM_ALICE, "ar:", mark);
  check(
    textOfBlocks(callMessage).startsWith("*Filer asks to go ahead*") && textOfBlocks(callMessage).includes('"title": "Q1 plan"') && !String(callMessage.params.text).includes("Q1 plan"),
    "a waiting call comes with what it would send, left out of the notification's text",
    callMessage.params,
  );
  mark = calls.length;
  await press(SLACK_ALICE, valueOf(callMessage, "ar:"), callMessage);
  await flushSlack();
  const question = postedTo(IM_ALICE, mark).find((c) => c.params.thread_ts === callMessage.ts);
  check(question && textOfBlocks(question).includes("Answer in this thread"), "Send back asks for the note in the message's thread", postedTo(IM_ALICE, mark));
  await message(SLACK_ALICE, "Use the Q2 numbers", { thread_ts: callMessage.ts });
  await flushSlack();
  const [sentBack] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
  const decision = (sentBack.state as { decision?: { decision: string; note?: string } } | null)?.decision;
  check(decision?.decision === "redo" && decision.note === "Use the Q2 numbers", "the reply in that thread sends the call back with its note", decision);
  const [audited] = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, ws), eq(auditEvent.action, "connection.approval_decided")));
  check((audited?.details as { via?: string } | undefined)?.via === "slack", "the audit log says it was answered from Slack", audited?.details);

  // ── Chatting with an agent ────────────────────────────────────────────────────────────────────
  await db.update(agentRun).set({ status: "failed", finishedAt: new Date() }).where(eq(agentRun.agentId, agent.id));
  mark = calls.length;
  await command(SLACK_ALICE, "agent");
  await flushSlack();
  const menu = await buttonMessage(IM_ALICE, "ag:", mark);
  check(valueOf(menu, `ag:${agent.id}`), "/leafdesk agent offers the agents shared with the person", valuesOf(menu));
  await press(SLACK_ALICE, `ag:${agent.id}`, menu);
  await flushSlack();
  const [pointed] = await db.select().from(channelLink).where(eq(channelLink.id, link.id));
  check(pointed.agentId === agent.id, "choosing one sends messages to it");

  fake.setChat(() => ({ text: "Filed **the note** under Q3." }));
  mark = calls.length;
  await message(SLACK_ALICE, "File my Q3 note");
  const chatRun = await until(async () => {
    const rows = await db.select().from(agentRun).where(and(eq(agentRun.agentId, agent.id), sql`${agentRun.source}->>'kind' = 'chat'`));
    return rows[0];
  }, "the chat's run");
  await flushAgentRuns();
  await flushSlack();
  check(chatRun.prompt === "File my Q3 note" && (chatRun.source as { slack?: boolean }).slack === true, "a message goes to the agent as a run marked as from Slack", chatRun.source);
  check(shownIn(IM_ALICE, mark).at(-1) === "Filed *the note* under Q3.", "the agent's answer comes in mrkdwn", shownIn(IM_ALICE, mark));

  // ── Channels and other messages ───────────────────────────────────────────────────────────────
  mark = calls.length;
  await envelope("events_api", { event_id: `Ev${++envelopes}`, event: { type: "message", channel: CHANNEL, channel_type: "channel", user: SLACK_ALICE, text: "Who sells tyres?", ts: nextTs() } });
  await envelope("events_api", { event_id: `Ev${++envelopes}`, event: { type: "message", channel: IM_ALICE, channel_type: "im", bot_id: "B1", user: "UBOT", text: "an echo", ts: nextTs() } });
  await envelope("events_api", { event_id: `Ev${++envelopes}`, event: { type: "message", subtype: "message_changed", channel: IM_ALICE, channel_type: "im", ts: nextTs() } });
  await flushSlack();
  check(calls.slice(mark).every((c) => c.method !== "chat.postMessage"), "a message in a channel, a bot's message and an edit get no answer", calls.slice(mark));
  mark = calls.length;
  await command(SLACK_ALICE, "new", CHANNEL);
  await flushSlack();
  const responded = calls.slice(mark).filter((c) => c.method === "respond");
  check(
    responded.length === 1 && responded[0].params.response_type === "ephemeral" && String(responded[0].params.text).includes("direct message") && postedTo(CHANNEL, mark).length === 0,
    "a command in a channel is answered only to its writer, saying why",
    calls.slice(mark),
  );

  check(!JSON.stringify(calls).includes(APP_TOKEN) && !JSON.stringify(calls).includes(BOT_TOKEN), "no token is ever sent in a message's content");

  console.log(`\n${passed} checks passed`);
} finally {
  bot?.stop();
  await sleep(50);
  resetAi();
  await db.delete(workspace).where(eq(workspace.id, ws));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  await fake.close();
  slack.closeAllConnections();
  slack.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
