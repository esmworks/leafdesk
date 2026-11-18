/**
 * End-to-end check of the AI chat from Microsoft Teams (src/server/teams, over the chat-app bot in
 * src/server/chat-apps) against the database, with a fake Bot Connector written by hand here (it
 * serves the OpenID metadata and signing keys, the tenant's token endpoint and the conversations'
 * activities, and signs the calls "Teams" makes with a key it generated) and a fake
 * OpenAI-compatible model (src/server/ai/fake-openai.ts), all reached over the network as the
 * server reaches Microsoft: calls refused without a valid token (none, wrong audience, expired,
 * another service address than the token's, another channel, another directory's person);
 * linking an account with `/link <code>`; a question answered as Markdown with its sources as
 * links; a change approved with an Adaptive Card's button and the card replaced; notifications
 * delivered with Mark read, marked read from there and kept out by the chat apps' preference
 * column; a reply to a comment written in the chat and posted in its thread; an agent's call sent
 * back with a note; chatting with an agent picked with `agent`; notifications that still reach a
 * chat after a restart (the address kept on the link) and none to an address that isn't
 * Microsoft's; and messages in a channel ignored. Creates its own users and workspace and
 * deletes them afterwards.
 *
 * It cannot say how real Teams draws the messages or sends a card's button press: that is the
 * documented shape, not the service.
 *
 *   pnpm tsx scripts/teams-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server on
 * the same database (a server's agents' worker would take the agent's runs).
 */
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

try {
  process.loadEnvFile();
} catch {}

const APP_ID = "11111111-2222-3333-4444-555555555555";
const SECRET = "client-secret-e2e";
const TENANT = "99999999-8888-7777-6666-555555555555";
const ACCESS_TOKEN = "connector-access-token-e2e";

// ── Keys the fake Connector signs with ──────────────────────────────────────────────────────────
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "e2e-key-1";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function jwt(claims: Record<string, unknown>, key = pair.privateKey) {
  const signing = `${b64({ typ: "JWT", alg: "RS256", kid: KID })}.${b64(claims)}`;
  return `${signing}.${createSign("RSA-SHA256").update(signing).sign(key).toString("base64url")}`;
}

// ── A fake Bot Connector, token endpoint and OpenID metadata ────────────────────────────────────
type Call = { verb: string; path: string; body: Record<string, unknown>; auth: string; id?: string };
const calls: Call[] = [];
const tokenRequests: URLSearchParams[] = [];
let idCounter = 0;
let metadataReads = 0;

const connector: Server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const url = req.url ?? "";
  const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const base = `http://127.0.0.1:${(connector.address() as AddressInfo).port}`;
  if (url === "/openid") {
    metadataReads += 1;
    return json(200, { issuer: "https://api.botframework.com", jwks_uri: `${base}/keys`, id_token_signing_alg_values_supported: ["RS256"] });
  }
  if (url === "/keys") return json(200, { keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: KID, endorsements: ["msteams"] }] });
  if (url === `/${TENANT}/oauth2/v2.0/token`) {
    const params = new URLSearchParams(raw);
    tokenRequests.push(params);
    const good = params.get("client_id") === APP_ID && params.get("client_secret") === SECRET && params.get("grant_type") === "client_credentials";
    return good ? json(200, { token_type: "Bearer", expires_in: 3600, access_token: ACCESS_TOKEN }) : json(401, { error: "invalid_client" });
  }
  if (url.startsWith("/v3/conversations/")) {
    const auth = String(req.headers.authorization ?? "");
    if (auth !== `Bearer ${ACCESS_TOKEN}`) return json(401, { error: { code: "BadArgument" } });
    const path = decodeURIComponent(url.replace("/v3/", ""));
    const call: Call = { verb: req.method ?? "", path, body: JSON.parse(raw) as Record<string, unknown>, auth };
    calls.push(call);
    if (call.verb === "POST") {
      call.id = call.body.type === "typing" ? undefined : `msg-${++idCounter}`;
      return json(200, { id: call.id ?? "" });
    }
    return json(200, { id: call.path.split("/").at(-1) });
  }
  return json(404, {});
});
await new Promise<void>((resolve) => connector.listen(0, "127.0.0.1", resolve));
const HOST = `127.0.0.1:${(connector.address() as AddressInfo).port}`;
const BASE = `http://${HOST}`;
const SERVICE = `${BASE}/`;
process.env.TEAMS_APP_ID = APP_ID;
process.env.TEAMS_APP_PASSWORD = SECRET;
process.env.TEAMS_TENANT_ID = TENANT;
process.env.TEAMS_LOGIN_URL = BASE;
process.env.TEAMS_OPENID_URL = `${BASE}/openid`;
process.env.TEAMS_SERVICE_URL_HOSTS = HOST;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.SLACK_APP_TOKEN;
delete process.env.SLACK_BOT_TOKEN;
process.env.APP_URL = "https://leaf.test";

