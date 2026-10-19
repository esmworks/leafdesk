/**
 * End-to-end check of email on database rows against the database and a real IMAP/SMTP server
 * (GreenMail): a member's mailbox is tried before it is kept and refused without consent or while
 * the workspace has email off; mail whose other party is a row's address lands on that row, its
 * attachment kept as a file of the row, and tells the mailbox's owner and the row's followers
 * (not someone who may not see the address); mail with nobody in the databases is never fetched
 * whole; the first database in order where exactly one row matches wins; a reply written on the
 * row goes out from the member's mailbox in its thread, and an answer to it lands on the row by
 * its thread even from another address; the copy in the sent folder isn't taken twice; hiding a
 * message takes it off the row and out of the inbox; a member who leaves loses their mailbox.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   docker run -d --name leafdesk-greenmail -p 3025:3025 -p 3143:3143 \
 *     -e GREENMAIL_OPTS="-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
 *     greenmail/standalone:2.1.14
 *   MAIL_ALLOWED_HOSTS=127.0.0.1 pnpm tsx scripts/row-mail-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present), MAIL_ALLOWED_HOSTS naming the test server's
 * host, GREENMAIL_HOST (127.0.0.1), GREENMAIL_SMTP_PORT (3025) and GREENMAIL_IMAP_PORT (3143).
 * Migrations must be applied. Run it while no app server uses the same database: the server's own
 * sweeps would read the mailbox and send the queue.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const HOST = process.env.GREENMAIL_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.GREENMAIL_SMTP_PORT ?? 3025);
const IMAP_PORT = Number(process.env.GREENMAIL_IMAP_PORT ?? 3143);
process.env.MAIL_ALLOWED_HOSTS ||= HOST;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const nodemailer = (await import("nodemailer")).default;
const { ImapFlow } = await import("imapflow");
const { db } = await import("@/db");
const { file, mailbox, notification, rowEmail, rowEmailAttachment, user, workspace, workspaceMember } = await import("@/db/schema");
const databases = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setPropertyAccess } = await import("@/server/property-access");
const { listInbox } = await import("@/server/notifications");
const { setFollowing } = await import("@/server/row-follow");
const { removeMember, updateWorkspaceSettings } = await import("@/server/workspaces");
const { connectMailbox, getMailSettings, RowMailError, setMailDatabases } = await import("@/server/row-mail/settings");
const { syncDue } = await import("@/server/row-mail/sync");
const { queueRowEmail, sendDue } = await import("@/server/row-mail/send");
const { hideRowEmail, listRowEmails } = await import("@/server/row-mail/list");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");

const RUN = `rowmail-e2e-${Date.now().toString(36)}`;

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

async function failsWith(code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof RowMailError && error.code === code;
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, follower: `${RUN}-follower`, hidden: `${RUN}-hidden` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
// Addresses on the test server: each run its own, so mail of earlier runs doesn't count.
const ada = `ada.${RUN}@leafdesk.test`;
const customer = `buyer.${RUN}@acme.test`;
const colleague = `boss.${RUN}@acme.test`;
const stranger = `someone.${RUN}@elsewhere.test`;
const servers = { imapHost: HOST, imapPort: IMAP_PORT, imapSecure: false, smtpHost: HOST, smtpPort: SMTP_PORT, smtpSecure: false };

const outside = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false, ignoreTLS: true });

/** Sends a message to the test server as someone outside the workspace. */
async function deliver(mail: { from: string; to: string; subject: string; text: string; inReplyTo?: string; references?: string[]; attachments?: { filename: string; content: string }[] }) {
  const info = await outside.sendMail(mail);
  return info.messageId.replace(/^<|>$/g, "");
}

