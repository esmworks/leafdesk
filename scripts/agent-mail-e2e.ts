/**
 * End-to-end check of an agent's email to its recipients (server/agents/send-mail.ts) against the
 * database, a real SMTP/IMAP server (GreenMail) and a fake OpenAI-compatible server: an agent's
 * recipients are checked when set and kept in its versions; a schedule's run, held to the owner who
 * set it, sends one message from that owner's mailbox to the agent's recipients only (the model
 * names no address), keeps it in the mailbox's sent folder and records it in the run's steps; a
 * second message in the same run is refused. A run for someone without a mailbox, or an agent
 * without recipients, isn't offered the tool.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-mail-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Starts a GreenMail container
 * (greenmail/standalone:2.1.14) unless GREENMAIL_SMTP_PORT and GREENMAIL_IMAP_PORT name a running
 * one. Migrations must be applied. Run it with no app server on the same database: the server's
 * workers would take the schedules and runs.
 */
import { execFileSync } from "node:child_process";
import net from "node:net";

try {
  process.loadEnvFile();
} catch {}

const HOST = "127.0.0.1";
const CONTAINER = "leafdesk-greenmail-agent-mail";
process.env.MAIL_ALLOWED_HOSTS = HOST;

/** A port nothing listens on now. */
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
const { eq, inArray } = await import("drizzle-orm");
const nodemailer = (await import("nodemailer")).default;
const { ImapFlow } = await import("imapflow");
const { db } = await import("@/db");
const { agentRun, notification, schedule, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { connectMailbox } = await import("@/server/row-mail/settings");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const agents = await import("@/server/agents/manage");
const agentSchedules = await import("@/server/agents/schedules");
const { setAgentShare } = await import("@/server/agents/sharing");
const { listAgentVersions, restoreAgentVersion } = await import("@/server/agents/versions");
const { flushAgentRuns } = await import("@/server/agents/run");
const { runDueSchedules } = await import("@/server/schedules");

const RUN = `agent-mail-e2e-${Date.now().toString(36)}`;

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

async function failsWith(promise: Promise<unknown>, code: string, reason?: string) {
  return promise.then(
    () => false,
    (error: unknown) => {
      const e = error as { code?: unknown; params?: Record<string, string> };
      return e.code === code && (reason === undefined || e.params?.reason === reason);
    },
  );
}

/** A model that makes these tool calls, one turn each, then says `done`. */
function caller(calls: { name: string; arguments: Record<string, unknown> }[], done: string) {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (made < calls.length) return { toolCalls: [calls[made]] };
    return { text: done };
  };
}
const toolResults = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
const offered = (request: FakeChatRequest | undefined) => (request?.tools ?? []).map((t) => t.function.name);

const outside = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false, ignoreTLS: true });

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

/** The messages in a folder of an address's mailbox on the test server. */
async function folderOf(address: string, folder = "INBOX") {
  const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: address, pass: "x" }, logger: false });
  await client.connect();
  const out: { subject: string; from: string; to: string[]; text: string }[] = [];
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      for await (const m of client.fetch("1:*", { envelope: true, source: true })) {
        out.push({
          subject: m.envelope?.subject ?? "",
          from: m.envelope?.from?.[0]?.address ?? "",
          to: (m.envelope?.to ?? []).map((a) => a.address ?? ""),
          text: m.source?.toString() ?? "",
        });
      }
    } catch {
      // An empty mailbox has no 1:*.
    } finally {
      lock.release();
    }
  } catch {
    // No such folder.
  } finally {
    await client.logout();
  }
  return out;
}

const settle = () => new Promise((r) => setTimeout(r, 500));

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const ownerAddress = `owner-${RUN}@leafdesk.test`;
const planning = `planning-${RUN}@leafdesk.test`;
const sales = `sales-${RUN}@leafdesk.test`;
const stranger = `stranger-${RUN}@leafdesk.test`;
const servers = { imapHost: HOST, imapPort: IMAP_PORT, imapSecure: false, smtpHost: HOST, smtpPort: SMTP_PORT, smtpSecure: false };
const daily = { frequency: "daily", interval: 1, weekdays: [], time: "09:00" };
const ZONE = "Europe/Istanbul";

async function runNow(scheduleId: string) {
  await db.update(schedule).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schedule.id, scheduleId));
  await runDueSchedules(new Date());
  await flushAgentRuns();
}
const lastRun = async (agentId: string) => (await db.select().from(agentRun).where(eq(agentRun.agentId, agentId))).sort((a, b) => +b.createdAt - +a.createdAt)[0];

