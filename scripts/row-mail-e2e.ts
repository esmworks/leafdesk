/**
 * End-to-end check of email on database rows against the database and a real IMAP/SMTP server
 * (GreenMail): a member's mailbox is tried before it is kept and refused without consent or while
 * the workspace has email off; mail whose other party is a row's address lands on that row, its
 * attachment kept as a file of the row, and tells the mailbox's owner and the row's followers
 * (not someone who may not see the address); mail with nobody in the databases is never fetched
 * whole; the first database in order where exactly one row matches wins; a reply written on the
 * row goes out from the member's mailbox in its thread, and an answer to it lands on the row by
 * its thread even from another address; the copy in the sent folder isn't taken twice; a sent
 * folder the server doesn't mark is found by its name, and a mailbox without one still connects
 * and says so; hiding a message takes it off the row and out of the inbox; a mailbox connected by
 * signing in with Google (a stand-in token endpoint, XOAUTH2 at the test server) is begun only with
 * consent, finished once and only by whoever began it, reads and sends with its access token,
 * renews it when it runs out and says so when the sign-in is taken back, and changes back to a
 * password; a member connects several mailboxes, one address each and at most MAX_MAILBOXES, picks
 * which a message on a row goes out from (their default otherwise, the one a message came through
 * for a reply), changes their default and gets the oldest one left as it when they disconnect it;
 * a member who leaves loses their mailboxes.
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
process.env.MAIL_GOOGLE_CLIENT_ID = "e2e-client";
process.env.MAIL_GOOGLE_CLIENT_SECRET = "e2e-secret";

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, count, eq, inArray } = await import("drizzle-orm");
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
const {
  beginGoogleMailbox,
  completeGoogleMailbox,
  connectMailbox,
  disconnectMailbox,
  getMailSettings,
  listOwnMailboxes,
  RowMailError,
  setDefaultMailbox,
  setMailDatabases,
} = await import("@/server/row-mail/settings");
const { MAX_MAILBOXES } = await import("@/lib/mail");
const { GOOGLE_MAIL, GOOGLE_MAIL_SCOPE } = await import("@/server/row-mail/google");
const { openJson, sealJson } = await import("@/server/secret-box");
const { createHash } = await import("node:crypto");
const { createServer } = await import("node:http");
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

// Google's token endpoint, stood in for: answers as `tokenAnswer` says and keeps the forms it was sent.
const tokenForms: URLSearchParams[] = [];
let tokenAnswer: (form: URLSearchParams) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
const tokenServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    tokenForms.push(form);
    const { status, body } = tokenAnswer(form);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
});
await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
GOOGLE_MAIL.tokenUrl = `http://127.0.0.1:${(tokenServer.address() as { port: number }).port}/token`;
// Gmail's servers are the test server here.
GOOGLE_MAIL.servers = { imapHost: HOST, imapPort: IMAP_PORT, imapSecure: false, smtpHost: HOST, smtpPort: SMTP_PORT, smtpSecure: false };
const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

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
  const out: { subject: string; from: string; messageId: string; inReplyTo: string; headers: string }[] = [];
  try {
    for await (const m of client.fetch("1:*", { envelope: true, headers: ["references", "in-reply-to"] })) {
      out.push({ subject: m.envelope?.subject ?? "", from: m.envelope?.from?.[0]?.address ?? "", messageId: m.envelope?.messageId ?? "", inReplyTo: m.envelope?.inReplyTo ?? "", headers: m.headers?.toString() ?? "" });
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
  check(!JSON.stringify(await listOwnMailboxes(ids.member)).includes("app-password"), "and never comes back out");
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
  check(
    memberView?.emails.length === 1 && memberView.canSend && memberView.senders.map((s) => s.address).join() === ada,
    "the row shows it, and its mailbox's owner may answer",
    memberView,
  );
  check(memberView.emails[0].ownMailboxId === box.id, "from the mailbox it came through");
  check(box.isDefault, "a member's first mailbox is their default");
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

  // Sent folders the server doesn't mark are found by their name
  const prepare = async (address: string, folder?: string) => {
    const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: address, pass: "x" }, logger: false });
    await client.connect();
    if (folder) await client.mailboxCreate(folder).catch(() => {});
    await client.logout();
  };
  const ece = `ece.${RUN}@leafdesk.test`;
  const can = `can.${RUN}@leafdesk.test`;
  await prepare(ece, "Gönderilenler");
  await prepare(can);
  const turkish = await connect(ids.hidden, ece);
  check(turkish.folders.inbox === "INBOX" && turkish.folders.sent === "Gönderilenler", "a sent folder the server doesn't mark is found by its name", turkish.folders);
  check(
    (await listOwnMailboxes(ids.hidden)).find((m) => m.workspaceId === workspaceId)?.mailboxes[0]?.folders.sent === "Gönderilenler",
    "and its owner sees which folders are read, under their account",
  );
  const noSent = await connect(ids.follower, can);
  check(noSent.status === "ok" && noSent.folders.inbox === "INBOX" && noSent.folders.sent === null, "a mailbox without a sent folder still connects, and says it has none", noSent);

  // Signing in with Google
  const gul = `gul.${RUN}@leafdesk.test`;
  check(await failsWith("consent", () => beginGoogleMailbox(ids.owner, workspaceId, { consent: false })), "a sign-in with Google begins only with consent");
  const begun = new URL((await beginGoogleMailbox(ids.owner, workspaceId, { consent: true, displayName: "Gül", timeZone: "Europe/Istanbul", address: gul })).url);
  const state = begun.searchParams.get("state")!;
  check(
    begun.searchParams.get("login_hint") === gul && begun.searchParams.get("scope")!.split(" ").includes(GOOGLE_MAIL_SCOPE) && begun.searchParams.has("code_challenge"),
    "it asks Google for mail, for the account typed, with PKCE",
    Object.fromEntries(begun.searchParams),
  );
  tokenAnswer = () => ({
    status: 200,
    body: { access_token: "g-access-1", refresh_token: "g-refresh-1", expires_in: 3599, scope: `openid ${GOOGLE_MAIL_SCOPE}`, id_token: idToken({ email: gul, email_verified: true }) },
  });
  check(await failsWith("googleFailed", () => completeGoogleMailbox(ids.follower, { state, code: "code-1" })), "it finishes only for whoever began it");
  const signedIn = await completeGoogleMailbox(ids.owner, { state, code: "code-1" });
  const exchange = tokenForms.at(-1)!;
  check(
    exchange.get("grant_type") === "authorization_code" &&
      createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url") === begun.searchParams.get("code_challenge"),
    "the code is traded with its PKCE verifier",
  );
  check(
    signedIn.workspaceId === workspaceId && signedIn.mailbox.auth === "google" && signedIn.mailbox.address === gul && signedIn.mailbox.status === "ok",
    "the mailbox is tried with the access token (XOAUTH2) and kept",
    signedIn,
  );
  check(signedIn.mailbox.displayName === "Gül" && signedIn.mailbox.timeZone === "Europe/Istanbul", "with the name and time zone given when it began");
  check(await failsWith("googleFailed", () => completeGoogleMailbox(ids.owner, { state, code: "code-1" })), "a sign-in finishes once");
  const googleBox = async () => (await db.select().from(mailbox).where(eq(mailbox.id, signedIn.mailbox.id)))[0];
  const googleKept = await googleBox();
  check(!googleKept.secret.includes("g-refresh-1") && openJson<{ refreshToken: string }>(googleKept.secret).refreshToken === "g-refresh-1", "its tokens are kept sealed");
  check(!JSON.stringify(await listOwnMailboxes(ids.owner)).includes("g-access-1"), "and never come back out");
  check((await listOwnMailboxes(ids.owner)).find((m) => m.workspaceId === workspaceId)?.google === true, "the account offers signing in with Google");

  // The access token runs out: reading renews it first.
  await db
    .update(mailbox)
    .set({ secret: sealJson({ ...openJson<object>(googleKept.secret), expiresAt: 0 }) })
    .where(eq(mailbox.id, googleKept.id));
  tokenAnswer = (form) => (form.get("grant_type") === "refresh_token" ? { status: 200, body: { access_token: "g-access-2", expires_in: 3599 } } : { status: 400, body: {} });
  const forGul = await deliver({ from: customer, to: gul, subject: "Through Google", text: "Hello Gül" });
  await settle();
  await readMailboxes();
  const renewed = await googleBox();
  check(tokenForms.at(-1)!.get("refresh_token") === "g-refresh-1", "a run-out access token is renewed with the refresh token");
  check(openJson<{ accessToken: string }>(renewed.secret).accessToken === "g-access-2" && renewed.status === "ok", "the new one is kept and the mailbox read", renewed.status);
  const throughGoogle = (await db.select().from(rowEmail).where(eq(rowEmail.workspaceId, workspaceId))).find((e) => e.messageId === forGul);
  check(throughGoogle?.rowId === acme.id && throughGoogle.mailboxId === googleKept.id, "mail to it lands on the row", throughGoogle);

  const fromGoogle = await queueRowEmail(ids.owner, acme.id, { to: [customer], subject: "Sent through Google", text: "Hi" });
  await sendDue();
  const sentThroughGoogle = (await db.select().from(rowEmail).where(eq(rowEmail.id, fromGoogle)))[0];
  check(sentThroughGoogle.status === "sent", "and mail written on the row goes out from it (XOAUTH2)", sentThroughGoogle);
  await settle();
  check((await inboxOf(customer)).some((m) => m.subject === "Sent through Google"), "the customer gets it");

  // Google takes the sign-in back.
  await db
    .update(mailbox)
    .set({ secret: sealJson({ ...openJson<object>(renewed.secret), expiresAt: 0 }) })
    .where(eq(mailbox.id, googleKept.id));
  tokenAnswer = () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
  await readMailboxes();
  const revoked = await googleBox();
  check(revoked.status === "error" && revoked.statusError === "signIn", "a sign-in Google took back says to sign in again", revoked.statusError);
  const failedId = await queueRowEmail(ids.owner, acme.id, { to: [customer], subject: "Not going out", text: "Hi" });
  await sendDue();
  const failed = (await db.select().from(rowEmail).where(eq(rowEmail.id, failedId)))[0];
  check(failed.status === "failed" && failed.error?.startsWith("signIn") && !failed.error.includes("g-refresh-1"), "mail to send from it fails at once, saying why", failed.error);

  check(await failsWith("invalid", () => connect(ids.owner, gul, { password: "" })), "changing it to a password asks for one");
  const backToPassword = await connect(ids.owner, gul);
  check(backToPassword.auth === "password" && backToPassword.folders.inbox === "INBOX", "it changes back to a password", backToPassword);
  check(
    (await googleBox()).folders.inbox?.lastUid === revoked.folders.inbox?.lastUid,
    "reading the same account carries on from where it stopped",
  );

  // Several mailboxes
  const sales = `sales.${RUN}@leafdesk.test`;
  await prepare(sales);
  const salesBox = await connect(ids.member, sales, { displayName: "Ada at Sales" });
  check(!salesBox.isDefault, "a member connects another mailbox, which isn't their default", salesBox);
  const adaOwn = async () => (await listOwnMailboxes(ids.member)).find((m) => m.workspaceId === workspaceId)!.mailboxes;
  check((await adaOwn()).map((m) => m.address).join() === `${ada},${sales}`, "their account lists both, the default first");
  const salesAgain = await connect(ids.member, sales, { displayName: "Sales" });
  check(salesAgain.id === salesBox.id && salesAgain.displayName === "Sales" && (await adaOwn()).length === 2, "connecting an address again changes its mailbox");
  check(await failsWith("alreadyConnected", () => connect(ids.member, ada, { mailboxId: salesBox.id })), "a mailbox can't take an address another of theirs has");
  check(await failsWith("gone", () => connect(ids.member, ada, { mailboxId: googleKept.id })), "nor can one change someone else's");
  const choices = await listRowEmails(ids.member, acme.id);
  check(choices?.senders.map((s) => s.id).join() === `${box.id},${salesBox.id}`, "the row offers both to write from, the default first", choices?.senders);
  const fromSales = await queueRowEmail(ids.member, acme.id, { to: [customer], subject: "From sales", text: "Hi", mailboxId: salesBox.id });
  const fromDefault = await queueRowEmail(ids.member, acme.id, { to: [customer], subject: "From the default", text: "Hi" });
  const [salesMail, defaultMail] = await Promise.all([fromSales, fromDefault].map(async (id) => (await db.select().from(rowEmail).where(eq(rowEmail.id, id)))[0]));
  check(salesMail.mailboxId === salesBox.id && salesMail.fromAddress === sales && salesMail.fromName === "Sales", "a message goes out from the mailbox picked", salesMail);
  check(defaultMail.mailboxId === box.id && defaultMail.fromAddress === ada, "and from the default when none is", defaultMail);
  check(
    await failsWith("noMailbox", () => queueRowEmail(ids.member, acme.id, { to: [customer], subject: "Hi", text: "Hi", mailboxId: googleKept.id })),
    "nobody writes from someone else's mailbox",
  );
  await sendDue();
  await settle();
  check((await inboxOf(customer)).some((m) => m.subject === "From sales" && m.from === sales), "the customer gets it from that address");
  check(await failsWith("noMailbox", () => setDefaultMailbox(ids.owner, salesBox.id)), "only its owner makes a mailbox their default");
  const switched = await setDefaultMailbox(ids.member, salesBox.id);
  check(switched.map((m) => `${m.address}:${m.isDefault}`).join() === `${sales}:true,${ada}:false`, "a member picks another default, and has only one", switched);
  const [{ n: defaults }] = await db
    .select({ n: count() })
    .from(mailbox)
    .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, ids.member), eq(mailbox.isDefault, true)));
  check(defaults === 1, "the database keeps one default");
  const extra: string[] = [];
  for (let i = (await adaOwn()).length; i < MAX_MAILBOXES; i++) {
    const address = `extra${i}.${RUN}@leafdesk.test`;
    await prepare(address);
    extra.push((await connect(ids.member, address)).id);
  }
  const tooMany = `toomany.${RUN}@leafdesk.test`;
  await prepare(tooMany);
  check(await failsWith("tooMany", () => connect(ids.member, tooMany)), `a member connects at most ${MAX_MAILBOXES} mailboxes in a workspace`);
  check(
    (await getMailSettings(ids.owner, workspaceId)).members.filter((m) => m.userId === ids.member).length === MAX_MAILBOXES,
    "owners see each of a member's mailboxes",
  );
  for (const id of extra) await disconnectMailbox(ids.member, id);
  const left = await disconnectMailbox(ids.member, salesBox.id);
  check(left.length === 1 && left[0].id === box.id && left[0].isDefault, "disconnecting the default makes the oldest one left the default", left);

  // Leaving
  await connect(ids.member, sales);
  await removeMember(ids.owner, workspaceId, ids.member);
  check(
    (await db.select().from(mailbox).where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, ids.member)))).length === 0,
    "a member who leaves takes their mailboxes with them",
  );
  check((await listRowEmails(ids.owner, acme.id))!.emails.length >= 2, "the mail it brought stays on the row");

  console.log(`\n${passed} checks passed`);
} finally {
  outside.close();
  tokenServer.close();
  await db.delete(notification).where(eq(notification.workspaceId, workspaceId));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