/** The messages in a folder of an address's mailbox on the test server, with their headers. */
async function inboxOf(address: string, folder = "INBOX") {
  const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: address, pass: "x" }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock(folder);
  const out: { subject: string; messageId: string; inReplyTo: string; headers: string }[] = [];
  try {
    for await (const m of client.fetch("1:*", { envelope: true, headers: ["references", "in-reply-to"] })) {
      out.push({ subject: m.envelope?.subject ?? "", messageId: m.envelope?.messageId ?? "", inReplyTo: m.envelope?.inReplyTo ?? "", headers: m.headers?.toString() ?? "" });
    }
  } catch {
    // An empty mailbox has no 1:*.
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
}

/** Reads the workspace's mailboxes now, as the minute's sweep would. */
async function readMailboxes() {
  await db.update(mailbox).set({ syncedAt: null }).where(eq(mailbox.workspaceId, workspaceId));
  await syncDue();
}

/** Waits for the test server to have delivered what was just sent. */
const settle = () => new Promise((r) => setTimeout(r, 500));

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id.split("-").at(-1)!, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.follower, role: "member" },
    { workspaceId, userId: ids.hidden, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const customers = await createPage(actor, { workspaceId, kind: "database", title: "Customers" });
  const contacts = await createPage(actor, { workspaceId, kind: "database", title: "Contacts" });
  // Members get edit access, not the workspace-wide default (full access sees every property).
  await setPagePermission(ids.owner, customers.id, ids.owner, "full");
  await setPagePermission(ids.owner, customers.id, null, "none");
  for (const id of [ids.member, ids.follower, ids.hidden]) await setPagePermission(ids.owner, customers.id, id, "edit");
  const customerEmail = await databases.addProperty(ids.owner, customers.id, { name: "Email", type: "email" });
  const contactEmail = await databases.addProperty(ids.owner, contacts.id, { name: "Email", type: "email" });
  const acme = await createPage(actor, { workspaceId, parentId: customers.id, title: "Acme", properties: { [customerEmail.id]: customer } });
  // The same address in a second database: the first one in order wins.
  const person = await createPage(actor, { workspaceId, parentId: contacts.id, title: "Buyer at Acme", properties: { [contactEmail.id]: `MAILTO:${customer.toUpperCase()}` } });
  // Two rows with one address: neither is guessed.
  await createPage(actor, { workspaceId, parentId: contacts.id, title: "Twin 1", properties: { [contactEmail.id]: colleague } });
  await createPage(actor, { workspaceId, parentId: contacts.id, title: "Twin 2", properties: { [contactEmail.id]: colleague } });
  // Someone who sees the row but not its address reads none of its mail.
  await setPropertyAccess(ids.owner, customerEmail.id, {
    everyone: "none",
    exceptions: [
      { userId: ids.member, level: "view" },
      { userId: ids.follower, level: "view" },
    ],
  });
  await setFollowing(ids.follower, acme.id, true);
  await setFollowing(ids.hidden, acme.id, true);

  // Settings
  const connect = (userId: string, address: string, extra: Partial<Parameters<typeof connectMailbox>[2]> = {}) =>
    connectMailbox(userId, workspaceId, { address, servers, username: address, password: "app-password", consent: true, ...extra });
  check(await failsWith("disabled", () => connect(ids.member, ada)), "no mailbox connects while the workspace has email off");
  await updateWorkspaceSettings(ids.owner, workspaceId, { email: true });
  check(await failsWith("consent", () => connect(ids.member, ada, { consent: false })), "nor without its owner's consent");
  check(
    await failsWith("blocked", () => connect(ids.member, ada, { servers: { ...servers, imapHost: "10.1.2.3" } })),
    "a mail server on a private network that the instance doesn't allow is refused",
  );
  // A sent folder, as mail programs make one.
  {
    const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: ada, pass: "x" }, logger: false });
    await client.connect();
    await client.mailboxCreate("Sent").catch(() => {});
    await client.logout();
  }
  const box = await connect(ids.member, ada, { displayName: "Ada" });
  check(box.status === "ok" && box.address === ada, "a member's mailbox is tried, then kept", box);
  const [stored] = await db.select().from(mailbox).where(eq(mailbox.id, box.id));
  check(stored.secret !== "app-password" && !stored.secret.includes("app-password"), "its password is kept sealed");
  check(!JSON.stringify(await getMailSettings(ids.member, workspaceId)).includes("app-password"), "and never comes back out");
  await setMailDatabases(ids.owner, workspaceId, [
    { databaseId: customers.id, propertyIds: [customerEmail.id] },
    { databaseId: contacts.id, propertyIds: ["*"] },
  ]);
  check(
    (await getMailSettings(ids.owner, workspaceId)).databases.map((d) => d.databaseId).join() === `${customers.id},${contacts.id}`,
    "owners set the databases mail lands on, in order",
  );
  check(!(await setMailDatabases(ids.member, workspaceId, []).then(() => true).catch(() => false)), "members can't");

  // Mail comes in
  const first = await deliver({
    from: `Buyer <${customer}>`,
    to: ada,
    subject: "Offer request",
    text: "Please send us an offer for 3 units.",
    attachments: [{ filename: "specs.txt", content: "cooling 12 kW" }],
  });
  await deliver({ from: stranger, to: ada, subject: "Lunch?", text: "Personal mail" });
  await deliver({ from: colleague, to: ada, subject: "Ambiguous", text: "Two rows have this address" });
  await settle();
  await readMailboxes();
  const onRows = await db.select().from(rowEmail).where(eq(rowEmail.workspaceId, workspaceId));
  const received = onRows.find((e) => e.messageId === first);
  check(received?.rowId === acme.id && received.direction === "in", "mail from a row's address lands on that row", onRows);
  check(received.text.includes("3 units") && received.subject === "Offer request", "with its text and subject");
  check(!onRows.some((e) => e.rowId === person.id), "in the first database in order where a row has the address");
  check(!onRows.some((e) => e.subject === "Lunch?"), "mail with nobody in the databases stays in the mailbox");
  check(!onRows.some((e) => e.subject === "Ambiguous"), "and so does mail two rows of a database could be for");
  const attachments = await db.select().from(rowEmailAttachment).where(eq(rowEmailAttachment.rowEmailId, received.id));
  const [kept] = attachments.length ? await db.select().from(file).where(eq(file.id, attachments[0].fileId)) : [];
  check(attachments.length === 1 && kept?.pageId === acme.id && kept.referencedAt !== null, "its attachment is kept as a file of the row", attachments);

  const memberView = await listRowEmails(ids.member, acme.id);
  check(memberView?.emails.length === 1 && memberView.canSend && memberView.from === ada, "the row shows it, and its mailbox's owner may answer", memberView);
  check(memberView.addresses.join() === customer, "a new message starts addressed to the row");
  const ownerView = await listRowEmails(ids.owner, acme.id);
  check(ownerView?.emails.length === 1 && !ownerView.canSend, "the owner reads it too, but has no mailbox to answer from");
  check((await listRowEmails(ids.hidden, acme.id)) === null, "someone who may not see the row's address reads none of its mail");

  const told = async (userId: string) => (await listInbox(userId, workspaceId, ["row_email"])).filter((n) => n.pageId === acme.id);
  const memberInbox = await told(ids.member);
  check(memberInbox.length === 1 && memberInbox[0].rowEmail?.subject === "Offer request", "the mailbox's owner is told", memberInbox);
  check((await told(ids.follower)).length === 1, "so is someone who follows the row");
  check((await told(ids.hidden)).length === 0, "but not a follower who may not see its address");
  check((await listInbox(ids.follower, workspaceId)).some((n) => n.kind === "row_email"), "it is in the inbox's All tab too");

  // Reading again takes nothing twice
  await readMailboxes();
  check((await db.select().from(rowEmail).where(eq(rowEmail.workspaceId, workspaceId))).length === onRows.length, "reading the mailbox again takes nothing twice");

  // A reply from the row
  check(await failsWith("noMailbox", () => queueRowEmail(ids.owner, acme.id, { to: [customer], subject: "Hi", text: "Hi" })), "someone without a mailbox can't write");
  const replyId = await queueRowEmail(ids.member, acme.id, {
    to: [customer],
    subject: "Re: Offer request",
    text: "Our offer is attached.\n\n> Please send us an offer",
    replyTo: received.id,
  });
  const [queued] = await db.select().from(rowEmail).where(eq(rowEmail.id, replyId));
  check(queued.status === "queued" && queued.inReplyTo === first && queued.references.includes(first), "a reply waits in the queue, in its thread", queued);
  check(queued.messageId.endsWith("@leafdesk.test") && queued.fromName === "Ada", "from the member's mailbox, named as they chose");
  await sendDue();
  const [sent] = await db.select().from(rowEmail).where(eq(rowEmail.id, replyId));
  check(sent.status === "sent" && sent.error === null, "and goes out", sent);
  check((await db.select().from(mailbox).where(eq(mailbox.id, box.id)))[0].folders.sent?.path === "Sent", "the mailbox's sent folder was found");
  check((await inboxOf(ada, "Sent")).some((m) => m.messageId.includes(sent.messageId)), "a copy is kept in the mailbox's sent folder");
  await readMailboxes();
  check(
    (await db.select().from(rowEmail).where(and(eq(rowEmail.workspaceId, workspaceId), eq(rowEmail.messageId, sent.messageId)))).length === 1,
    "its copy in the sent folder isn't taken a second time",
  );
  // Mail the member sends from their own mail program shows on the row too.
  {
    const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: ada, pass: "x" }, logger: false });
    await client.connect();
    await client.append(
      "Sent",
      `From: Ada <${ada}>\r\nTo: ${customer}\r\nSubject: Delivery date\r\nMessage-ID: <own.${RUN}@leafdesk.test>\r\nDate: ${new Date().toUTCString()}\r\n\r\nWe deliver on Monday.\r\n`,
      ["\\Seen"],
    );
    await client.logout();
  }
  await readMailboxes();
  const own = (await db.select().from(rowEmail).where(eq(rowEmail.messageId, `own.${RUN}@leafdesk.test`)))[0];
  check(own?.rowId === acme.id && own.direction === "out" && own.sentBy === ids.member, "mail sent from the member's own mail program lands on the row as theirs", own);
  check((await told(ids.follower)).every((n) => n.rowEmail?.id !== own.id), "and tells no one: it was theirs");
  await settle();
  const delivered = (await inboxOf(customer)).find((m) => m.subject === "Re: Offer request");
  check(delivered && delivered.inReplyTo.includes(first) && delivered.headers.includes(first), "the customer gets it, answering their message", delivered);

  // An answer in the thread from someone else at the customer
  const answer = await deliver({ from: colleague, to: ada, subject: "Re: Re: Offer request", text: "Approved.", inReplyTo: `<${sent.messageId}>`, references: [`<${first}>`, `<${sent.messageId}>`] });
  await settle();
  await readMailboxes();
  const [threaded] = await db.select().from(rowEmail).where(and(eq(rowEmail.workspaceId, workspaceId), eq(rowEmail.messageId, answer)));
  check(threaded?.rowId === acme.id, "an answer in the thread lands on the row, even from an address no row has", threaded);

  // Hiding
  await hideRowEmail(ids.member, threaded.id);
  check(!(await listRowEmails(ids.owner, acme.id))!.emails.some((e) => e.id === threaded.id), "a hidden message leaves the row");
  check(!(await told(ids.follower)).some((n) => n.rowEmail?.id === threaded.id), "and the inbox");
  check(!(await hideRowEmail(ids.follower, received.id).then(() => true).catch(() => false)), "only its mailbox's owner, its sender or full access may hide one");

  // Leaving
  await removeMember(ids.owner, workspaceId, ids.member);
  check((await db.select().from(mailbox).where(eq(mailbox.id, box.id))).length === 0, "a member who leaves takes their mailbox with them");
  check((await listRowEmails(ids.owner, acme.id))!.emails.length >= 2, "the mail it brought stays on the row");

  console.log(`\n${passed} checks passed`);
} finally {
  outside.close();
  await db.delete(notification).where(eq(notification.workspaceId, workspaceId));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