try {
  await serverUp();
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const orders = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: general.id, kind: "database", title: "Orders" });

  // ── Recipients ───────────────────────────────────────────────────────────────────────────────
  check(
    await failsWith(agents.createAgent(ids.owner, workspaceId, { name: "Bad", mailRecipients: ["planning@", "x"] }), "invalid", "mailRecipients"),
    "an address that isn't one is refused",
  );
  const tracker = await agents.createAgent(ids.owner, workspaceId, {
    name: "Overdue orders",
    instructions: "Every morning, email the overdue orders.",
    mailRecipients: [planning.toUpperCase(), sales, planning],
  });
  check(tracker.mailRecipients.join() === [planning, sales].join(), "recipients are kept lower case, once each", tracker.mailRecipients);
  await setAgentShare(ids.owner, tracker.id, { kind: "person", userId: ids.member }, "edit");

  // Versions keep them: a member clears them, the owner brings them back.
  await agents.updateAgent(ids.member, tracker.id, { mailRecipients: [] });
  const versions = await listAgentVersions(ids.owner, tracker.id);
  const first = versions.at(-1)!;
  await restoreAgentVersion(ids.owner, tracker.id, first.number);
  const restored = await agents.getAgent(ids.owner, tracker.id);
  check(restored.mailRecipients.join() === [planning, sales].join(), "restoring a version brings its recipients back", restored.mailRecipients);
  // After the restore, which takes back pages shared since that version.
  await agents.setAgentAccess(ids.owner, tracker.id, orders.id, "view");

  // ── A schedule's run sends one message ───────────────────────────────────────────────────────
  await updateWorkspaceSettings(ids.owner, workspaceId, { email: true });
  // A sent folder on the test server, found by its name when the mailbox connects.
  const setup = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: ownerAddress, pass: "x" }, logger: false });
  await setup.connect();
  await setup.mailboxCreate("Sent").catch(() => {});
  await setup.logout();
  await connectMailbox(ids.owner, workspaceId, { address: ownerAddress, servers, username: ownerAddress, password: "app-password", consent: true });
  const set = await agentSchedules.setAgentSchedule(ids.owner, tracker.id, null, { rule: daily, timeZone: ZONE, task: "Email the overdue orders.", databaseId: orders.id });
  const subject = `Overdue orders ${RUN}`;
  const text = "Good morning,\n\nTwo orders are past their delivery date:\n- G-1 (GNK 800-1)\n- G-2\n\nOlcay";
  fake.chats.length = 0;
  fake.setChat(
    caller(
      [
        { name: "send_email", arguments: { subject, text, to: stranger } },
        { name: "send_email", arguments: { subject: `${subject} again`, text } },
      ],
      "Emailed the overdue orders.",
    ),
  );
  await runNow(set.id);
  let run = await lastRun(tracker.id);
  check(run?.status === "done", "the schedule's run finishes", run);
  check(offered(fake.chats[0]).includes("send_email"), "a run for someone with a mailbox is offered send_email");
  const results = toolResults(fake.chats.at(-1)!);
  check(results[0]?.startsWith("Sent to") && results[1]?.includes("already"), "it sends once; a second message in the run is refused", results);
  await settle();
  const [toPlanning, toSales, toStranger, sent] = await Promise.all([folderOf(planning), folderOf(sales), folderOf(stranger), folderOf(ownerAddress, "Sent")]);
  check(
    toPlanning.length === 1 && toPlanning[0].subject === subject && toPlanning[0].from === ownerAddress && toPlanning[0].text.includes("G-1 (GNK 800-1)"),
    "the message reaches the recipients from the owner's mailbox",
    toPlanning,
  );
  check(toSales.length === 1 && toPlanning[0].to.includes(sales), "every recipient gets it, in one message", toSales);
  check(toStranger.length === 0, "an address the model names gets nothing");
  check(sent.some((m) => m.subject === subject), "it is kept in the mailbox's sent folder", sent);
  const emailSteps = run.steps.filter((s) => s.kind === "email");
  check(
    emailSteps.length === 1 && emailSteps[0].kind === "email" && emailSteps[0].outcome === "sent" && emailSteps[0].pageId === null && emailSteps[0].to?.join() === [planning, sales].join(),
    "the run's steps record it",
    run.steps,
  );

  // ── No mailbox, or no recipients: no tool ────────────────────────────────────────────────────
  const memberSet = await agentSchedules.setAgentSchedule(ids.member, tracker.id, null, { rule: daily, timeZone: ZONE, task: "Email the overdue orders.", databaseId: orders.id });
  fake.chats.length = 0;
  fake.setChat(() => ({ text: "Nothing to send." }));
  await runNow(memberSet.id);
  run = await lastRun(tracker.id);
  check(run?.status === "done" && !offered(fake.chats[0]).includes("send_email"), "a run for someone without a mailbox isn't offered it", offered(fake.chats[0]));
  await agentSchedules.removeAgentSchedule(ids.owner, tracker.id, memberSet.id);
  await agents.updateAgent(ids.owner, tracker.id, { mailRecipients: [] });
  fake.chats.length = 0;
  await runNow(set.id);
  check(!offered(fake.chats[0]).includes("send_email"), "nor is an agent without recipients", offered(fake.chats[0]));

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(notification).where(eq(notification.workspaceId, workspaceId));
  await db.delete(agentRun).where(eq(agentRun.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...userIds, ...botUsers]));
  await fake.close();
  outside.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
  if (!given) {
    try {
      docker("rm", "-f", CONTAINER);
    } catch {}
  }
}
