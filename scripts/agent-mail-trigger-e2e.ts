/**
 * End-to-end check of new email starting an agent's runs (server/agents/mail-trigger.ts) against
 * the database, a real IMAP/SMTP server (GreenMail) and a fake OpenAI-compatible server: mail
 * already in the inbox when the mailbox is first read starts nothing; new mail the sweep reads
 * starts one run per thread, for its filters only (not the owner's own mail, mailing lists, or
 * senders who aren't rows when `knownOnly`), and a second message in a thread whose run waits
 * starts none; the run reads the thread first, so it is offered page reads and the mail tools only,
 * and it keeps a summary, stars the thread on the server, saves a reply in Drafts, marks the
 * message with what it did (shown in the Mail tab's list) and leaves its person an inbox report; the
 * hourly limit holds further mail back and says so on the mailbox; a run whose mailbox was closed
 * to the agent fails quietly. Rows it proposes from the email wait in For review for the mailbox's
 * owner alone: another editor of the database, and a connected app, see none of them. The mail
 * assistant template takes only the installer's own mailbox and sets all this up on it.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-mail-trigger-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Starts a GreenMail container
 * (greenmail/standalone:2.1.14) unless GREENMAIL_SMTP_PORT and GREENMAIL_IMAP_PORT name a running
 * one. Migrations must be applied. Run it with no app server on the same database: the server's
 * workers would take the runs and read the mailboxes.
 */
export {};

import { execFileSync } from "node:child_process";
import net from "node:net";

try {
  process.loadEnvFile();
} catch {}

const HOST = "127.0.0.1";
const CONTAINER = "leafdesk-greenmail-agent-mail-trigger";
process.env.MAIL_ALLOWED_HOSTS = HOST;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const given = process.env.GREENMAIL_SMTP_PORT && process.env.GREENMAIL_IMAP_PORT;
const SMTP_PORT = given ? Number(process.env.GREENMAIL_SMTP_PORT) : await freePort();
const IMAP_PORT = given ? Number(process.env.GREENMAIL_IMAP_PORT) : await freePort();
const docker = (...args: string[]) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
if (!given) {
  try {
    docker("rm", "-f", CONTAINER);
  } catch {}
  docker(
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-p",
    `${HOST}:${SMTP_PORT}:3025`,
    "-p",
    `${HOST}:${IMAP_PORT}:3143`,
    "-e",
    "GREENMAIL_OPTS=-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled",
    "greenmail/standalone:2.1.14",
  );
}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const nodemailer = (await import("nodemailer")).default;
const { ImapFlow } = await import("imapflow");
const { db } = await import("@/db");
const { agentMailbox, agentRun, conversation, mailbox, mailMessage, notification, page, schedule, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { setPagePermission } = await import("@/server/permissions");
const { runAsConnectedApp } = await import("@/server/connected-app");
const review = await import("@/server/pending-changes");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { addProperty } = await import("@/server/databases");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { connectMailbox, setMailDatabases } = await import("@/server/row-mail/settings");
const { syncDue } = await import("@/server/row-mail/sync");
const read = await import("@/server/mail-client/read");
const { closeImap } = await import("@/server/mail-client/pool");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const agents = await import("@/server/agents/manage");
const { agentMailboxesOf, setAgentMailbox, setAgentMailTrigger } = await import("@/server/agents/mail");
const { flushAgentRuns } = await import("@/server/agents/run");
const chat = await import("@/server/agents/chat");
const { setAgentSchedule } = await import("@/server/agents/schedules");
const { runDueSchedules } = await import("@/server/schedules");
const { installBuiltinAgent } = await import("@/server/agents/builtin");
const { MAX_MAIL_RUNS_PER_HOUR } = await import("@/lib/agents");

const RUN = `agent-mail-trigger-e2e-${Date.now().toString(36)}`;
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

/** A model that makes these tool calls, one turn each, then says `done`. */
function caller(calls: (() => { name: string; arguments: Record<string, unknown> })[], done: string) {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (made < calls.length) return { toolCalls: [calls[made]()] };
    return { text: done };
  };
}
const toolResults = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
const offered = (request: FakeChatRequest | undefined) => (request?.tools ?? []).map((t) => t.function.name);

