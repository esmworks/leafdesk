/**
 * End-to-end check of follow-up sequences on rows against the database and a real IMAP/SMTP server
 * (GreenMail, started here in a container of its own on free ports and removed at the end): a
 * template without fallbacks is refused; a row is enrolled once; a step goes out only in its send
 * window, in the sender's time zone, uses the fallback for an empty value, and not twice when a
 * round runs again; the next step answers in the same thread; the mailbox's daily limit holds the
 * rest until the next day; an "ask me first" step waits under For review (approved: sent and on to
 * the next step, dismissed: stopped); an email that doesn't pass the check pauses its enrollment and
 * tells the sender; the contact's answer read from the mailbox stops it, an automated message
 * doesn't, an out-of-office reply pauses it until the day it names; a row in the trash and a
 * disconnected mailbox stop theirs; an automation's start_sequence step enrolls as the person it
 * runs as and skips a row already enrolled; ended enrollments are pruned. Every enroll, stop and
 * send is in the audit log.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/follow-ups-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). With GREENMAIL_SMTP_PORT and GREENMAIL_IMAP_PORT
 * (on 127.0.0.1) it uses that server (CI's service); without, it needs Docker and starts
 * greenmail/standalone:2.1.14 itself. Migrations must be applied. Run it while no app server uses the
 * same database: the server's own sweeps would send the queue and read the mailboxes.
 */
export {};

import { execFileSync } from "node:child_process";
import net from "node:net";

try {
  process.loadEnvFile();
} catch {}

const HOST = "127.0.0.1";
const CONTAINER = "leafdesk-greenmail-followups";
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
const { and, eq, inArray } = await import("drizzle-orm");
const nodemailer = (await import("nodemailer")).default;
const { ImapFlow } = await import("imapflow");
const { db } = await import("@/db");
const schema = await import("@/db/schema");
const { auditEvent, automationRun, mailbox, notification, pendingChange, rowEmail, sequenceEnrollment, sequenceSend, user, workspace, workspaceMember } = schema;
const { addProperty, updateRowProperties } = await import("@/server/databases");
const { createPage, archivePage } = await import("@/server/pages");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { connectMailbox, disconnectMailbox, setMailboxSending, setMailDatabases } = await import("@/server/row-mail/settings");
const { syncDue } = await import("@/server/row-mail/sync");
const { sendDue } = await import("@/server/row-mail/send");
const { listInbox } = await import("@/server/notifications");
const { approvePendingChange, dismissPendingChange, getPendingChange } = await import("@/server/pending-changes");
const manage = await import("@/server/sequences/manage");
const { runSequences } = await import("@/server/sequences/run");
const automations = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");
const { MAX_BULK_ENROLL } = await import("@/lib/sequences");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");

const RUN = `followups-e2e-${Date.now().toString(36)}`;
const DAY = 86_400_000;
const HOUR = 3_600_000;

// Pages are made through the collaboration service, as in the app.
const { hocuspocus, service } = createCollab();
registerCollab(service);

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

async function errorCode(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof manage.SequenceError ? error.code : String(error);
  }
}

const ids = { owner: `${RUN}-owner`, ada: `${RUN}-ada` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const adaAddress = `ada.${RUN}@leafdesk.test`;
const ownerAddress = `owner.${RUN}@leafdesk.test`;
const contact = (n: string) => `${n}.${RUN}@acme.test`;
const servers = { imapHost: HOST, imapPort: IMAP_PORT, imapSecure: false, smtpHost: HOST, smtpPort: SMTP_PORT, smtpSecure: false };
const TIME_ZONE = "Europe/Istanbul"; // UTC+3 all year

/**
 * The rounds run as of chosen moments, all after now (enrolling makes a step due from the real
 * clock): T0 is a Wednesday 10:00 in Istanbul (07:00 UTC) at least a day ahead, inside the default
 * window (weekdays 09:00-17:00).
 */
const T0 = (() => {
  const d = new Date(Date.now() + DAY);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7, 0);
})();

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