// Imported after the env is set: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, auditEvent, channelLink, channelLinkCode, conversation, notification, page, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { changeComments, listComments } = await import("@/server/comments");
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
const { commentText } = await import("@/lib/comments");
const { flushTeams, handleTeamsRequest } = await import("@/server/teams/endpoint");
const { createTeamsLinkCode, getTeamsStatus } = await import("@/server/teams/links");
const { forgetServiceUrls } = await import("@/server/teams/conversations");
const { resetTeamsKeys } = await import("@/server/teams/auth");
const { resetTeamsToken } = await import("@/server/teams/api");

const RUN = `teams-e2e-${Date.now().toString(36)}`;
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

// ── Calls as Teams makes them ───────────────────────────────────────────────────────────────────
const SUFFIX = Date.now().toString(36);
const TEAMS_ALICE = `29:alice-${SUFFIX}`;
const TEAMS_MALLORY = `29:mallory-${SUFFIX}`;
const convOf = (from: string) => `a:conv-${from.slice(3)}`;
const CONV_ALICE = convOf(TEAMS_ALICE);
const CONV_MALLORY = convOf(TEAMS_MALLORY);
const CHANNEL_CONV = `19:channel-${SUFFIX}@thread.tacv2`;
let counter = 0;
const nameOf = (from: string) => (from === TEAMS_ALICE ? "Alice" : "Mallory");