const ids = { ada: `${RUN}-ada`, bob: `${RUN}-bob` };
const workspaceId = `${RUN}-ws`;
const ada = `ada.${RUN}@leafdesk.test`;
const customer = `ayse.${RUN}@acme.test`;
const stranger = `kim.${RUN}@elsewhere.test`;
const list = `news.${RUN}@lists.test`;
const servers = { imapHost: HOST, imapPort: IMAP_PORT, imapSecure: false, smtpHost: HOST, smtpPort: SMTP_PORT, smtpSecure: false };
const outside = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false, ignoreTLS: true });
const settle = () => new Promise((r) => setTimeout(r, 600));

async function serverUp() {
  for (let i = 0; i < 60; i++) {
    try {
      await outside.verify();
      const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: "probe@leafdesk.test", pass: "x" }, logger: false });
      await client.connect();
      await client.logout();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("GreenMail didn't start");
}

/** Ada's mailbox as another mail program sees it. */
async function asAda<T>(work: (client: InstanceType<typeof ImapFlow>) => Promise<T>) {
  const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: ada, pass: "x" }, logger: false });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.logout();
  }
}

/** The minute's sweep, now. */
async function sweep() {
  await settle();
  await db.update(mailbox).set({ syncedAt: null }).where(eq(mailbox.workspaceId, workspaceId));
  await syncDue();
}

const runsOf = (agentId: string) => db.select().from(agentRun).where(eq(agentRun.agentId, agentId));
const messageBy = async (subject: string) =>
  (await db.select().from(mailMessage).where(and(eq(mailMessage.subject, subject), sql`${mailMessage.mailboxId} in (select id from ${mailbox} where ${mailbox.workspaceId} = ${workspaceId})`)))[0];