/** The messages in an address's inbox on the test server. */
async function inboxOf(address: string) {
  const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: address, pass: "x" }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  const out: { subject: string; messageId: string; inReplyTo: string; text: string }[] = [];
  try {
    for await (const m of client.fetch("1:*", { envelope: true, source: true })) {
      const source = m.source?.toString() ?? "";
      out.push({ subject: m.envelope?.subject ?? "", messageId: m.envelope?.messageId ?? "", inReplyTo: m.envelope?.inReplyTo ?? "", text: source.split(/\r?\n\r?\n/).slice(1).join("\n\n") });
    }
  } catch {
    // An empty mailbox has no 1:*.
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
}

const settle = () => new Promise((r) => setTimeout(r, 500));

/** Sends what is queued, and waits for the test server to have it. */
async function sendQueued() {
  await sendDue();
  await settle();
}

/** Reads the workspace's mailboxes now, as the minute's sweep would. */
async function readMailboxes() {
  await settle();
  await db.update(mailbox).set({ syncedAt: null }).where(eq(mailbox.workspaceId, workspaceId));
  await syncDue();
}

const enrollmentOf = async (id: string) => (await db.select().from(sequenceEnrollment).where(eq(sequenceEnrollment.id, id)))[0];
const sendsOf = (id: string) => db.select().from(sequenceSend).where(eq(sequenceSend.enrollmentId, id)).orderBy(sequenceSend.step);
const audits = async (action: string) => (await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, action)))).length;
const enroll = async (userId: string, sequenceId: string, rowId: string) => {
  const [outcome] = await manage.enrollRows(userId, sequenceId, [rowId], "row");
  if (!outcome.ok) throw new Error(`enrolling failed: ${outcome.code}`);
  return outcome.enrollment.id;
};