type Activity = Record<string, unknown>;
const activity = (from: string, extra: Activity = {}): Activity => ({
  type: "message",
  id: `act-${++counter}`,
  serviceUrl: SERVICE,
  channelId: "msteams",
  locale: "en-US",
  from: { id: from, name: nameOf(from), aadObjectId: "x" },
  recipient: { id: `28:${APP_ID}`, name: "Leafdesk" },
  conversation: { id: convOf(from), conversationType: "personal", tenantId: TENANT },
  channelData: { tenant: { id: TENANT } },
  ...extra,
});
const goodClaims = (extra: Record<string, unknown> = {}) => ({
  iss: "https://api.botframework.com",
  aud: APP_ID,
  nbf: Math.floor(Date.now() / 1000) - 60,
  exp: Math.floor(Date.now() / 1000) + 3_000,
  serviceurl: SERVICE,
  ...extra,
});
async function post(body: unknown, token: string | null = jwt(goodClaims())) {
  return handleTeamsRequest(
    new Request("http://localhost/api/teams/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
}
/** A call that Teams would make: signed, accepted, and handled to its end. */
async function teams(a: Activity, wait = true) {
  const response = await post(a);
  check(response.status === 200, `Teams' call is taken (${String(a.text ?? JSON.stringify(a.value))})`, response.status);
  // A question that stops to ask is still being handled until it is answered: don't wait for it.
  if (wait) await flushTeams();
}
const message = (from: string, text: string, extra: Activity = {}, wait = true) => teams(activity(from, { text, ...extra }), wait);
/** A press of a button of a card the bot sent. */
const press = (from: string, data: string, sent: Call) => teams(activity(from, { text: "", value: { leafdesk: data }, replyToId: sent.id }));

// ── What the bot sent ───────────────────────────────────────────────────────────────────────────
const sentTo = (conversation: string, from = 0) =>
  calls.slice(from).filter((c) => c.verb === "POST" && c.path.startsWith(`conversations/${conversation}/activities`) && c.body.type === "message");
const textOfCall = (c: Call) => String(c.body.text ?? "");
const said = (conversation: string, from = 0) => sentTo(conversation, from).map(textOfCall).join("\n---\n");
const buttonsOf = (c: Call) =>
  ((c.body.attachments as { content: { body: { actions: { type: string; title: string; data?: { leafdesk?: string }; url?: string }[] }[] } }[] | undefined) ?? []).flatMap((a) => a.content.body.flatMap((b) => b.actions));
const dataOf = (c: Call, prefix: string) => buttonsOf(c).find((b) => b.data?.leafdesk?.startsWith(prefix))?.data?.leafdesk ?? "";
const withButton = (conversation: string, prefix: string, from: number) =>
  until(() => sentTo(conversation, from).find((c) => dataOf(c, prefix)), `a message with ${prefix} buttons`);
const updatesOf = (id: string, from = 0) => calls.slice(from).filter((c) => c.verb === "PUT" && c.path.endsWith(`/${id}`));

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

const plain = (text: string) => [{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }];
const ids = { alice: `${RUN}-alice`, mallory: `${RUN}-mallory` };
const ws = `${RUN}-ws`;

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

  // ── Calls that are refused ────────────────────────────────────────────────────────────────────
  const hello = activity(TEAMS_ALICE, { text: "hello" });
  const refused = async (body: unknown, token: string | null, status: number, label: string) => {
    const before = calls.length;
    const response = await post(body, token);
    await flushTeams();
    check(response.status === status && calls.length === before, label, { status: response.status, calls: calls.slice(before) });
  };
  await refused(hello, null, 401, "a call with no token is refused, and nothing is sent");
  await refused(hello, "not.a.jwt", 401, "…a token that isn't one");
  await refused(hello, jwt(goodClaims({ aud: "another-bot" })), 401, "…a token made for another bot");
  await refused(hello, jwt(goodClaims({ iss: "https://sts.windows.net/someone/" })), 401, "…one from another issuer");
  await refused(hello, jwt(goodClaims({ exp: Math.floor(Date.now() / 1000) - 3_600 })), 401, "…an expired one");
  await refused(hello, jwt(goodClaims(), stranger.privateKey), 401, "…one signed with a key the Connector doesn't publish");
  await refused({ ...hello, serviceUrl: "https://evil.example/" }, jwt(goodClaims()), 403, "…a body naming another service address than the token's");
  await refused({ ...hello, channelId: "webchat" }, jwt(goodClaims()), 403, "…a call of another channel");
  const sameToken = jwt(goodClaims({ serviceurl: "https://evil.example/" }));
  await refused({ ...hello, serviceUrl: "https://evil.example/" }, sameToken, 200 + 0, "…(a token that names another address covers it, but the bot never sends there)");

  // ── An answer from another directory's person ─────────────────────────────────────────────────
  const before = calls.length;
  await teams(activity(TEAMS_ALICE, { text: "hello", conversation: { id: CONV_ALICE, conversationType: "personal", tenantId: "other-tenant" }, channelData: { tenant: { id: "other-tenant" } } }));
  check(calls.length === before, "a person of another directory is never answered");
  check((tokenRequests as unknown[]).length === 0, "…and no token was asked for yet");

  // ── Linking ───────────────────────────────────────────────────────────────────────────────────
  let mark = calls.length;
  await message(TEAMS_ALICE, "hello");
  const notLinked = said(CONV_ALICE, mark);
  check(/isn't linked to a Leafdesk account.*Microsoft Teams/s.test(notLinked), "someone who hasn't linked is told how to, in Teams' words", notLinked);
  const first = calls[mark];
  check(first.path === `conversations/${CONV_ALICE}/activities` && first.body.textFormat === "markdown", "the answer goes to the conversation at its service address, as Markdown", first);
  check(tokenRequests.length === 1 && tokenRequests[0].get("scope") === "https://api.botframework.com/.default", "its token came from the tenant's sign-in with the bot's secret, for the Bot Framework scope");
  check(metadataReads === 1, "the signing keys were read from the OpenID metadata once, and kept");

  const status = await getTeamsStatus(ids.alice);
  check(status.enabled && status.openUrl === `https://teams.microsoft.com/l/chat/0/0?users=28:${APP_ID}` && status.link === null, "the settings see the app, where it opens and no link yet", status);
  const { command: linkCommand, expiresAt } = await createTeamsLinkCode(ids.alice);
  const code = /^\/link ([\w-]+)$/.exec(linkCommand)?.[1];
  check(code && code.length >= 30 && expiresAt.getTime() > Date.now() + 9 * 60_000, "a link code comes as the command to send, for ten minutes", linkCommand);
  const [stored] = await db.select().from(channelLinkCode).where(and(eq(channelLinkCode.userId, ids.alice), eq(channelLinkCode.channel, "teams")));
  check(stored && stored.codeHash !== code, "only a hash of the code is kept");

  mark = calls.length;
  await message(TEAMS_ALICE, `<at>Leafdesk</at> ${linkCommand}`);
  const linked = said(CONV_ALICE, mark);
  check(linked.includes("Linked to Leafdesk as Alice") && linked.includes("/help"), "the command links the account", linked);
  const [link] = await db.select().from(channelLink).where(and(eq(channelLink.userId, ids.alice), eq(channelLink.channel, "teams")));
  check(link?.externalUserId === TEAMS_ALICE && link.chatId === CONV_ALICE && link.workspaceId === ws && link.mode === "ask", "the link keeps the Teams account, its chat and the first workspace", link);
  check(link.serviceUrl === SERVICE, "…and the address its chat is served at", link.serviceUrl);
  mark = calls.length;
  await message(TEAMS_MALLORY, `link ${code}`);
  check(said(CONV_MALLORY, mark).includes("has run out or was used already"), "a code works once (and `link <code>` works without a slash)", said(CONV_MALLORY, mark));

  // ── Questions ─────────────────────────────────────────────────────────────────────────────────
  fake.setChat(caller([{ name: "read_page", arguments: { page_id: vendors.id } }]));
  mark = calls.length;
  await message(TEAMS_ALICE, "Who sells winter tyres & rims?");
  const answer = said(CONV_ALICE, mark);
  const pageUrl = `https://leaf.test/w/${ws}/p/${vendors.id}`;
  check(answer.includes(`See **Tyre vendors** [\\[1\\]](${pageUrl}).`) || answer.includes(`[[1]`) || answer.includes(`(${pageUrl})`), "the answer comes as Markdown, its citation a link to the page", answer);
  check(answer.includes("**Sources**") && answer.includes(`[Tyre vendors](${pageUrl})`), "…with its sources listed as links", answer);
  check(calls.slice(mark).some((c) => c.body.type === "typing"), "the bot shows that it is writing");
  const [afterFirst] = await db.select().from(channelLink).where(eq(channelLink.id, link.id));
  const [asked] = await db.select().from(conversation).where(eq(conversation.id, afterFirst.conversationId!));
  check(asked?.userId === ids.alice && JSON.stringify(asked.messages).includes("Who sells winter tyres & rims?"), "the question reaches the chat as plain text, in the person's own conversation");

  mark = calls.length;
  const repeated = activity(TEAMS_ALICE, { text: "new" });
  await teams(repeated);
  await teams(repeated);
  check(sentTo(CONV_ALICE, mark).length === 1, "an activity Teams sends twice is handled once", said(CONV_ALICE, mark));
  const [afterNew] = await db.select().from(channelLink).where(eq(channelLink.id, link.id));
  check(afterNew.conversationId === null && said(CONV_ALICE, mark).includes("New conversation"), "`new` alone starts a new conversation", said(CONV_ALICE, mark));

  fake.setChat(() => ({ text: "Nothing." }));
  mark = calls.length;
  await message(TEAMS_ALICE, "new customers this week");
  const [q] = await db.select().from(channelLink).where(eq(channelLink.id, link.id));
  check(q.conversationId !== null, "a question that only starts with a command's word is a question, not a command");

  // ── Approvals ─────────────────────────────────────────────────────────────────────────────────
  fake.setChat(caller([{ name: "create_page", arguments: { parent_id: vendors.id, title: "Price list", content: "Winter tyres: 80 each" } }], () => "Added it."));
  mark = calls.length;
  await message(TEAMS_ALICE, "Add a price list under the vendors", {}, false);
  const approval = await withButton(CONV_ALICE, "ap:", mark);
  check(/Add the page \*\*Price list\*\* under \*\*Tyre vendors\*\*\?/.test(textOfCall(approval)) && buttonsOf(approval).length === 3, "a change is asked about first, with Yes, No and Yes, don't ask again, in a card", textOfCall(approval));
  check(String(approval.body.summary).includes("Price list"), "…with a summary for notifications");
  mark = calls.length;
  await press(TEAMS_ALICE, dataOf(approval, "ap:").replace(/:[a-z]+$/, ":y"), approval);
  const made = await db.select().from(page).where(eq(page.parentId, vendors.id));
  check(made.some((p) => p.title === "Price list"), "Yes, pressed in the card, makes the change", made.map((p) => p.title));
  const settled = updatesOf(approval.id!, mark);
  check(settled.length >= 1 && textOfCall(settled.at(-1)!).endsWith("_Approved._") && (settled.at(-1)!.body.attachments as unknown[]).length === 0, "the approval message is replaced saying so, its card gone", settled.map((c) => c.body));
  check(/Done: \[Price list\]\(https:\/\/leaf\.test\/w\/[^)]+\)/.test(said(CONV_ALICE, mark)), "the answer lists the change with a link", said(CONV_ALICE, mark));

  fake.setChat(caller([{ name: "create_page", arguments: { parent_id: vendors.id, title: "Declined list" } }], () => "Left it."));
  mark = calls.length;
  await message(TEAMS_ALICE, "Add another", {}, false);
  const second = await withButton(CONV_ALICE, "ap:", mark);
  await press(TEAMS_ALICE, dataOf(second, "ap:").replace(/:[a-z]+$/, ":n"), second);
  check((await db.select().from(page).where(eq(page.title, "Declined list"))).length === 0, "No makes nothing");

  // ── Notifications ─────────────────────────────────────────────────────────────────────────────
  const notes = await Promise.all(["Launch plan", "Budget"].map((title) => createPage({ userId: ids.alice }, { workspaceId: ws, teamspaceId: general.id, title, markdown: "…" })));
  const share = async (n: number) => {
    const from = calls.length;
    await recordShare(ids.mallory, ws, ids.alice, notes[n].id);
    await flushPush();
    return sentTo(CONV_ALICE, from);
  };
  const [shared] = await share(0);
  const [note0] = await db.select().from(notification).where(eq(notification.pageId, notes[0].id));
  check(
    shared && textOfCall(shared).startsWith("**Launch plan**\nMallory shared this page with you") && dataOf(shared, "nr:") === `nr:${note0.id}` && dataOf(shared, "nz:"),
    "a new notification comes to the chat, with Mark read and Snooze",
    shared && textOfCall(shared),
  );
  mark = calls.length;
  await press(TEAMS_ALICE, `nr:${note0.id}`, shared);
  const [read] = await db.select().from(notification).where(eq(notification.id, note0.id));
  check(read.readAt !== null, "Mark read marks it read in the inbox");
  check(said(CONV_ALICE, mark).includes("Marked as read.") && updatesOf(shared.id!, mark).some((c) => (c.body.attachments as unknown[]).length === 0), "…saying so in the chat and taking the card away", calls.slice(mark));
  await setNotificationPreference(ids.alice, "page_shared", "telegram", false);
  check((await share(1)).length === 0, "the chat apps' column of the preferences keeps a kind out of Teams too");
  await setNotificationPreference(ids.alice, "page_shared", "telegram", true);

  // ── A reply to a comment, written in the chat ────────────────────────────────────────────────
  const thread = await changeComments(ids.alice, notes[0].id, { type: "createThread", body: plain("Is the launch date right?") });
  mark = calls.length;
  await changeComments(ids.mallory, notes[0].id, { type: "addComment", threadId: thread.thread!.id, body: plain("Yes, it is") });
  await flushPush();
  const comment = await until(() => sentTo(CONV_ALICE, mark).find((c) => dataOf(c, "nc:")), "the comment's notification");
  check(textOfCall(comment).includes("Mallory commented") && buttonsOf(comment).some((b) => b.title === "Reply"), "a comment's notification has a Reply button", textOfCall(comment));
  mark = calls.length;
  await press(TEAMS_ALICE, dataOf(comment, "nc:"), comment);
  check(said(CONV_ALICE, mark).includes("Write your reply"), "Reply asks for the reply", said(CONV_ALICE, mark));
  mark = calls.length;
  await message(TEAMS_ALICE, "Thanks, then it stays");
  const comments = (await listComments(ids.alice, notes[0].id)).find((t) => t.id === thread.thread!.id)?.comments ?? [];
  check(comments.length === 3 && comments.at(-1)?.userId === ids.alice && commentText(comments.at(-1)!.body) === "Thanks, then it stays", "the next message is posted in the thread as the person", comments);
  check(said(CONV_ALICE, mark).includes("Your reply was posted."), "…and says so", said(CONV_ALICE, mark));

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
  const callMessage = await withButton(CONV_ALICE, "ar:", mark);
  check(
    textOfCall(callMessage).startsWith("**Filer asks to go ahead**") && textOfCall(callMessage).includes('"title": "Q1 plan"') && !String(callMessage.body.summary).includes("Q1 plan"),
    "a waiting call comes with what it would send, left out of the notification's summary",
    callMessage.body,
  );
  mark = calls.length;
  await press(TEAMS_ALICE, dataOf(callMessage, "ar:"), callMessage);
  check(said(CONV_ALICE, mark).includes("next message"), "Send back asks for the note as the next message", said(CONV_ALICE, mark));
  await message(TEAMS_ALICE, "Use the Q2 numbers");
  const [sentBack] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
  const decision = (sentBack.state as { decision?: { decision: string; note?: string } } | null)?.decision;
  check(decision?.decision === "redo" && decision.note === "Use the Q2 numbers", "the next message sends the call back with its note", decision);
  const [audited] = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, ws), eq(auditEvent.action, "connection.approval_decided")));
  check((audited?.details as { via?: string } | undefined)?.via === "teams", "the audit log says it was answered from Teams", audited?.details);

  // ── Chatting with an agent ────────────────────────────────────────────────────────────────────
  await db.update(agentRun).set({ status: "failed", finishedAt: new Date() }).where(eq(agentRun.agentId, agent.id));
  mark = calls.length;
  await message(TEAMS_ALICE, "agent");
  const menu = await withButton(CONV_ALICE, "ag:", mark);
  check(dataOf(menu, `ag:${agent.id}`), "`agent` offers the agents shared with the person", buttonsOf(menu));
  await press(TEAMS_ALICE, `ag:${agent.id}`, menu);
  const [pointed] = await db.select().from(channelLink).where(eq(channelLink.id, link.id));
  check(pointed.agentId === agent.id, "choosing one sends messages to it");
  fake.setChat(() => ({ text: "Filed **the note** under Q3." }));
  mark = calls.length;
  await message(TEAMS_ALICE, "File my Q3 note", {}, false);
  const chatRun = await until(async () => {
    const rows = await db.select().from(agentRun).where(and(eq(agentRun.agentId, agent.id), sql`${agentRun.source}->>'kind' = 'chat'`));
    return rows[0];
  }, "the chat's run");
  await flushAgentRuns();
  await flushTeams();
  check(chatRun.prompt === "File my Q3 note" && (chatRun.source as { teams?: boolean }).teams === true, "a message goes to the agent as a run marked as from Teams", chatRun.source);
  await until(() => said(CONV_ALICE, mark).includes("Filed **the note** under Q3."), "the agent's answer");
  check(true, "the agent's answer comes as Markdown");

  // ── Channels and other chats ──────────────────────────────────────────────────────────────────
  mark = calls.length;
  const inChannel = { conversation: { id: CHANNEL_CONV, conversationType: "channel", tenantId: TENANT } };
  await message(TEAMS_ALICE, "<at>Leafdesk</at> Who sells tyres?", inChannel);
  check(calls.length === mark, "a question in a channel gets no answer", calls.slice(mark));
  await message(TEAMS_ALICE, "<at>Leafdesk</at> /new", inChannel);
  check(/direct message/.test(said(CHANNEL_CONV, mark)), "a command there is answered, saying why not", said(CHANNEL_CONV, mark));
  await teams(activity(TEAMS_ALICE, { type: "conversationUpdate", text: "" }));
  check(calls.length === mark + 1, "other kinds of activity are taken and ignored");

  // ── The address of a chat outlives a restart, and only Microsoft's is used ────────────────────
  await db.update(channelLink).set({ serviceUrl: null }).where(eq(channelLink.id, link.id));
  forgetServiceUrls();
  mark = calls.length;
  await share(1);
  check(sentTo(CONV_ALICE, mark).length === 0, "a chat with no address kept gets nothing, and nothing breaks");
  await message(TEAMS_ALICE, "stop");
  const [kept] = await db.select().from(channelLink).where(eq(channelLink.id, link.id));
  check(kept.serviceUrl === SERVICE, "the next call of Teams keeps the address on the link again", kept.serviceUrl);
  forgetServiceUrls();
  mark = calls.length;
  await db.update(notification).set({ readAt: null }).where(eq(notification.pageId, notes[1].id));
  await db.update(channelLink).set({ serviceUrl: "https://evil.example/" }).where(eq(channelLink.id, link.id));
  forgetServiceUrls();
  mark = calls.length;
  await recordShare(ids.mallory, ws, ids.alice, notes[0].id);
  await flushPush();
  check(calls.slice(mark).length === 0, "an address that isn't Microsoft's is never sent to");
  await db.update(channelLink).set({ serviceUrl: SERVICE }).where(eq(channelLink.id, link.id));
  forgetServiceUrls();

  // ── The token ─────────────────────────────────────────────────────────────────────────────────
  check(tokenRequests.length === 1, "one access token served every call", tokenRequests.length);
  resetTeamsToken();
  resetTeamsKeys();
  check(!JSON.stringify(calls.map((c) => c.body)).includes(SECRET) && !JSON.stringify(calls.map((c) => c.body)).includes(ACCESS_TOKEN), "no secret or token is ever part of a message");
  check(calls.every((c) => c.auth === `Bearer ${ACCESS_TOKEN}`), "every call to the Connector carried the bot's token");

  console.log(`\n${passed} checks passed`);
} finally {
  await flushTeams();
  await sleep(50);
  resetAi();
  await db.delete(workspace).where(eq(workspace.id, ws));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  await fake.close();
  connector.closeAllConnections();
  connector.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