let boxId = "";
let containerUp = !given;
try {
  await serverUp();
  await db.insert(user).values([
    { id: ids.ada, name: "Ada", email: `${ids.ada}@example.test` },
    { id: ids.bob, name: "Bob", email: `${ids.bob}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.ada, role: "owner" },
    { workspaceId, userId: ids.bob, role: "member" },
  ]);
  await updateWorkspaceSettings(ids.ada, workspaceId, { email: true });
  const customers = await createPage({ userId: ids.ada }, { workspaceId, kind: "database", title: "Customers" });
  const emailProperty = await addProperty(ids.ada, customers.id, { name: "Email", type: "email" });
  const notesProperty = await addProperty(ids.ada, customers.id, { name: "Notes", type: "text" });
  const acme = await createPage({ userId: ids.ada }, { workspaceId, parentId: customers.id, title: "Acme", properties: { [emailProperty.id]: customer } });
  // Bob edits the customers too; a database of Bob's Ada may only read.
  await setPagePermission(ids.ada, customers.id, ids.bob, "edit");
  const bobs = await createPage({ userId: ids.bob }, { workspaceId, kind: "database", title: "Bob's leads" });
  await setPagePermission(ids.bob, bobs.id, ids.ada, "view");
  await setMailDatabases(ids.ada, workspaceId, [{ databaseId: customers.id, propertyIds: [emailProperty.id] }]);

  await asAda(async (client) => {
    for (const name of ["Sent", "Archive", "Trash", "Junk"]) await client.mailboxCreate(name);
  });
  // Mail waiting before the agent is told about new email.
  await outside.sendMail({ from: `Ayşe Kaya <${customer}>`, to: ada, subject: `Eski konu ${RUN}`, text: "Geçen haftadan." });
  const box = await connectMailbox(ids.ada, workspaceId, { address: ada, servers, username: ada, password: "x", consent: true, displayName: "Ada", timeZone: "Europe/Istanbul" });
  boxId = box.id;

  const helper = await agents.createAgent(ids.ada, workspaceId, { name: "Posta yardımcısı", instructions: "You look after Ada's email." });
  await agents.setAgentAccess(ids.ada, helper.id, customers.id, "edit");
  check(
    await setAgentMailTrigger(ids.ada, helper.id, box.id, { on: true, task: "Summarize it", filters: {} }).then(
      () => false,
      () => true,
    ),
    "a trigger needs the mailbox opened to the agent first",
  );
  await setAgentMailbox(ids.ada, helper.id, box.id, true);
  await setAgentMailTrigger(ids.ada, helper.id, box.id, {
    on: true,
    task: "Summarize each email, star the ones that ask for a price, and draft an answer.",
    filters: { senders: [], subject: "", knownOnly: true },
  });
  const [view] = await agentMailboxesOf(ids.ada, helper.id);
  check(view?.open && view.trigger.on && view.trigger.filters.knownOnly && view.trigger.task.startsWith("Summarize"), "the trigger is kept on the opened mailbox", view);
  // Turning it on read the mailbox for the first time, in the background.
  for (let i = 0; i < 40 && !(await messageBy(`Eski konu ${RUN}`)); i++) await settle();
  await sweep();
  check((await runsOf(helper.id)).length === 0, "mail already in the inbox when it is first read starts nothing");

  // ── New mail ─────────────────────────────────────────────────────────────────────────────────
  const subject = `Fiyat talebi ${RUN}`;
  await outside.sendMail({ from: `Ayşe Kaya <${customer}>`, to: ada, subject, text: "Merhaba Ada,\n100 adet GNK 800 için fiyat alabilir miyiz? Cumaya kadar lütfen.", messageId: `<fiyat.${RUN}@acme.test>` });
  await outside.sendMail({ from: `Bülten <${list}>`, to: ada, subject: `Haftalık bülten ${RUN}`, text: "Bu hafta…", headers: { "List-Id": "<weekly.lists.test>", "List-Unsubscribe": `<mailto:${list}?subject=unsubscribe>` } });
  await outside.sendMail({ from: `Kim <${stranger}>`, to: ada, subject: `Tanışalım ${RUN}`, text: "Merhaba!" });
  await outside.sendMail({ from: `Ada <${ada}>`, to: ada, subject: `Kendime not ${RUN}`, text: "Yarın ara." });
  await outside.sendMail({ from: `Otomatik <${customer}>`, to: ada, subject: `Ofis dışında ${RUN}`, text: "Pazartesi dönerim.", headers: { "Auto-Submitted": "auto-replied" } });
  await sweep();
  let runs = await runsOf(helper.id);
  const priceMessage = await messageBy(subject);
  check(
    runs.length === 1 && runs[0].status === "pending" && runs[0].source.kind === "mail" && runs[0].source.threadId === priceMessage?.threadId && runs[0].prompt.startsWith("Summarize"),
    "new mail from a row starts one run, with the task; lists, auto-replies, strangers and the owner's own mail start none",
    runs.map((r) => ({ source: r.source, status: r.status })),
  );
  const [mailConversation] = runs[0].conversationId ? await db.select().from(conversation).where(eq(conversation.id, runs[0].conversationId)) : [];
  check(
    mailConversation?.key === `mail:${priceMessage!.threadId}` && mailConversation.agentId === helper.id && mailConversation.userId === helper.userId,
    "the run joins the agent's conversation kept for the mail thread",
    mailConversation,
  );
  check((await messageBy(`Haftalık bülten ${RUN}`))?.automated === true && (await messageBy(`Ofis dışında ${RUN}`))?.automated === true, "mailing lists and auto-replies are marked as written by a machine");

  // A second message in the thread while its run waits starts no other run.
  await outside.sendMail({ from: `Ayşe Kaya <${customer}>`, to: ada, subject: `Re: ${subject}`, text: "Bir de teslim süresini yazar mısınız?", inReplyTo: `<fiyat.${RUN}@acme.test>`, references: `<fiyat.${RUN}@acme.test>` });
  await sweep();
  runs = await runsOf(helper.id);
  check(runs.length === 1, "another message in a thread whose run waits starts no other run", runs.length);

  // ── The run ──────────────────────────────────────────────────────────────────────────────────
  const reply = (await messageBy(`Re: ${subject}`))!;
  check(reply.threadId === priceMessage!.threadId, "the answer is in the same thread");
  fake.chats.length = 0;
  fake.setChat(
    caller(
      [
        () => ({ name: "summarize_mail", arguments: { message_id: reply.id, summary: "Ayşe (Acme) asks for a price for 100 GNK 800 by Friday, and the delivery time." } }),
        () => ({ name: "sort_mail", arguments: { message_id: reply.id, action: "star" } }),
        () => ({ name: "sort_mail", arguments: { message_id: reply.id, action: "move", folder: "Trash" } }),
        () => ({ name: "edit_page", arguments: { page_id: customers.id, markdown: "x" } }),
        () => ({ name: "draft_mail", arguments: { to: [customer], subject: `Re: ${subject}`, body: "Merhaba Ayşe Hanım,\n\nFiyatı cuma gününe kadar iletiyoruz.", reply_to: reply.id } }),
      ],
      "Summarized and starred the price request, and saved an answer in Drafts.",
    ),
  );
  await flushAgentRuns();
  const [done] = await runsOf(helper.id);
  check(done.status === "done", "the run finishes", { status: done.status, code: done.code, error: done.error });
  const tools = offered(fake.chats[0]);
  check(
    ["read_page", "search_mail", "read_mail", "draft_mail", "sort_mail", "summarize_mail"].every((t) => tools.includes(t)) &&
      ["edit_page", "create_page", "add_comment", "send_email", "search_web", "read_web_page", "remember", "ask_agent", "use_tool"].every((t) => !tools.includes(t)),
    "having read the email, it is offered page reads, row proposals and the mail tools only",
    tools,
  );
  const opening = fake.chats[0].messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
  check(opening.includes("GNK 800") && opening.includes("teslim süresini") && opening.includes("Summarize each email"), "the thread is read before the model's first turn, with the task", opening.slice(0, 600));
  const results = toolResults(fake.chats.at(-1)!);
  check(results[2]?.includes("There is no folder") && /Unknown tool|not|can't|isn't/i.test(results[3] ?? ""), "the trash and page edits are refused", results);
  const steps = done.steps.filter((s) => s.kind === "mail").map((s): string => (s.kind === "mail" ? s.action : ""));
  check(["read", "summary", "sort", "draft"].every((a) => steps.includes(a)), "the run's steps show the read, the summary, the sort and the draft", steps);

  await settle();
  const [newest] = await db.select().from(mailMessage).where(eq(mailMessage.id, reply.id));
  check(newest.summary?.startsWith("Ayşe (Acme) asks"), "the summary is kept on the thread's newest message", newest.summary);
  // The read on the message that started the run, the rest on the one the model worked on.
  const thread = await db.select({ marks: mailMessage.agentMarks }).from(mailMessage).where(and(eq(mailMessage.threadId, reply.threadId), eq(mailMessage.mailboxId, box.id)));
  const marks = thread.flatMap((m) => m.marks ?? []);
  const did = new Set(marks.flatMap((m) => m.did));
  check(marks.every((m) => m.agentId === helper.id) && ["read", "summarized", "sorted", "drafted"].every((d) => did.has(d as never)), "the thread's messages are marked with what the agent did", marks);
  const flagged = await asAda(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      return (await client.search({ flagged: true, subject: `Re: ${subject}` }, { uid: true })) || [];
    } finally {
      lock.release();
    }
  });
  check(flagged.length > 0, "the star reaches the mail server", flagged);
  const draftsFolder = (await read.openMailbox(ids.ada, box.id)).folders?.find((f) => f.role === "drafts");
  const drafts = draftsFolder ? await read.listThreads(ids.ada, { mailboxId: box.id, folderId: draftsFolder.id }) : null;
  check(drafts?.items.some((t) => t.subject === `Re: ${subject}`), "the answer waits in Drafts, not sent", drafts?.items.map((t) => t.subject));
  const inbox = (await read.openMailbox(ids.ada, box.id)).folders!.find((f) => f.role === "inbox")!;
  const listed = await read.listThreads(ids.ada, { mailboxId: box.id, folderId: inbox.id });
  const item = listed.items.find((t) => t.threadId === reply.threadId);
  check(item?.agents.length === 1 && item.agents[0].name === "Posta yardımcısı" && item.agents[0].did.includes("drafted"), "the Mail tab's list shows the agent's mark on the thread", item?.agents);
  // Mail from a row also leaves its own notices (row_email): only the agent's reports count here.
  const reportsOf = () => db.select().from(notification).where(and(eq(notification.workspaceId, workspaceId), eq(notification.userId, ids.ada), inArray(notification.kind, ["agent_report", "agent_task"])));
  const reports = await reportsOf();
  check(reports.length === 1 && reports[0].kind === "agent_report" && reports[0].agentRunId === done.id, "a run that saved a draft leaves its person an inbox report", reports.map((r) => r.kind));

  // ── Proposing rows, to the mailbox's owner alone ────────────────────────────────────────────
  const order = `Yeni iletişim ${RUN}`;
  await outside.sendMail({ from: `Ayşe Kaya <${customer}>`, to: ada, subject: order, text: "Satın almadan Kim Lee (kim@acme.test) artık bizim tarafta. Cuma teslim olur mu?" });
  await sweep();
  const proposalRun = (await runsOf(helper.id)).find((r) => r.status === "pending");
  check(proposalRun, "the next email starts a run");
  fake.chats.length = 0;
  fake.setChat(
    caller(
      [
        () => ({ name: "update_row", arguments: { row_id: acme.id, properties: { Notes: "Asks whether Friday delivery works." }, reason: "Ayşe asked about delivery by Friday." } }),
        () => ({ name: "create_row", arguments: { database_id: customers.id, title: "Kim Lee", properties: { Email: "kim@acme.test" }, reason: "A new contact at Acme, named in Ayşe's email." } }),
        () => ({ name: "create_row", arguments: { database_id: bobs.id, title: "Acme", reason: "A lead." } }),
        () => ({ name: "update_row", arguments: { row_id: acme.id, title: "Acme Inc", properties: {} } }),
      ],
      "Proposed a note on Acme and a new contact for you to approve.",
    ),
  );
  await flushAgentRuns();
  const [proposed] = (await runsOf(helper.id)).filter((r) => r.id === proposalRun.id);
  check(proposed.status === "done", "the run finishes", { status: proposed.status, code: proposed.code, error: proposed.error });
  check(offered(fake.chats[0]).includes("create_row") && offered(fake.chats[0]).includes("update_row"), "a run new email started is offered create_row and update_row", offered(fake.chats[0]));
  const proposalResults = toolResults(fake.chats.at(-1)!);
  check(
    proposalResults[0]?.startsWith("Proposed") && proposalResults[1]?.startsWith("Proposed") && !proposalResults[2]?.startsWith("Proposed") && /reason/i.test(proposalResults[3] ?? ""),
    "it proposes on a database its person may edit, not elsewhere, and only with a reason",
    proposalResults,
  );
  const [acmeNow] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, acme.id));
  check(!(acmeNow.properties as Record<string, unknown>)[notesProperty.id], "nothing is changed before it is approved");
  const forAda = await review.listPendingChanges(ids.ada, workspaceId);
  check(forAda.length === 2 && forAda.every((c) => c.agent?.id === helper.id), "the mailbox's owner finds both in For review", forAda.map((c) => c.kind));
  check((await review.listPendingChanges(ids.bob, workspaceId)).length === 0 && (await review.countPendingFor(ids.bob, workspaceId)) === 0, "another editor of the database neither sees nor counts them");
  check((await review.countPendingFor(ids.ada, workspaceId)) === 2, "they count for the owner");
  const overMcp = await runAsConnectedApp({ userId: ids.ada }, () => review.listPendingChanges(ids.ada, workspaceId));
  check(overMcp.length === 0, "a connected app gets none of them, even as the owner");
  const told = await db.select({ userId: notification.userId }).from(notification).where(and(eq(notification.workspaceId, workspaceId), eq(notification.kind, "review")));
  check(told.length === 1 && told[0].userId === ids.ada, "only the owner is told", told);
  const change = forAda.find((c) => c.kind === "update_row")!;
  check((await review.getPendingChange(ids.bob, change.id)) === null, "Bob can't open one by its id either");
  check(await review.approvePendingChange(ids.bob, change.id).then(() => false, () => true), "nor approve it");
  await review.approvePendingChange(ids.ada, change.id);
  const [approved] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, acme.id));
  check((approved.properties as Record<string, unknown>)[notesProperty.id] === "Asks whether Friday delivery works.", "approved by the owner, the row changes", approved.properties);
  const proposalReport = (await reportsOf()).find((r) => r.agentRunId === proposed.id);
  check(proposalReport?.kind === "agent_report", "a run that proposed rows leaves its person a report that opens its chat");

  // ── The hourly limit ─────────────────────────────────────────────────────────────────────────
  const source = { kind: "mail" as const, mailboxId: box.id, userId: ids.ada, threadId: "earlier", messageId: "earlier" };
  await db.insert(agentRun).values(
    // With the runs above, one short of the limit.
    Array.from({ length: MAX_MAIL_RUNS_PER_HOUR - 1 - (await runsOf(helper.id)).length }, (_, i) => ({ agentId: helper.id, workspaceId, source: { ...source, messageId: `earlier-${i}` }, context: { actorId: ids.ada }, prompt: "x", status: "done" as const })),
  );
  await outside.sendMail({ from: `Ayşe Kaya <${customer}>`, to: ada, subject: `Sipariş ${RUN}`, text: "Siparişi onaylıyoruz." });
  await sweep();
  check((await db.select().from(agentMailbox).where(eq(agentMailbox.agentId, helper.id)))[0].limitedAt === null, "under the limit, nothing is held back");
  await outside.sendMail({ from: `Ayşe Kaya <${customer}>`, to: ada, subject: `Fatura ${RUN}`, text: "Faturayı bekliyoruz." });
  await sweep();
  const pending = (await runsOf(helper.id)).filter((r) => r.status === "pending");
  const [limited] = await agentMailboxesOf(ids.ada, helper.id);
  check(pending.length === 1 && limited.trigger.limitedAt, "at the hourly limit new mail starts no run, and the mailbox says so", { pending: pending.length, limitedAt: limited.trigger.limitedAt });

  // ── Closed to the agent before the run ───────────────────────────────────────────────────────
  await setAgentMailbox(ids.ada, helper.id, box.id, false);
  fake.chats.length = 0;
  await flushAgentRuns();
  const [gone] = (await runsOf(helper.id)).filter((r) => r.id === pending[0].id);
  check(gone.status === "failed" && gone.code === "mailGone" && fake.chats.length === 0, "a run whose mailbox was closed to the agent fails without reading", { status: gone.status, code: gone.code });
  const after = await reportsOf();
  check(after.length === 2 && after.every((r) => r.agentRunId !== gone.id), "and leaves no report", after.map((r) => r.agentRunId));

  // ── The mail assistant template ──────────────────────────────────────────────────────────────
  const notMine = await installBuiltinAgent(ids.ada, workspaceId, { key: "mail-assistant", databaseId: customers.id, mailboxId: `${RUN}-nope` }).catch((e: unknown) => e);
  check(notMine instanceof agents.AgentError && notMine.params.reason === "mailbox", "the mail assistant takes only one of the installer's own mailboxes", String(notMine));
  const installed = await installBuiltinAgent(ids.ada, workspaceId, { key: "mail-assistant", databaseId: customers.id, mailboxId: box.id }, { locale: "tr" });
  const [made] = await db.select().from(workspaceAgent).where(eq(workspaceAgent.id, installed.agent.id));
  check(
    installed.automationId === null && installed.triggerId === null && made.rowChanges === "review" && made.name === "Posta asistanı" && made.instructions.includes(customers.id),
    "the mail assistant is set up in the installer's language, proposing its row changes, with no automation",
    { automationId: installed.automationId, rowChanges: made.rowChanges, name: made.name },
  );
  const [opened] = (await agentMailboxesOf(ids.ada, installed.agent.id)).filter((b) => b.id === box.id);
  check(opened?.open && opened.trigger.on && opened.trigger.task.length > 0 && opened.trigger.filters.knownOnly, "its mailbox is opened to it and new email there starts it, only from people who are rows", opened);
  const shared = (await agents.listAgentAccess(ids.ada, installed.agent.id)).pages.find((p) => p.pageId === customers.id);
  check(shared?.level === "edit", "and the customers are shared with it to edit", shared);

  // ── Proposals from a chat and a daily schedule ───────────────────────────────────────────────
  // An agent changing rows directly, with Ada's mailbox opened to it but no trigger.
  const daily = await agents.createAgent(ids.ada, workspaceId, { name: "Günlük posta", instructions: "You keep the customers current from Ada's email." });
  await agents.setAgentAccess(ids.ada, daily.id, customers.id, "edit");
  await setAgentMailbox(ids.ada, daily.id, box.id, true);
  const notesOf = async () => ((await db.select({ properties: page.properties }).from(page).where(eq(page.id, acme.id)))[0].properties as Record<string, unknown>)[notesProperty.id];
  fake.chats.length = 0;
  fake.setChat(
    caller(
      [
        () => ({ name: "update_row", arguments: { row_id: acme.id, properties: { Notes: "Before mail" }, reason: "Ada asked." } }),
        () => ({ name: "read_mail", arguments: { message_id: priceMessage!.id } }),
        () => ({ name: "update_row", arguments: { row_id: acme.id, properties: { Notes: "Wants 100 GNK 800 by Friday." }, reason: "Ayşe's price request." } }),
        () => ({ name: "create_row", arguments: { database_id: customers.id, title: "Can Demir", reason: "Named in the email." } }),
        () => ({ name: "create_page", arguments: { title: "Notes" } }),
      ],
      "I proposed two changes from the email.",
    ),
  );
  const chatted = await chat.sendAgentChat(ids.ada, { workspaceId, agentId: daily.id, place: null, conversationId: null, message: "Update Acme from today's email." });
  await flushAgentRuns();
  const [chatRun] = await db.select().from(agentRun).where(eq(agentRun.id, chatted.runId!));
  check(chatRun.status === "done", "the chat's run finishes", { status: chatRun.status, code: chatRun.code, error: chatRun.error });
  check(["read_mail", "update_row", "create_row"].every((t) => offered(fake.chats[0]).includes(t)), "a chat in the app is offered the mail tools and the row writes", offered(fake.chats[0]));
  const chatResults = toolResults(fake.chats.at(-1)!);
  check(
    !chatResults[0]?.startsWith("Proposed") && chatResults[1]?.includes("GNK 800") && chatResults[2]?.startsWith("Proposed") && chatResults[3]?.startsWith("Proposed") && !chatResults[4]?.startsWith("Proposed"),
    "before email is read a chat's write is made; after, row writes are proposals and other writes are refused",
    chatResults,
  );
  check((await notesOf()) === "Before mail", "the proposal changes nothing yet");
  const fromChat = await review.listPendingChanges(ids.ada, workspaceId, { filter: { runId: chatRun.id } });
  check(fromChat.length === 2 && fromChat.every((c) => c.agent?.id === daily.id), "For review narrowed to the run lists both", fromChat.map((c) => c.kind));
  check((await review.listPendingChanges(ids.bob, workspaceId, { filter: { runId: chatRun.id } })).length === 0, "another editor of the database sees none of them");
  await review.approvePendingChange(ids.ada, fromChat.find((c) => c.kind === "update_row")!.id);
  check((await notesOf()) === "Wants 100 GNK 800 by Friday.", "approved, the row changes");

  // Through a connected app, the same chat reads no email.
  fake.chats.length = 0;
  fake.setChat(() => ({ text: "Okay." }));
  const viaApp = await runAsConnectedApp({ userId: ids.ada }, () =>
    chat.sendAgentChat(ids.ada, { workspaceId, agentId: daily.id, place: null, conversationId: null, message: "Read my email." }),
  );
  await flushAgentRuns();
  const [appRun] = await db.select().from(agentRun).where(eq(agentRun.id, viaApp.runId!));
  check(appRun.source.kind === "chat" && appRun.source.fromApp, "a chat from a connected app is marked so", appRun.source);
  check(!offered(fake.chats[0]).includes("read_mail"), "and gets no mail tools", offered(fake.chats[0]));

  // A daily schedule with no database reads the email and proposes to whoever set it.
  const morning = { frequency: "daily", interval: 1, weekdays: [], time: "08:00" } as const;
  const scheduled = await setAgentSchedule(ids.ada, daily.id, null, { rule: morning, timeZone: "Europe/Istanbul", task: "Go through today's email and keep the customers current." });
  fake.chats.length = 0;
  fake.setChat(
    caller(
      [
        () => ({ name: "search_mail", arguments: { query: "GNK" } }),
        () => ({ name: "update_row", arguments: { row_id: acme.id, properties: { Notes: "Delivery by Friday." }, reason: "From the morning's email." } }),
        () => ({ name: "edit_page", arguments: { page_id: acme.id, markdown: "x" } }),
      ],
      "Proposed one change.",
    ),
  );
  await db.update(schedule).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schedule.id, scheduled.id));
  await runDueSchedules(new Date());
  await flushAgentRuns();
  const [morningRun] = (await runsOf(daily.id)).filter((r) => r.source.kind === "schedule");
  check(morningRun?.status === "done", "the schedule's run finishes", morningRun && { status: morningRun.status, code: morningRun.code, error: morningRun.error });
  const morningTools = offered(fake.chats[0]);
  check(
    ["search_mail", "read_mail", "draft_mail", "update_row", "create_row"].every((t) => morningTools.includes(t)) && !morningTools.includes("edit_page"),
    "a schedule with no database is offered the mail tools and row proposals, no page edits",
    morningTools,
  );
  const morningResults = toolResults(fake.chats.at(-1)!);
  check(morningResults[1]?.startsWith("Proposed") && !morningResults[2]?.startsWith("Proposed"), "its row write is a proposal", morningResults);
  check((await notesOf()) === "Wants 100 GNK 800 by Friday.", "nothing changes before it is approved");
  const fromMorning = await review.listPendingChanges(ids.ada, workspaceId, { filter: { runId: morningRun.id } });
  check(fromMorning.length === 1 && (await review.listPendingChanges(ids.bob, workspaceId, { filter: { runId: morningRun.id } })).length === 0, "it waits for the person who set the schedule alone", fromMorning.length);

  // One bound to a database writes its rows, so it reads no email.
  const bound = await setAgentSchedule(ids.ada, daily.id, null, { rule: morning, timeZone: "Europe/Istanbul", task: "Tidy the customers.", databaseId: customers.id });
  fake.chats.length = 0;
  fake.setChat(() => ({ text: "Tidied." }));
  await db.update(schedule).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schedule.id, bound.id));
  await runDueSchedules(new Date());
  await flushAgentRuns();
  check(fake.chats.length > 0 && !offered(fake.chats[0]).includes("read_mail"), "a schedule bound to a database gets no mail tools", offered(fake.chats[0]));

  console.log(`\n${passed} checks passed`);
} finally {
  outside.close();
  if (boxId) closeImap(boxId);
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(notification).where(eq(notification.workspaceId, workspaceId));
  await db.delete(agentRun).where(eq(agentRun.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...Object.values(ids), ...botUsers]));
  await fake.close();
  hocuspocus.closeConnections();
  await new Promise((r) => setTimeout(r, 300));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
  if (containerUp) {
    try {
      docker("rm", "-f", CONTAINER);
    } catch {}
    containerUp = false;
  }
}