let containerUp = !given;
try {
  await serverUp();
  await db.insert(user).values([
    { id: ids.owner, name: "Owner", email: `${ids.owner}@example.test` },
    { id: ids.ada, name: "Ada", email: `${ids.ada}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.ada, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const leads = await createPage(actor, { workspaceId, kind: "database", title: "Leads" });
  const email = await addProperty(ids.owner, leads.id, { name: "Email", type: "email" });
  const company = await addProperty(ids.owner, leads.id, { name: "Company", type: "text" });
  const stage = await addProperty(ids.owner, leads.id, { name: "Stage", type: "text" });
  const row = async (title: string, address: string | null, companyName = "") => {
    const made = await createPage(actor, {
      workspaceId,
      parentId: leads.id,
      title,
      properties: { ...(address ? { [email.id]: address } : {}), ...(companyName ? { [company.id]: companyName } : {}) },
    });
    return made.id;
  };

  await updateWorkspaceSettings(ids.owner, workspaceId, { email: true });
  const connect = (userId: string, address: string) =>
    connectMailbox(userId, workspaceId, { address, servers, username: address, password: "app-password", consent: true, displayName: userId === ids.ada ? "Ada" : "Owner", timeZone: TIME_ZONE });
  const adaBox = await connect(ids.ada, adaAddress);
  await connect(ids.owner, ownerAddress);
  check(adaBox.timeZone === TIME_ZONE && adaBox.followUpDailyLimit === 50, "a mailbox keeps its owner's time zone, and sends 50 follow-ups a day unless told otherwise", adaBox);
  await setMailDatabases(ids.owner, workspaceId, [{ databaseId: leads.id, propertyIds: [email.id] }]);

  // Sequences
  check((await errorCode(() => manage.createSequence(ids.owner, leads.id, { name: "x", steps: [{ days: 0, subject: "Hi", text: "Hello {{Company}}", mode: "auto" }] }))) === "noFallback", "a variable without a fallback can't be saved");
  check((await errorCode(() => manage.createSequence(ids.owner, leads.id, { name: "x", steps: [{ days: 0, subject: "Hi", text: "Hello {{Budget | there}}", mode: "auto" }] }))) === "unknownVariable", "nor one the database has no property for");
  check((await errorCode(() => manage.createSequence(ids.ada, leads.id, { name: "x", steps: [{ days: 0, subject: "Hi", text: "Hello", mode: "auto" }] }))) !== null, "members don't manage sequences");
  const auto = await manage.createSequence(ids.owner, leads.id, {
    name: "Offer follow-up",
    steps: [
      { days: 0, subject: "Our offer for {{Company | your team}}", text: "Hi {{Company | there}},\n\nHere is the offer we talked about.\n\n{{Sender | Our team}}", mode: "auto" },
      { days: 3, text: "Just checking whether the offer reached you, {{Company | there}}.", mode: "auto" },
    ],
  });
  const asked = await manage.createSequence(ids.owner, leads.id, {
    name: "Careful follow-up",
    steps: [
      { days: 0, subject: "About {{Company | your request}}", text: "Hi,\n\nA first note.", mode: "review" },
      { days: 2, text: "A second note.", mode: "review" },
    ],
  });
  check(auto.steps.length === 2 && auto.window.start === 9 * 60 && auto.window.days.join() === "1,2,3,4,5", "a sequence keeps its steps, and sends on weekdays 09:00-17:00 unless told otherwise", auto);

  // Enrolling
  const acme = await row("Acme deal", contact("acme"), "Acme");
  const blank = await row("Blank deal", contact("blank"));
  const nobody = await row("No address", null, "Nobody Inc");
  const acmeId = await enroll(ids.ada, auto.id, acme);
  const again = await manage.enrollRows(ids.ada, auto.id, [acme, nobody], "bulk");
  check(again[0].ok === false && again[0].code === "alreadyEnrolled", "a row is in a sequence once at a time", again);
  check(again[1].ok === false && again[1].code === "noAddress", "a row without an address is skipped", again);
  check((await errorCode(() => manage.enrollRows(ids.ada, auto.id, Array.from({ length: MAX_BULK_ENROLL + 1 }, (_, i) => `x${i}`), "bulk"))) === "tooManyRows", `more than ${MAX_BULK_ENROLL} rows at once are refused, not cut short`);
  const blankId = await enroll(ids.ada, auto.id, blank);
  check((await audits("sequence.enrolled")) === 2, "each enrollment is in the audit log");

  // Send window, fallback, idempotence
  await runSequences(T0 - 4 * HOUR); // 06:00 in Istanbul
  check((await sendsOf(acmeId)).length === 0, "nothing goes out before the send window opens in the sender's time zone");
  check((await enrollmentOf(acmeId)).nextAt!.getTime() === T0 - HOUR, "the step waits for 09:00 there", await enrollmentOf(acmeId));
  await runSequences(T0);
  await runSequences(T0);
  check((await sendsOf(acmeId)).length === 1, "once open, step 1 goes out, and a second round at the same moment doesn't send it again");
  const blankAt = (await enrollmentOf(blankId)).nextAt!.getTime();
  check(blankAt > T0 && blankAt <= T0 + 8 * 60_000, "the next email from the same mailbox waits a few minutes", { blankAt: new Date(blankAt), T0: new Date(T0) });
  await runSequences(blankAt);
  check((await sendsOf(blankId)).length === 1, "and then goes out");
  const acmeAfter = await enrollmentOf(acmeId);
  check(acmeAfter.step === 1 && acmeAfter.status === "active" && acmeAfter.nextAt!.getTime() === T0 + 3 * DAY, "the enrollment moves on to step 2, due its days later", acmeAfter);
  check((await audits("sequence.sent")) === 2, "each send is in the audit log");
  await sendQueued();
  const [first] = await inboxOf(contact("acme"));
  check(first?.subject === "Our offer for Acme" && first.text.includes("Hi Acme,") && first.text.includes("Ada"), "the email is written from the row's values and the sender's name", first);
  const [blankMail] = await inboxOf(contact("blank"));
  check(blankMail?.subject === "Our offer for your team" && blankMail.text.includes("Hi there,"), "an empty value takes its fallback", blankMail);

  // Ask me first
  const carefulRow = await row("Careful deal", contact("careful"), "Careful");
  const careful = await enroll(ids.ada, asked.id, carefulRow);
  await runSequences(T0 + 10 * 60_000);
  const waiting = await enrollmentOf(careful);
  check(waiting.status === "waiting" && waiting.pendingChangeId, "an \"ask me first\" step waits for review", waiting);
  const [draft] = await db.select().from(pendingChange).where(eq(pendingChange.id, waiting.pendingChangeId!));
  check(draft.kind === "email_draft" && draft.senderId === ids.ada && draft.agentId === null, "as an email draft in its sender's For review", draft);
  const view = await getPendingChange(ids.ada, draft.id);
  check(view?.sequence?.name === "Careful follow-up" && view.sequence.step === 1 && view.sequence.steps === 2, "which says which step of which sequence it is", view);
  check((await sendsOf(careful)).length === 0, "nothing goes out before it is approved");
  await approvePendingChange(ids.ada, draft.id);
  await runSequences(T0 + 11 * 60_000);
  const approved = await enrollmentOf(careful);
  check(approved.status === "active" && approved.step === 1 && (await sendsOf(careful)).length === 1, "approved, the email goes out and the sequence goes on", approved);
  await sendQueued();
  check((await inboxOf(contact("careful")))[0]?.subject === "About Careful", "the contact gets it");
  // An email that doesn't pass the check
  const bold = await row("Bold deal", contact("bold"), "**Bold** Corp");
  const boldId = await enroll(ids.ada, auto.id, bold);
  await runSequences(T0 + 20 * 60_000);
  const paused = await enrollmentOf(boldId);
  check(paused.status === "paused" && paused.reason === "checkFailed" && paused.problems?.includes("markdown"), "an email that doesn't pass the check isn't sent, and the enrollment pauses with why", paused);
  check((await sendsOf(boldId)).length === 0, "nothing went out");
  const told = (await listInbox(ids.ada, workspaceId)).find((n) => n.kind === "follow_up");
  check(told?.followUp?.sequence === "Offer follow-up" && told.pageId === bold, "its sender is told, on the row", told);
  const resumed = await manage.resumeEnrollment(ids.ada, boldId);
  check(resumed.status === "active", "its sender may resume it");
  check((await errorCode(() => manage.resumeEnrollment(ids.owner, boldId))) !== null, "nobody else may");
  const stopped = await manage.stopEnrollment(ids.ada, boldId);
  check(stopped.status === "stopped" && stopped.reason === "manual", "stopping it by hand ends it");
  check((await audits("sequence.stopped")) === 1, "a stop is in the audit log");

  // The contact answers, or is away (read from the mailbox)
  const replyRow = await row("Reply deal", contact("reply"), "Reply");
  const awayRow = await row("Away deal", contact("away"), "Away");
  const replyId = await enroll(ids.ada, auto.id, replyRow);
  const awayId = await enroll(ids.ada, auto.id, awayRow);
  await runSequences(T0 + 30 * 60_000);
  await runSequences(T0 + 40 * 60_000);
  await sendQueued();
  const [toReply] = await inboxOf(contact("reply"));
  const [toAway] = await inboxOf(contact("away"));
  check(toReply && toAway, "both got step 1");
  await outside.sendMail({
    from: contact("reply"),
    to: adaAddress,
    subject: "Delivery report",
    text: "Your message was delivered.",
    inReplyTo: toReply.messageId,
    references: [toReply.messageId],
    headers: { "Auto-Submitted": "auto-generated" },
  });
  await readMailboxes();
  check((await enrollmentOf(replyId)).status === "active", "an automated message on the row doesn't stop it");
  await outside.sendMail({ from: contact("reply"), to: adaAddress, subject: `Re: ${toReply.subject}`, text: "Thanks, we'll look at it.", inReplyTo: toReply.messageId, references: [toReply.messageId] });
  const back = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
  await outside.sendMail({
    from: contact("away"),
    to: adaAddress,
    subject: `Out of office: ${toAway.subject}`,
    text: `I am out of the office until ${back} with limited access to email.`,
    inReplyTo: toAway.messageId,
    references: [toAway.messageId],
    headers: { "Auto-Submitted": "auto-replied", "X-Autoreply": "yes" },
  });
  await readMailboxes();
  const answered = await enrollmentOf(replyId);
  check(answered.status === "stopped" && answered.reason === "replied", "the contact's answer stops it", answered);
  const away = await enrollmentOf(awayId);
  const dayAfter = new Date(Date.parse(`${back}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  check(
    away.status === "paused" && away.reason === "outOfOffice" && away.pausedUntil?.toISOString() === new Date(Date.parse(`${dayAfter}T00:00:00Z`) - 3 * HOUR).toISOString(),
    "an out-of-office reply pauses it until the day after the one it names, in the sender's time zone",
    away,
  );
  // The trash
  const trashRow = await row("Trashed deal", contact("trashed"), "Trashed");
  const trashId = await enroll(ids.ada, auto.id, trashRow);
  await archivePage(ids.owner, trashRow);
  await runSequences(T0 + 50 * 60_000);
  check((await enrollmentOf(trashId)).reason === "rowTrashed", "a row in the trash stops its enrollment");
  // Daily limit
  await setMailboxSending(ids.owner, workspaceId, { dailyLimit: 1, timeZone: TIME_ZONE });
  check((await errorCode(() => setMailboxSending(ids.owner, workspaceId, { dailyLimit: 0, timeZone: TIME_ZONE }))) !== null, "a daily limit is at least 1");
  const limitA = await enroll(ids.owner, auto.id, await row("Limit A", contact("limita"), "Limit A"));
  const limitB = await enroll(ids.owner, auto.id, await row("Limit B", contact("limitb"), "Limit B"));
  const thursday = T0 + DAY;
  await runSequences(thursday);
  await runSequences(thursday + HOUR);
  const sentThursday = (await sendsOf(limitA)).length + (await sendsOf(limitB)).length;
  check(sentThursday === 1, "a mailbox with a daily limit of 1 sends one follow-up that day", { sentThursday });
  await runSequences(thursday + DAY);
  check((await sendsOf(limitA)).length + (await sendsOf(limitB)).length === 2, "and the other the next day");
  await sendQueued();

  // Friday: the careful sequence's next step
  await runSequences(T0 + 2 * DAY + 11 * 60_000);
  const second = await enrollmentOf(careful);
  check(second.status === "waiting" && second.pendingChangeId && second.pendingChangeId !== draft.id, "the next step waits for review in its turn", second);
  await dismissPendingChange(ids.ada, second.pendingChangeId!);
  await runSequences(T0 + 2 * DAY + 12 * 60_000);
  const dismissed = await enrollmentOf(careful);
  check(dismissed.status === "stopped" && dismissed.reason === "dismissed", "dismissing it stops the sequence", dismissed);
  check((await audits("sequence.stopped")) >= 2, "and that too is in the audit log");

  // Step 2: the weekend, then the same thread
  await runSequences(T0 + 3 * DAY + HOUR); // Saturday
  check((await sendsOf(acmeId)).length === 1, "nothing goes out on the weekend");
  const monday = T0 + 5 * DAY - HOUR; // Monday 09:00
  check((await enrollmentOf(acmeId)).nextAt!.getTime() === monday, "the step waits for Monday 09:00", await enrollmentOf(acmeId));
  await runSequences(monday);
  await runSequences(monday + 10 * 60_000); // the other row due then waits a few minutes after the first
  await sendQueued();
  const acmeMails = await inboxOf(contact("acme"));
  check(acmeMails.length === 2 && acmeMails[1].subject === "Re: Our offer for Acme" && acmeMails[1].inReplyTo === first.messageId, "step 2 answers step 1 in its thread", acmeMails);
  const finished = await enrollmentOf(acmeId);
  check(finished.status === "finished" && finished.sent === 2 && finished.endedAt, "after the last step the enrollment is finished", finished);

  // Automations
  const automation = await automations.createAutomation(ids.owner, leads.id, {
    name: "Follow up on offers",
    trigger: { type: "property_changed", properties: ["Stage"] },
    actions: [{ type: "start_sequence", sequence: "Offer follow-up" }],
  });
  check(automation, "an automation can start a sequence, named by its name");
  const autoRow = await row("Automated deal", contact("automated"), "Automated");
  await updateRowProperties(ids.ada, autoRow, { [stage.id]: "Offer sent" });
  await flushAutomations();
  const [byAutomation] = await db.select().from(sequenceEnrollment).where(eq(sequenceEnrollment.rowId, autoRow));
  check(byAutomation?.source === "automation" && byAutomation.senderId === ids.owner, "its step enrolls the row, sending as the person it runs as", byAutomation);
  await updateRowProperties(ids.ada, autoRow, { [stage.id]: "Offer revised" });
  await flushAutomations();
  const runs = await db.select().from(automationRun).where(eq(automationRun.rowId, autoRow)).orderBy(automationRun.createdAt);
  const lastStep = runs.at(-1)?.steps[0];
  check(runs.length === 2 && lastStep?.status === "skipped" && lastStep.code === "alreadyEnrolled", "a row already in the sequence is skipped, not failed", runs.map((r) => r.steps));
  check((await db.select().from(sequenceEnrollment).where(eq(sequenceEnrollment.rowId, autoRow))).length === 1, "and isn't enrolled twice");

  // Back from the office
  await runSequences(away.pausedUntil!.getTime() - HOUR);
  check((await enrollmentOf(awayId)).status === "paused", "it stays paused until then");
  await runSequences(away.pausedUntil!.getTime() + 11 * HOUR);
  const woke = await enrollmentOf(awayId);
  check(woke.status !== "paused" && woke.reason !== "outOfOffice", "and goes on after", woke);

  // Disconnecting, retention
  const lastRow = await row("Last deal", contact("last"), "Last");
  const lastId = await enroll(ids.ada, auto.id, lastRow);
  await disconnectMailbox(ids.ada, workspaceId);
  await runSequences(T0 + 60 * 60_000);
  check((await enrollmentOf(lastId)).reason === "mailboxDisconnected", "disconnecting the sender's mailbox stops theirs");
  const open = await db.select({ id: sequenceEnrollment.id }).from(sequenceEnrollment).where(and(eq(sequenceEnrollment.workspaceId, workspaceId), inArray(sequenceEnrollment.status, ["active", "waiting", "paused"])));
  const pruned = await manage.pruneEnrollments(new Date(Date.now() + 1000), [workspaceId]);
  const left = await db.select({ id: sequenceEnrollment.id }).from(sequenceEnrollment).where(eq(sequenceEnrollment.workspaceId, workspaceId));
  check(pruned > 0 && open.every((o) => left.some((l) => l.id === o.id)), "ended enrollments are pruned after their time, open ones kept", { pruned, left: left.length, open: open.length });
  check((await db.select().from(rowEmail).where(eq(rowEmail.rowId, acme))).length === 2, "the row keeps the emails it sent");

  console.log(`\n${passed} checks passed`);
} finally {
  outside.close();
  await db.delete(notification).where(eq(notification.workspaceId, workspaceId));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
  if (containerUp) {
    try {
      docker("rm", "-f", CONTAINER);
    } catch {}
    containerUp = false;
  }
}
