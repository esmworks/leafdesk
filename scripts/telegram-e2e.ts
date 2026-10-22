/**
 * End-to-end check of the AI chat from Telegram (src/server/telegram) against the database, with a
 * fake Telegram Bot API server and a fake OpenAI-compatible model (src/server/ai/fake-openai.ts),
 * both reached over HTTP: linking an account with a one-time code (once, before it runs out, one
 * account on each side), questions answered with their sources as links and continued in one
 * conversation, /new, /workspace, /mode, /stop, /unlink, approving and declining a change with the
 * message's buttons (only its person can), a second question while one is answered, voice
 * messages written down by speech to text, group chats, and the workspace's connected-apps
 * setting: read only (no changes offered) and off (the workspace isn't offered); and notifications
 * sent to the linked chat, marked read or snoozed from it, by kind and on or off; and an agent's
 * call waiting for an owner, approved, declined or sent back with a note from its message (approve
 * only when all of the call shows, only its owner, only the call they saw, not where apps only read).
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/telegram-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

try {
  process.loadEnvFile();
} catch {}

// ── A fake Bot API ──────────────────────────────────────────────────────────────────────────────
type Sent = { method: string; params: Record<string, unknown>; /** A sent message's id. */ id?: number };
const sent: Sent[] = [];
/** Chats that blocked the bot: Telegram answers 403 to messages there. */
const blocked = new Set<number>();
let messageIds = 1000;
const VOICE = Buffer.from("OggS fake voice message bytes");
const telegram: Server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = req.url ?? "";
  if (url.startsWith("/file/bot")) {
    res.writeHead(200, { "Content-Type": "audio/ogg" }).end(VOICE);
    return;
  }
  const method = url.split("/").at(-1) ?? "";
  const params = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const ok = (result: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result }));
  if (!url.startsWith("/bot123:test-token/")) {
    res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
    return;
  }
  sent.push({ method, params });
  if (method === "getMe") return ok({ id: 1, is_bot: true, first_name: "Leafdesk", username: "leafdesk_test_bot" });
  if (method === "getFile") return ok({ file_id: params.file_id, file_path: "voice/file_1.oga", file_size: VOICE.length });
  if (method === "sendMessage" && blocked.has(Number(params.chat_id))) {
    res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }));
    return;
  }
  if (method === "sendMessage") sent[sent.length - 1].id = messageIds + 1;
  if (method === "sendMessage") return ok({ message_id: ++messageIds, chat: { id: Number(params.chat_id), type: "private" }, date: 0, text: params.text });
  return ok(true);
});
await new Promise<void>((resolve) => telegram.listen(0, "127.0.0.1", resolve));
process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
process.env.TELEGRAM_API_URL = `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`;
process.env.APP_URL = "https://leaf.test";

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { aiConversation, page, telegramLink, telegramLinkCode, teamspace, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { recordShare } = await import("@/server/notifications");
const { flushPush } = await import("@/server/push");
const { getNotificationPreferences, setNotificationPreference } = await import("@/server/notification-preferences");
const { agentRun, auditEvent, notification, workspaceAgent } = await import("@/db/schema");
const { createAgent } = await import("@/server/agents/manage");
const { notifyApprovers } = await import("@/server/connections/approvals");
const { resetAi, setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const { handleUpdate } = await import("@/server/telegram/bot");
const { createLinkCode, getTelegramStatus, unlinkTelegram } = await import("@/server/telegram/links");
type TelegramUpdate = import("@/server/telegram/api").TelegramUpdate;

const RUN = `telegram-e2e-${Date.now().toString(36)}`;
const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
setAiEnv({
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
  STT_PROVIDER: "openai-compatible",
  STT_MODEL: "fake-whisper",
  STT_BASE_URL: fake.baseUrl,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Updates as Telegram sends them ──────────────────────────────────────────────────────────────
let updateIds = 1;
const person = (id: number, name: string) => ({ id, is_bot: false, first_name: name, username: name.toLowerCase(), language_code: "en" });
const ALICE = person(5001, "Alice");
const MALLORY = person(5002, "Mallory");
const text = (from: typeof ALICE, body: string, chatType: "private" | "group" = "private"): TelegramUpdate => ({
  update_id: updateIds++,
  message: { message_id: updateIds, from, chat: { id: chatType === "private" ? from.id : -42, type: chatType }, date: 0, text: body },
});
const voice = (from: typeof ALICE): TelegramUpdate => ({
  update_id: updateIds++,
  message: { message_id: updateIds, from, chat: { id: from.id, type: "private" }, date: 0, voice: { file_id: "voice-1", duration: 4, mime_type: "audio/ogg" } },
});
const press = (from: typeof ALICE, data: string, messageId: number, chatId = from.id): TelegramUpdate => ({
  update_id: updateIds++,
  callback_query: { id: `cb-${updateIds}`, from, data, message: { message_id: messageId, chat: { id: chatId, type: "private" }, date: 0, text: "…" } },
});

/** Messages sent to a chat since `from` (an index into `sent`). */
const messagesTo = (chatId: number, from = 0) =>
  sent.slice(from).filter((s) => s.method === "sendMessage" && Number(s.params.chat_id) === chatId).map((s) => String(s.params.text));
/** The text of everything sent to a chat since `from`, joined. */
const said = (chatId: number, from = 0) => messagesTo(chatId, from).join("\n---\n");

async function until<T>(find: () => T | undefined | null | false, label: string, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(20);
  }
}

/** The approval message sent since `from`: its approval id and message id. */
async function approvalSince(from: number) {
  return until(() => {
    for (const [i, s] of sent.slice(from).entries()) {
      const keyboard = (s.params.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard;
      const data = keyboard?.flat().find((b) => b.callback_data?.startsWith("ap:"))?.callback_data;
      if (s.method === "sendMessage" && data) return { id: data.split(":")[1], messageId: 1000 + sent.slice(0, from + i + 1).filter((x) => x.method === "sendMessage").length, text: String(s.params.text), keyboard };
    }
    return null;
  }, "an approval message");
}

const questionOf = (request: FakeChatRequest) => {
  const last = request.messages.filter((m) => m.role === "user").at(-1);
  return /<question>\n?([\s\S]*?)\n?<\/question>/.exec(textOf(last?.content))?.[1] ?? textOf(last?.content);
};
const sourcesIn = (request: FakeChatRequest) =>
  [...request.messages.flatMap((m) => [...textOf(m.content).matchAll(/<source n="(\d+)" page_id="([^"]+)" title="([^"]*)">/g)])].map((s) => ({ n: Number(s[1]), pageId: s[2], title: s[3] }));
/** A model that makes these tool calls, one per turn, then answers citing the last source it got. */
const caller =
  (calls: { name: string; arguments: Record<string, unknown> }[], answer = (title: string, n: number) => `See **${title}** [${n}].`) =>
  (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (made < calls.length) return { toolCalls: [calls[made]] };
    const last = sourcesIn(request).at(-1);
    return { text: last ? answer(last.title, last.n) : "Nothing found." };
  };

const ids = { alice: `${RUN}-alice`, mallory: `${RUN}-mallory` };
const userIds = Object.values(ids);
const ws = `${RUN}-ws`;
const ws2 = `${RUN}-ws2`;

try {
  await db.insert(user).values([
    { id: ids.alice, name: "Alice", email: `${ids.alice}@example.test` },
    { id: ids.mallory, name: "Mallory", email: `${ids.mallory}@example.test` },
  ]);
  await db.insert(workspace).values([
    { id: ws, name: `${RUN} main` },
    { id: ws2, name: `${RUN} second` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: ws, userId: ids.alice, role: "owner" },
    { workspaceId: ws2, userId: ids.alice, role: "owner" },
    { workspaceId: ws, userId: ids.mallory, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, ws));
  const vendors = await createPage({ userId: ids.alice }, { workspaceId: ws, teamspaceId: general.id, title: "Tyre vendors", markdown: "Northwind sells winter tyres." });

  // ── Linking ───────────────────────────────────────────────────────────────────────────────────
  let mark = sent.length;
  await handleUpdate(text(ALICE, "hello"));
  check(/isn't linked to a Leafdesk account/.test(said(ALICE.id, mark)), "someone who hasn't linked is told how to", said(ALICE.id, mark));

  const status = await getTelegramStatus(ids.alice);
  check(status.enabled && status.bot === "leafdesk_test_bot" && status.link === null, "the settings see the bot and no link yet", status);
  const { url, expiresAt } = await createLinkCode(ids.alice);
  const code = /^https:\/\/t\.me\/leafdesk_test_bot\?start=([\w-]+)$/.exec(url)?.[1];
  check(code && code.length >= 30 && expiresAt.getTime() > Date.now() + 9 * 60_000, "a link code opens the bot and works for ten minutes", url);
  const [stored] = await db.select().from(telegramLinkCode).where(eq(telegramLinkCode.userId, ids.alice));
  check(stored && stored.codeHash !== code && stored.codeHash.length === 64, "only a hash of the code is kept");

  mark = sent.length;
  await handleUpdate(text(ALICE, `/start ${code}`));
  check(said(ALICE.id, mark).includes(`Linked to Leafdesk as Alice. Ask me anything about ${RUN} main`), "/start with the code links the account and names the workspace", said(ALICE.id, mark));
  const [link] = await db.select().from(telegramLink).where(eq(telegramLink.userId, ids.alice));
  check(link?.telegramUserId === String(ALICE.id) && link.workspaceId === ws && link.username === "alice" && link.mode === "ask", "the link keeps the account, its first workspace and mode ask", link);
  check((await getTelegramStatus(ids.alice)).link?.username === "alice", "the settings show the linked account");

  mark = sent.length;
  await handleUpdate(text(MALLORY, `/start ${code}`));
  check(/run out or was used already/.test(said(MALLORY.id, mark)), "a code works once");
  const mallorys = await createLinkCode(ids.mallory);
  await db.update(telegramLinkCode).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(telegramLinkCode.userId, ids.mallory));
  mark = sent.length;
  await handleUpdate(text(MALLORY, `/start ${mallorys.url.split("start=")[1]}`));
  check(/run out or was used already/.test(said(MALLORY.id, mark)), "a code that ran out doesn't link");

  // ── Questions ─────────────────────────────────────────────────────────────────────────────────
  fake.setChat(caller([{ name: "read_page", arguments: { page_id: vendors.id } }]));
  mark = sent.length;
  await handleUpdate(text(ALICE, "Who sells winter tyres?"));
  const answer = said(ALICE.id, mark);
  const pageUrl = `https://leaf.test/w/${ws}/p/${vendors.id}`;
  check(answer.includes(`See <b>Tyre vendors</b> <a href="${pageUrl}">[1]</a>.`), "the answer comes formatted, its citation a link to the page", answer);
  check(answer.includes(`<b>Sources</b>\n[1] <a href="${pageUrl}">Tyre vendors</a>`), "…with its sources listed as links", answer);
  check(sent.slice(mark).some((s) => s.method === "sendChatAction" && s.params.action === "typing"), "“typing…” shows while the answer is written");
  const [afterFirst] = await db.select().from(telegramLink).where(eq(telegramLink.userId, ids.alice));
  check(afterFirst.conversationId, "the conversation is kept on the link");

  fake.setChat(() => ({ text: "Still Northwind." }));
  await handleUpdate(text(ALICE, "And who else?"));
  const [conversation] = await db.select().from(aiConversation).where(eq(aiConversation.id, afterFirst.conversationId!));
  check(conversation?.messages.length === 4 && conversation.userId === ids.alice, "a second question continues the same conversation", conversation?.messages.length);

  mark = sent.length;
  await handleUpdate(text(ALICE, "/new"));
  const [afterNew] = await db.select().from(telegramLink).where(eq(telegramLink.userId, ids.alice));
  check(afterNew.conversationId === null && said(ALICE.id, mark).includes("New conversation"), "/new starts a new conversation");

  // ── Approvals ─────────────────────────────────────────────────────────────────────────────────
  fake.setChat(caller([{ name: "create_page", arguments: { parent_id: vendors.id, title: "Price list", content: "Winter tyres: 80 each" } }], () => "Added it."));
  mark = sent.length;
  const asking = handleUpdate(text(ALICE, "Add a price list under the vendors"));
  const approval = await approvalSince(mark);
  check(/Add the page <b>Price list<\/b> under <b>Tyre vendors<\/b>\?/.test(approval.text) && approval.text.includes("Winter tyres: 80 each"), "a change is asked about first, with what it adds", approval.text);
  check(JSON.stringify(approval.keyboard).includes(":a"), "…with Yes, No and Yes, don't ask again");

  // Someone else can't answer it: not from another chat, nor with their own link.
  const otherCode = await createLinkCode(ids.mallory);
  await handleUpdate(text(MALLORY, `/start ${otherCode.url.split("start=")[1]}`));
  mark = sent.length;
  await handleUpdate(press(MALLORY, `ap:${approval.id}:y`, approval.messageId));
  check(sent.slice(mark).some((s) => s.method === "answerCallbackQuery" && /isn't waiting/.test(String(s.params.text))), "another person's link can't approve it", sent.slice(mark));
  await handleUpdate(press(MALLORY, `ap:${approval.id}:y`, approval.messageId, ALICE.id));
  check((await db.select().from(page).where(eq(page.title, "Price list"))).length === 0, "nothing is made before its person approves");

  await handleUpdate(press(ALICE, `ap:${approval.id}:y`, approval.messageId));
  await asking;
  const made = await db.select().from(page).where(eq(page.parentId, vendors.id));
  check(made.some((p) => p.title === "Price list"), "approving with the button makes the change", made.map((p) => p.title));
  check(sent.some((s) => s.method === "editMessageText" && Number(s.params.message_id) === approval.messageId && String(s.params.text).endsWith("<i>Approved.</i>")), "the approval message says so, its buttons gone");
  check(/Done: <a href="https:\/\/leaf\.test\/w\/[^"]+">Price list<\/a>/.test(said(ALICE.id, mark)), "the answer lists the change with a link", said(ALICE.id, mark));

  fake.setChat(caller([{ name: "create_page", arguments: { parent_id: vendors.id, title: "Declined list" } }], () => "Left it."));
  mark = sent.length;
  const declining = handleUpdate(text(ALICE, "Add another"));
  const second = await approvalSince(mark);
  await handleUpdate(press(ALICE, `ap:${second.id}:n`, second.messageId));
  await declining;
  check((await db.select().from(page).where(eq(page.title, "Declined list"))).length === 0, "declining makes nothing");
  check(said(ALICE.id, mark).includes("Not done: Declined list"), "…and the answer says it wasn't done, without a link", said(ALICE.id, mark));

  // ── One question at a time, and /stop ─────────────────────────────────────────────────────────
  fake.setChat(() => ({ text: "A long answer that takes a while to write, word by word." }));
  fake.delayMs = 150;
  mark = sent.length;
  const slow = handleUpdate(text(ALICE, "Tell me slowly"));
  await sleep(200);
  await handleUpdate(text(ALICE, "And this?"));
  check(said(ALICE.id, mark).includes("still answering"), "a second question waits for the answer being written", said(ALICE.id, mark));
  await handleUpdate(text(ALICE, "/stop"));
  await slow;
  fake.delayMs = 0;
  check(said(ALICE.id, mark).includes("Stopped."), "/stop stops it", said(ALICE.id, mark));
  mark = sent.length;
  await handleUpdate(text(ALICE, "/stop"));
  check(said(ALICE.id, mark).includes("not answering anything"), "/stop with nothing being answered says so");

  // ── Voice messages ────────────────────────────────────────────────────────────────────────────
  fake.setTranscript(() => "Who sells tyres?");
  fake.setChat((request) => ({ text: `You asked: ${questionOf(request)}` }));
  mark = sent.length;
  await handleUpdate(voice(ALICE));
  check(said(ALICE.id, mark).includes("You said: <i>Who sells tyres?</i>") && said(ALICE.id, mark).includes("You asked: Who sells tyres?"), "a voice message is written down and answered", said(ALICE.id, mark));
  check(fake.transcribed.at(-1)?.size === VOICE.length && sent.some((s) => s.method === "getFile"), "…from the file Telegram has");

  // ── Workspace and mode ────────────────────────────────────────────────────────────────────────
  mark = sent.length;
  await handleUpdate(text(ALICE, "/workspace"));
  const picker = sent.slice(mark).find((s) => s.method === "sendMessage");
  const buttons = JSON.stringify(picker?.params.reply_markup);
  check(buttons.includes(`ws:${ws}`) && buttons.includes(`ws:${ws2}`) && buttons.includes(`✓ ${RUN} main`), "/workspace offers the person's workspaces, the current one ticked", picker?.params);
  await handleUpdate(press(ALICE, `ws:${ws2}`, 1));
  const [moved] = await db.select().from(telegramLink).where(eq(telegramLink.userId, ids.alice));
  check(moved.workspaceId === ws2 && moved.conversationId === null, "choosing one sends questions there, in a new conversation");
  await handleUpdate(press(ALICE, `ws:${RUN}-not-theirs`, 1));
  check((await db.select().from(telegramLink).where(eq(telegramLink.userId, ids.alice)))[0].workspaceId === ws2, "a workspace they aren't in can't be chosen");
  await handleUpdate(press(ALICE, `ws:${ws}`, 1));

  await handleUpdate(text(ALICE, "/mode"));
  await handleUpdate(press(ALICE, "md:read", 1));
  check((await db.select().from(telegramLink).where(eq(telegramLink.userId, ids.alice)))[0].mode === "read", "/mode changes what the chat may change");
  fake.setChat(() => ({ text: "Fine." }));
  fake.chats.length = 0;
  await handleUpdate(text(ALICE, "Anything?"));
  check(!fake.chats[0]?.tools?.some((t) => t.function.name === "create_page"), "in read only, no changes are offered to the model");
  await handleUpdate(press(ALICE, "md:ask", 1));

  // ── The workspace's connected-apps setting ────────────────────────────────────────────────────
  await updateWorkspaceSettings(ids.alice, ws, { connectedApps: "read" });
  fake.chats.length = 0;
  mark = sent.length;
  await handleUpdate(text(ALICE, "Add a row somewhere"));
  const tools = fake.chats[0]?.tools?.map((t) => t.function.name) ?? [];
  check(said(ALICE.id, mark).includes("Apps may only read in") && !tools.includes("create_page") && !tools.includes("remember"), "where apps may only read, the chat changes nothing, notes included", { said: said(ALICE.id, mark), tools });
  await updateWorkspaceSettings(ids.alice, ws, { connectedApps: "off" });
  await handleUpdate(text(ALICE, "Hello again"));
  const [hidden] = await db.select().from(telegramLink).where(eq(telegramLink.userId, ids.alice));
  check(hidden.workspaceId === ws2, "a workspace that turned apps off isn't answered from: the next one is used");
  mark = sent.length;
  await handleUpdate(text(MALLORY, "Hello"));
  check(said(MALLORY.id, mark).includes("aren't in a workspace I can answer from"), "someone with no workspace apps may reach is told so", said(MALLORY.id, mark));
  await updateWorkspaceSettings(ids.alice, ws, { connectedApps: "full" });

  // ── Notifications ─────────────────────────────────────────────────────────────────────────────
  const notes = await Promise.all(
    ["Launch plan", "Budget", "Roadmap", "Hiring", "Offsite", "Retro"].map((title) =>
      createPage({ userId: ids.alice }, { workspaceId: ws, teamspaceId: general.id, title, markdown: "…" }),
    ),
  );
  /** Shares the nth page with Alice as Mallory; the Telegram messages it sent to her. */
  const share = async (n: number) => {
    const from = sent.length;
    await recordShare(ids.mallory, ws, ids.alice, notes[n].id);
    await flushPush();
    return sent.slice(from).filter((s) => s.method === "sendMessage" && Number(s.params.chat_id) === ALICE.id);
  };
  const shareNote = (n: number) => db.select().from(notification).where(eq(notification.pageId, notes[n].id)).then((rows) => rows[0]);

  const [first] = await share(0);
  const firstText = String(first?.params.text);
  const noteUrl = `https://leaf.test/w/${ws}/p/${notes[0].id}`;
  check(
    firstText.startsWith("<b>Launch plan</b>\nMallory shared this page with you\n") && firstText.includes(`<i>${RUN} main</i> · <a href="${noteUrl}">Open</a>`),
    "a new notification comes to the linked chat, as the inbox says it, with its workspace and a link",
    firstText,
  );
  const noteButtons = JSON.stringify(first.params.reply_markup);
  const id0 = (await shareNote(0)).id;
  check(noteButtons.includes(`nr:${id0}`) && noteButtons.includes(`nz:${id0}`) && noteButtons.includes("Snooze 1 hour"), "…with buttons to mark it read and snooze it", noteButtons);

  mark = sent.length;
  await handleUpdate(press(ALICE, `nr:${id0}`, 2001));
  check((await shareNote(0)).readAt !== null, "Mark read marks it read in the inbox");
  check(sent.slice(mark).some((s) => s.method === "answerCallbackQuery" && s.params.text === "Marked as read.") && sent.slice(mark).some((s) => s.method === "editMessageReplyMarkup"), "…says so and takes the buttons away");
  await db.update(notification).set({ readAt: null }).where(eq(notification.id, id0));
  mark = sent.length;
  await handleUpdate(press(MALLORY, `nr:${id0}`, 2001));
  check(
    sent.slice(mark).some((s) => s.method === "answerCallbackQuery" && s.params.text === "This notification isn't in your inbox anymore.") && (await shareNote(0)).readAt === null,
    "someone else can't answer it",
  );

  await share(1);
  const id1 = (await shareNote(1)).id;
  await handleUpdate(press(ALICE, `nz:${id1}`, 2002));
  const snoozed = await shareNote(1);
  check(snoozed.snoozedUntil && snoozed.snoozedUntil.getTime() > Date.now() + 50 * 60_000, "Snooze puts it away for an hour", snoozed.snoozedUntil);

  await setNotificationPreference(ids.alice, "page_shared", "telegram", false);
  check((await getNotificationPreferences(ids.alice)).page_shared.telegram === false, "each kind can be kept out of Telegram in the preferences");
  check((await share(2)).length === 0, "…and then doesn't come there");
  await setNotificationPreference(ids.alice, "page_shared", "telegram", true);
  await setNotificationPreference(ids.alice, "page_shared", "inbox", false);
  check((await share(3)).length === 0, "what stays out of the inbox doesn't come either");
  await setNotificationPreference(ids.alice, "page_shared", "inbox", true);

  mark = sent.length;
  await handleUpdate(text(ALICE, "/notifications"));
  check(said(ALICE.id, mark).includes("notifications come to this chat") && JSON.stringify(sent.at(-1)?.params.reply_markup).includes("nt:off"), "/notifications says they're on, with a button to stop them");
  await handleUpdate(press(ALICE, "nt:off", 2003));
  check((await share(4)).length === 0, "turned off there, none come");
  check((await getTelegramStatus(ids.alice)).link?.notifications === false, "…which the settings show");
  await handleUpdate(press(ALICE, "nt:on", 2004));

  await updateWorkspaceSettings(ids.alice, ws, { connectedApps: "off" });
  check((await share(5)).length === 0, "a workspace that turned connected apps off sends none");
  await updateWorkspaceSettings(ids.alice, ws, { connectedApps: "full" });

  blocked.add(ALICE.id);
  await recordShare(ids.mallory, ws, ids.alice, notes[2].id);
  await flushPush();
  check((await getTelegramStatus(ids.alice)).link?.notifications === false, "a chat that blocked the bot gets its notifications turned off");
  blocked.delete(ALICE.id);
  await handleUpdate(press(ALICE, "nt:on", 2005));
  check((await share(3)).length === 1, "…and gets them again once turned back on");

  // ── An agent's calls ──────────────────────────────────────────────────────────────────────────
  const agent = await createAgent(ids.alice, ws, { name: "Filer" });
  const [bot] = await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.id, agent.id));
  let calls = 0;
  /** A run of the agent that Alice asked for, waiting on a call (`whole`: the call to send is known, so all of it shows). */
  const waitingRun = async (args: Record<string, unknown>, whole = true) => {
    const callId = `call-${++calls}`;
    const [run] = await db
      .insert(agentRun)
      .values({
        agentId: agent.id,
        workspaceId: ws,
        source: { kind: "request", requestedBy: ids.alice, via: "api" },
        context: { actorId: ids.alice },
        status: "awaiting_approval",
        pending: { callId, connectionId: null, tool: "create_row", arguments: args, askedAt: new Date().toISOString() },
        state: (whole ? { queue: [{ id: callId, name: "create_row", arguments: args }] } : {}) as never,
        nextAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    const from = sent.length;
    await notifyApprovers(run, bot.userId);
    await flushPush();
    const message = sent.slice(from).find((x) => x.method === "sendMessage" && Number(x.params.chat_id) === ALICE.id);
    const [note] = await db.select().from(notification).where(eq(notification.agentRunId, run.id));
    return { run, message, notificationId: note.id };
  };
  type Decided = { decision?: { decision: string; userId: string; note?: string } };
  const runNow = async (id: string) => {
    const [found] = await db.select().from(agentRun).where(eq(agentRun.id, id));
    return { ...found, state: found.state as Decided | null };
  };
  const buttonsOf = (x: Sent | undefined) => (x?.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
  const dataOf = (x: Sent | undefined, prefix: string) => buttonsOf(x).find((b) => b.callback_data.startsWith(prefix))?.callback_data ?? "";
  const repliedSince = (from: number) => said(ALICE.id, from);

  const asked1 = await waitingRun({ title: "Q3 plan" });
  const askedCall = String(asked1.message?.params.text);
  check(
    askedCall.startsWith("<b>Filer asks to go ahead</b>\nWants to call “create_row” on Leafdesk\n<tg-spoiler>") && askedCall.includes('"title": "Q3 plan"'),
    "a waiting call comes with what it would send, hidden until tapped",
    askedCall,
  );
  check(
    buttonsOf(asked1.message).map((b) => b.text).join("|") === "Approve|Decline|Send back with a note",
    "…with Approve, Decline and Send back with a note",
    buttonsOf(asked1.message),
  );
  mark = sent.length;
  await handleUpdate(press(MALLORY, dataOf(asked1.message, "aa:"), asked1.message!.id!));
  check((await runNow(asked1.run.id)).status === "awaiting_approval", "someone else can't answer it");
  await handleUpdate(press(ALICE, dataOf(asked1.message, "aa:").replace(/:[0-9a-f]{10}$/, ":0000000000"), asked1.message!.id!));
  check((await runNow(asked1.run.id)).status === "awaiting_approval" && repliedSince(mark).includes("asked again since"), "an answer meant for another call isn't taken");
  mark = sent.length;
  await handleUpdate(press(ALICE, dataOf(asked1.message, "aa:"), asked1.message!.id!));
  const approved = await runNow(asked1.run.id);
  check(approved.status === "pending" && approved.state?.decision?.decision === "approve" && approved.state.decision.userId === ids.alice, "Approve answers the call: the run goes on", approved.state);
  check(repliedSince(mark).includes("Approved: the agent goes ahead.") && sent.slice(mark).some((x) => x.method === "editMessageReplyMarkup"), "…saying so, the buttons gone");
  check((await db.select().from(notification).where(eq(notification.agentRunId, asked1.run.id))).length === 0, "…and the inbox item goes, as when answered in the app");
  const [audited] = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, ws), eq(auditEvent.action, "connection.approval_decided")));
  check(audited?.actorUserId === ids.alice && (audited.details as { via?: string }).via === "telegram", "the audit log says it was answered from Telegram", audited?.details);
  mark = sent.length;
  await handleUpdate(press(ALICE, dataOf(asked1.message, "aa:"), asked1.message!.id!));
  check(repliedSince(mark).includes("isn't waiting anymore"), "answering it again is refused");

  const partial = await waitingRun({ title: "Q4 plan" }, false);
  const partialText = String(partial.message?.params.text);
  check(!dataOf(partial.message, "aa:") && partialText.includes("Not all of this call shows here"), "a call not shown whole has no Approve: it is approved from its run", partialText);
  mark = sent.length;
  await handleUpdate(press(ALICE, `aa:${partial.notificationId}:${dataOf(partial.message, "ad:").split(":")[2]}`, partial.message!.id!));
  check((await runNow(partial.run.id)).status === "awaiting_approval" && repliedSince(mark).includes("approve it from its run"), "…and a forged Approve is refused");
  await handleUpdate(press(ALICE, dataOf(partial.message, "ad:"), partial.message!.id!));
  check((await runNow(partial.run.id)).status === "pending" && (await runNow(partial.run.id)).state?.decision?.decision === "decline", "Decline answers it");

  const redo = await waitingRun({ title: "Q1 plan" });
  mark = sent.length;
  await handleUpdate(press(ALICE, dataOf(redo.message, "ar:"), redo.message!.id!));
  const noteQuestion = sent.slice(mark).find((x) => x.method === "sendMessage" && (x.params.reply_markup as { force_reply?: boolean } | undefined)?.force_reply);
  check(noteQuestion && String(noteQuestion.params.text).includes("What should the agent change?"), "Send back asks for a note", sent.slice(mark));
  const reply = (body: string, to: number): TelegramUpdate => ({
    update_id: updateIds++,
    message: { message_id: updateIds, from: ALICE, chat: { id: ALICE.id, type: "private" }, date: 0, text: body, reply_to_message: { message_id: to } },
  });
  await handleUpdate(reply("Use the Q2 numbers", noteQuestion!.id!));
  const sentBack = (await runNow(redo.run.id)).state?.decision;
  check(sentBack?.decision === "redo" && sentBack.note === "Use the Q2 numbers", "the answer to it sends the call back with that note", sentBack);

  await updateWorkspaceSettings(ids.alice, ws, { connectedApps: "read" });
  const readOnly = await waitingRun({ title: "Read only" });
  mark = sent.length;
  await handleUpdate(press(ALICE, dataOf(readOnly.message, "aa:"), readOnly.message!.id!));
  check((await runNow(readOnly.run.id)).status === "awaiting_approval" && repliedSince(mark).includes("answer the call in Leafdesk"), "where apps may only read, calls are answered in the app");
  await updateWorkspaceSettings(ids.alice, ws, { connectedApps: "full" });

  // ── Groups ────────────────────────────────────────────────────────────────────────────────────
  mark = sent.length;
  fake.chats.length = 0;
  await handleUpdate(text(ALICE, "What's in the workspace?", "group"));
  check(messagesTo(-42, mark).length === 0 && fake.chats.length === 0, "questions in a group chat aren't answered");
  await handleUpdate(text(ALICE, "/help", "group"));
  check(said(-42, mark).includes("only answer in a private chat"), "…and a command there is told why");

  // ── Unlinking ─────────────────────────────────────────────────────────────────────────────────
  mark = sent.length;
  await handleUpdate(text(MALLORY, "/unlink"));
  check((await db.select().from(telegramLink).where(eq(telegramLink.userId, ids.mallory))).length === 0 && said(MALLORY.id, mark).includes("no longer linked"), "/unlink unlinks the account");
  mark = sent.length;
  check(await unlinkTelegram(ids.alice, "Unlinked in the settings."), "the settings unlink an account");
  check(said(ALICE.id, mark) === "Unlinked in the settings." && (await getTelegramStatus(ids.alice)).link === null, "…telling them in Telegram");
  mark = sent.length;
  await handleUpdate(text(ALICE, "Still there?"));
  check(/isn't linked/.test(said(ALICE.id, mark)), "an unlinked account isn't answered");

  // A deleted account takes its link with it.
  const again = await createLinkCode(ids.mallory);
  await handleUpdate(text(MALLORY, `/start ${again.url.split("start=")[1]}`));
  await db.delete(user).where(eq(user.id, ids.mallory));
  check((await db.select().from(telegramLink).where(eq(telegramLink.telegramUserId, String(MALLORY.id)))).length === 0, "a deleted account's link goes with it");

  console.log(`\n${passed} checks passed`);
} finally {
  resetAi();
  await db.delete(workspace).where(inArray(workspace.id, [ws, ws2]));
  await db.delete(user).where(inArray(user.id, userIds));
  await fake.close();
  telegram.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
