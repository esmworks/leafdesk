/**
 * End-to-end check of the Mail tab against the database and a real IMAP/SMTP server (GreenMail,
 * started here in a container of its own on free ports and removed at the end): opening a mailbox
 * reads its folders, with what each is for, and the newest of the inbox, and listing mailboxes
 * reads the others not read yet in the background; threads join answers,
 * copies in the sent folder and replies without references by subject; a thread names the row its
 * other party is; a message's body comes from the server, its HTML without scripts and remote
 * images until asked for (remembered then, or always for a trusted sender or the mailbox's own
 * domain), with the images it carries inline, and it is marked read (not when loaded ahead); a file downloads as it was sent; archiving, moving to a folder picked, starring, reading, the trash and
 * deleting for good and emptying the trash reach the server and the index at once; an answer goes out in the same thread and lands in the sent
 * folder; a draft is kept in the drafts folder (made where there is none), each save replacing the last under one
 * Message-ID with the files it kept, opens again with its Bcc and signature, marks the thread it answers, and goes
 * once sent or thrown away; a message sent waits for Undo, which makes it a draft again, and goes when its seconds are up; a new message goes out from the mailbox picked, its formatting cleaned and a plain-text part beside it;
 * recipient fields suggest the people written with; an answer's HTML shows without the earlier mail it quotes, which comes apart, and one written here carries the original's HTML, text and images under it, kept from draft to draft and left out when taken off; a forward carries the original under its header with its files;
 * pictures put in the text go as parts of the message, kept by a draft and carried over without being sent again; the minute's sweep reads new mail, flags changed elsewhere and messages deleted
 * elsewhere; search finds by sender and subject; no one but the mailbox's owner reads it.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/mail-client-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). With GREENMAIL_SMTP_PORT and GREENMAIL_IMAP_PORT
 * (on 127.0.0.1) it uses that server; without, it needs Docker and starts greenmail/standalone:2.1.14
 * itself. Migrations must be applied. Run it while no app server uses the same database: the
 * server's own sweeps would read the mailboxes.
 */
export {};

import { execFileSync } from "node:child_process";
import net from "node:net";

try {
  process.loadEnvFile();
} catch {}

const HOST = "127.0.0.1";
const CONTAINER = "leafdesk-greenmail-mail-client";
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

const { and, eq, inArray } = await import("drizzle-orm");
const nodemailer = (await import("nodemailer")).default;
const { ImapFlow } = await import("imapflow");
const { db } = await import("@/db");
const { mailbox, mailFolder, mailMessage, user, workspace, workspaceMember } = await import("@/db/schema");
const { addProperty } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { connectMailbox, setMailDatabases, RowMailError } = await import("@/server/row-mail/settings");
const { syncDue } = await import("@/server/row-mail/sync");
const read = await import("@/server/mail-client/read");
const { emptyFolder, holdMail, mailAction, sendHeld, sendMail, sendStatus, undoSend } = await import("@/server/mail-client/write");
const drafts = await import("@/server/mail-client/drafts");
const { suggestAddresses } = await import("@/server/mail-client/contacts");
const { closeImap } = await import("@/server/mail-client/pool");
const { stopWatching, watchMailbox } = await import("@/server/mail-client/watch");
const images = await import("@/server/mail-client/images");
const { unsubscribe } = await import("@/server/mail-client/unsubscribe");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");

const RUN = `mailclient-e2e-${Date.now().toString(36)}`;
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
    return error instanceof RowMailError ? error.code : (error as Error)?.constructor?.name;
  }
}

const ids = { ada: `${RUN}-ada`, bob: `${RUN}-bob` };
const workspaceId = `${RUN}-ws`;
const ada = `ada.${RUN}@leafdesk.test`;
const customer = `ayse.${RUN}@acme.test`;
const sales = `satis.${RUN}@leafdesk.test`;
const stranger = `news.${RUN}@lists.test`;
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

async function uidsIn(path: string, query: Record<string, unknown> = { all: true }) {
  return asAda(async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      return ((await client.search(query, { uid: true })) || []).sort((a, b) => a - b);
    } finally {
      lock.release();
    }
  });
}

/** The newest message in someone's inbox on the server, as it arrived. */
async function lastMessageTo(address: string) {
  const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: address, pass: "x" }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    let raw = "";
    try {
      for await (const m of client.fetch("1:*", { source: true })) raw = m.source?.toString() ?? raw;
    } finally {
      lock.release();
    }
    return raw;
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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n% leafdesk e2e\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

let containerUp = !given;
let boxId = "";
let salesBoxId = "";
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
  const acme = await createPage({ userId: ids.ada }, { workspaceId, parentId: customers.id, title: "Acme", properties: { [emailProperty.id]: customer } });
  await setMailDatabases(ids.ada, workspaceId, [{ databaseId: customers.id, propertyIds: [emailProperty.id] }]);

  // Ada's mailbox before Leafdesk sees it: folders and mail.
  await asAda(async (client) => {
    for (const name of ["Sent", "Trash", "Archive", "Junk", "Projeler"]) await client.mailboxCreate(name);
  });
  const base = { from: `Ayşe Kaya <${customer}>`, to: ada };
  await outside.sendMail({ ...base, subject: "Teklif", text: "Merhaba Ada,\nteklifinizi bekliyoruz.", messageId: `<teklif.${RUN}@acme.test>` });
  await outside.sendMail({ ...base, subject: "Re: Teklif", text: "Bir de fiyat listesi rica ederiz.\n\n> Merhaba Ada", messageId: `<teklif2.${RUN}@acme.test>`, inReplyTo: `<teklif.${RUN}@acme.test>`, references: `<teklif.${RUN}@acme.test>` });
  await outside.sendMail({
    from: `Bülten <${stranger}>`,
    to: ada,
    subject: "Ekim bülteni",
    text: "Bülten metni",
    html: `<p>Bülten</p><img src="https://tracker.example/pixel.gif"><img src="cid:logo@bulten"><script>alert(1)</script><a href="https://example.com/x" onclick="steal()">oku</a><form action="https://evil.example"><input name="p"></form>`,
    attachments: [
      { filename: "logo.png", content: PNG, cid: "logo@bulten", contentType: "image/png" },
      { filename: "fiyat.pdf", content: PDF, contentType: "application/pdf" },
    ],
    headers: { "List-Unsubscribe": "<https://lists.test/unsub?u=1>, <mailto:unsub@lists.test>" },
    messageId: `<bulten.${RUN}@lists.test>`,
  });
  await outside.sendMail({ ...base, subject: "Bütçe", text: "2027 bütçesi ektedir.", messageId: `<butce.${RUN}@acme.test>`, date: new Date(Date.now() - 3_600_000) });
  await outside.sendMail({ ...base, subject: "Ynt: Bütçe", text: "Bir güncelleme.", messageId: `<butce2.${RUN}@acme.test>` });
  await settle();
  // Ada answered the first message from her phone: the copy is in her sent folder.
  await asAda((client) =>
    client.append(
      "Sent",
      Buffer.from(
        `From: Ada <${ada}>\r\nTo: ${customer}\r\nSubject: Re: Teklif\r\nMessage-ID: <cevap.${RUN}@leafdesk.test>\r\nIn-Reply-To: <teklif.${RUN}@acme.test>\r\nReferences: <teklif.${RUN}@acme.test>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nTeklif yarın gelir.\r\n`,
      ),
      ["\\Seen"],
    ),
  );

  const box = await connectMailbox(ids.ada, workspaceId, { address: ada, servers, username: ada, password: "x", consent: true, displayName: "Ada", timeZone: "Europe/Istanbul" });
  boxId = box.id;
  // A second mailbox of Ada's, a shared address with a question waiting in it.
  await outside.sendMail({ from: customer, to: sales, subject: "Fiyat sorusu", text: "Fiyat listesi var mı?" });
  const salesBox = await connectMailbox(ids.ada, workspaceId, { address: sales, servers, username: sales, password: "x", consent: true, displayName: "Satış", timeZone: "Europe/Istanbul" });
  salesBoxId = salesBox.id;

  // Opening
  const boxesListed = await read.listMailboxes(ids.ada, workspaceId);
  check(boxesListed.length === 2 && boxesListed[0].id === boxId && boxesListed.every((b) => b.folders === null), "mailboxes have no index before their owner opens Mail, the default first");
  const opened = await read.openMailbox(ids.ada, boxId);
  const roles = Object.fromEntries((opened.folders ?? []).map((f) => [f.name, f.role]));
  check(roles.INBOX === "inbox" && roles.Sent === "sent" && roles.Trash === "trash" && roles.Archive === "archive" && roles.Junk === "junk" && roles.Projeler === null, "opening reads the folders and what each is for", roles);
  check(opened.folders?.[0]?.role === "inbox", "the inbox comes first");
  const folder = (role: string) => opened.folders!.find((f) => f.role === role)!;
  // Listing them began reading the other one in the background, so its unread mail shows.
  let salesListed: (typeof boxesListed)[number] | undefined;
  for (let i = 0; i < 40 && !salesListed?.folders; i++) {
    await settle();
    salesListed = (await read.listMailboxes(ids.ada, workspaceId)).find((b) => b.id === salesBoxId);
  }
  check(salesListed?.folders?.find((f) => f.role === "inbox")?.unseen === 1, "listing the mailboxes reads the others in the background", salesListed);
  const inbox = folder("inbox");
  // The sweep reads the other folders (the sent copy) too.
  await sweep();

  // Threads
  const first = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id });
  const bySubject = (subject: string) => first.items.find((t) => t.subject === subject);
  check(first.items.length === 3, "the inbox lists three threads", first.items.map((t) => [t.subject, t.count]));
  const teklif = bySubject("Re: Teklif");
  check(teklif?.count === 3, "an answer, its question and the copy in the sent folder are one thread", teklif);
  check(bySubject("Ynt: Bütçe")?.count === 2, "a reply without references joins the thread of its subject");
  check(teklif?.row?.rowId === acme.id, "a thread names the row of its other party", teklif?.row);
  check(bySubject("Ekim bülteni")?.row === null && bySubject("Ekim bülteni")?.hasAttachments, "mail from no row's address names none, and shows it has files");
  check(first.items.every((t) => t.unread), "new mail is unread");

  // All inboxes as one
  const salesInbox = salesListed!.folders!.find((f) => f.role === "inbox")!;
  const all = await read.listThreads(ids.ada, { mailboxId: "all", folderId: "", workspaceId });
  check(
    all.items.length === 4 &&
      all.items.every((t, i) => i === 0 || all.items[i - 1].sentAt >= t.sentAt) &&
      all.items.filter((t) => t.mailboxId === salesBoxId && t.folderId === salesInbox.id).map((t) => t.subject).join() === "Fiyat sorusu" &&
      all.items.filter((t) => t.mailboxId === boxId).every((t) => t.folderId === inbox.id),
    "all inboxes list as one, newest first, each thread with its mailbox and inbox",
    all.items.map((t) => [t.subject, t.mailboxId === salesBoxId]),
  );
  check(first.items.every((t) => t.mailboxId === boxId && t.folderId === inbox.id), "a folder's threads name it too");
  const allFound = await read.listThreads(ids.ada, { mailboxId: "all", folderId: "", workspaceId, search: "fiyat" });
  check(
    allFound.items.map((t) => `${t.subject}@${t.mailboxId === salesBoxId ? "sales" : "ada"}`).sort().join() === "Fiyat sorusu@sales,Re: Teklif@ada",
    "searching all inboxes searches every mailbox",
    allFound.items.map((t) => t.subject),
  );
  check(!(await read.listThreads(ids.bob, { mailboxId: "all", folderId: "", workspaceId })).items.length, "another member's all inboxes hold none of Ada's mail");
  const fiyat = all.items.find((t) => t.mailboxId === salesBoxId)!;
  await mailAction(ids.ada, { mailboxId: fiyat.mailboxId, folderId: fiyat.folderId, threadIds: [fiyat.threadId], action: "star" });
  const [fiyatRow] = await db.select().from(mailMessage).where(eq(mailMessage.id, fiyat.messageId));
  check(fiyatRow.flagged && fiyatRow.mailboxId === salesBoxId, "a thread of all inboxes is starred in its own mailbox");
  await mailAction(ids.ada, { mailboxId: fiyat.mailboxId, folderId: fiyat.folderId, threadIds: [fiyat.threadId], action: "unstar" });

  const thread = await read.getThread(ids.ada, { mailboxId: boxId, threadId: teklif!.threadId, folderId: inbox.id });
  check(
    thread.messages.map((m) => m.subject).join("|") === "Teklif|Re: Teklif|Re: Teklif" && thread.messages[2].folderRole === "sent",
    "a thread's messages come oldest first, from every folder",
    thread.messages.map((m) => [m.subject, m.folderRole]),
  );

  // Bodies
  const bulten = bySubject("Ekim bülteni")!;
  await read.prefetchBodies(ids.ada, { ids: [bulten.messageId] });
  const [ahead] = await db.select().from(mailMessage).where(eq(mailMessage.id, bulten.messageId));
  check(!ahead.seen && !(await uidsIn("INBOX", { seen: true })).includes(ahead.uid), "loading a message ahead leaves it unread, in the index and on the server");
  const body = await read.readBody(ids.ada, { id: bulten.messageId });
  check(body.html && !/<script|onclick|<form|<input/i.test(body.html), "the HTML comes without scripts, handlers or forms", body.html);
  check(body.blockedImages === 1 && !body.html!.includes("tracker.example"), "a remote image is left out until asked for", body);
  check(body.html!.includes("data:image/png;base64,"), "an image the message carries is shown inline");
  check(/target="_blank"/.test(body.html!) && /rel="noopener noreferrer"/.test(body.html!), "links open in a new tab");
  check(body.attachments.length === 1 && body.attachments[0].name === "fiyat.pdf", "the files list leaves out the image already shown", body.attachments);
  check(body.unsubscribe?.how === "mail" && body.unsubscribe.address === "unsub@lists.test" && body.text.includes("Bülten metni"), "the text and the list's way out come along: a mail before a web page", body);
  const withImages = await read.readBody(ids.ada, { id: bulten.messageId, images: true });
  check(withImages.html!.includes("https://tracker.example/pixel.gif") && withImages.blockedImages === 0, "asked for, remote images stay in");
  check(withImages.images === "asked" && body.images === null, "the body says why its images load", [withImages.images, body.images]);
  const again = await read.readBody(ids.ada, { id: bulten.messageId });
  check(again.images === "asked" && again.html!.includes("tracker.example"), "images asked for load again the next time the message opens", again.images);
  await db.update(mailMessage).set({ imagesShown: false }).where(eq(mailMessage.id, bulten.messageId));
  check((await errorCode(() => images.trustImageSender(ids.bob, { mailboxId: boxId, address: stranger }))) === "noMailbox", "another member can't trust senders for the mailbox");
  await images.trustImageSender(ids.ada, { mailboxId: boxId, address: stranger.toUpperCase() });
  const trusted = await read.readBody(ids.ada, { id: bulten.messageId });
  check(trusted.images === "sender" && trusted.html!.includes("tracker.example"), "a trusted sender's images load without asking", trusted.images);
  const listed = await images.listImageSenders(ids.ada);
  check(listed.length === 1 && listed[0].address === stranger && listed[0].mailbox === ada && !(await images.listImageSenders(ids.bob)).length, "Settings lists the sender for the mailbox's owner alone", listed);
  await images.forgetImageSender(ids.ada, { mailboxId: boxId, address: stranger });
  const forgotten = await read.readBody(ids.ada, { id: bulten.messageId });
  check(forgotten.images === null && forgotten.blockedImages === 1, "taken off the list, its images wait to be asked for again", forgotten.images);
  const own = await read.readBody(ids.ada, { id: thread.messages[2].id });
  check(own.images === "domain", "mail from the mailbox's own domain shows its images", own.images);
  const [bultenRow] = await db.select().from(mailMessage).where(eq(mailMessage.id, bulten.messageId));
  check(bultenRow.seen && (await uidsIn("INBOX", { seen: true })).includes(bultenRow.uid), "opening a message marks it read in the index and on the server");
  const file = await read.readAttachment(ids.ada, { id: bulten.messageId, part: body.attachments[0].part });
  check(file.data.equals(PDF) && file.contentType === "application/pdf", "a file downloads as it was sent");
  check((await errorCode(() => read.readAttachment(ids.ada, { id: bulten.messageId, part: "9" }))) === "gone", "a part the message doesn't have isn't served");
  const source = await read.readSource(ids.ada, { id: bulten.messageId });
  const sourceText = source.data.toString("utf8");
  check(source.subject === bulten.subject && /^List-Unsubscribe: /im.test(sourceText) && /^Content-Type: application\/pdf/im.test(sourceText), "the original comes whole, headers and files", sourceText.slice(0, 300));

  // Who reads it
  check((await errorCode(() => read.listThreads(ids.bob, { mailboxId: boxId, folderId: inbox.id }))) === "noMailbox", "another member can't list it");
  check((await errorCode(() => read.readBody(ids.bob, { id: bulten.messageId }))) === "noMailbox", "nor read its messages, held in memory or not");
  check((await errorCode(() => read.readSource(ids.bob, { id: bulten.messageId }))) === "noMailbox", "nor their originals");
  check((await errorCode(() => mailAction(ids.bob, { mailboxId: boxId, folderId: inbox.id, threadIds: [bulten.threadId], action: "trash" }))) === "noMailbox", "nor change them");

  // Actions
  await mailAction(ids.ada, { mailboxId: boxId, folderId: inbox.id, threadIds: [teklif!.threadId], action: "star" });
  check((await uidsIn("INBOX", { flagged: true })).length === 1, "starring flags the thread's newest message on the server");
  await mailAction(ids.ada, { mailboxId: boxId, folderId: inbox.id, threadIds: [teklif!.threadId], action: "read" });
  const readNow = await db.select({ seen: mailMessage.seen }).from(mailMessage).where(eq(mailMessage.threadId, teklif!.threadId));
  check(readNow.every((m) => m.seen), "marking read reads every message of the thread");
  await mailAction(ids.ada, { mailboxId: boxId, folderId: inbox.id, threadIds: [teklif!.threadId], action: "archive" });
  const archived = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: folder("archive").id });
  check(archived.items[0]?.threadId === teklif!.threadId && archived.items[0].starred, "archiving moves the thread's inbox messages to the archive, flags and all", archived.items);
  check((await uidsIn("Archive")).length === 2 && (await uidsIn("INBOX")).length === 3, "on the server too");
  const projeler = opened.folders!.find((f) => f.name === "Projeler")!;
  await mailAction(ids.ada, { mailboxId: boxId, folderId: folder("archive").id, threadIds: [teklif!.threadId], action: "move", to: projeler.id });
  const inProjeler = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: projeler.id });
  check(inProjeler.items[0]?.threadId === teklif!.threadId && (await uidsIn("Projeler")).length === 2 && (await uidsIn("Archive")).length === 0, "a thread moves to a folder picked by name", inProjeler.items);
  check(
    (await errorCode(() => mailAction(ids.ada, { mailboxId: boxId, folderId: projeler.id, threadIds: [teklif!.threadId], action: "move", to: folder("sent").id }))) === "invalid" &&
      (await errorCode(() => mailAction(ids.ada, { mailboxId: boxId, folderId: projeler.id, threadIds: [teklif!.threadId], action: "move" }))) === "invalid",
    "but not to the sent folder, nor without one",
  );
  const selected = (await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id })).items.map((i) => i.threadId);
  await mailAction(ids.ada, { mailboxId: boxId, folderId: inbox.id, threadIds: selected, action: "star" });
  const starredBoth = (await uidsIn("INBOX", { flagged: true })).length;
  await mailAction(ids.ada, { mailboxId: boxId, folderId: inbox.id, threadIds: selected, action: "unstar" });
  check(selected.length === 2 && starredBoth === 2 && !(await uidsIn("INBOX", { flagged: true })).length, "one action changes every selected thread", [selected, starredBoth]);
  await mailAction(ids.ada, { mailboxId: boxId, folderId: inbox.id, threadIds: [bulten.threadId], action: "trash" });
  const trash = folder("trash");
  const trashed = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: trash.id });
  check(trashed.items.length === 1 && (await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id })).items.length === 1, "the trash takes the thread out of the inbox");
  check((await errorCode(() => mailAction(ids.ada, { mailboxId: boxId, folderId: inbox.id, threadIds: [bySubject("Ynt: Bütçe")!.threadId], action: "delete" }))) === "invalid", "deleting for good is only from the trash");
  await mailAction(ids.ada, { mailboxId: boxId, folderId: trash.id, threadIds: [bulten.threadId], action: "delete" });
  check((await uidsIn("Trash")).length === 0 && !(await read.listThreads(ids.ada, { mailboxId: boxId, folderId: trash.id })).items.length, "and deletes it there");
  // Emptying the trash: one message the index has read, one it hasn't yet.
  const thrownAway = (n: number) =>
    asAda((client) =>
      client.append("Trash", Buffer.from(`From: ${customer}\r\nTo: ${ada}\r\nSubject: Eski ${n}\r\nMessage-ID: <eski${n}.${RUN}@acme.test>\r\nDate: ${new Date().toUTCString()}\r\n\r\nEski.\r\n`)),
    );
  await thrownAway(1);
  await read.refreshFolder(ids.ada, boxId, trash.id);
  await thrownAway(2);
  check((await read.listThreads(ids.ada, { mailboxId: boxId, folderId: trash.id })).items.length === 1 && (await uidsIn("Trash")).length === 2, "the trash holds a message listed and one not yet read");
  check(
    (await errorCode(() => emptyFolder(ids.bob, { mailboxId: boxId, folderId: trash.id }))) === "noMailbox" && (await errorCode(() => emptyFolder(ids.ada, { mailboxId: boxId, folderId: inbox.id }))) === "invalid",
    "only the owner empties it, and only the trash or junk",
  );
  await emptyFolder(ids.ada, { mailboxId: boxId, folderId: trash.id });
  const [trashAfter] = await db.select().from(mailFolder).where(eq(mailFolder.id, trash.id));
  check((await uidsIn("Trash")).length === 0 && !(await read.listThreads(ids.ada, { mailboxId: boxId, folderId: trash.id })).items.length && trashAfter.total === 0, "emptying the trash deletes all of it, on the server and in the index", { server: await uidsIn("Trash"), total: trashAfter.total });
  await emptyFolder(ids.ada, { mailboxId: boxId, folderId: trash.id });
  check((await uidsIn("INBOX")).length > 0, "an empty trash empties again without trouble, and the inbox is left alone");

  // Answering
  const butce = (await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id })).items[0];
  const pdf = new File([PDF], "teklif.pdf", { type: "application/pdf" });
  await sendMail(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [`gizli.${RUN}@leafdesk.test`], subject: "Re: Bütçe", text: "Aldık, teşekkürler.", replyTo: butce.messageId }, [pdf]);
  await settle();
  const delivered = await lastMessageTo(customer);
  check(delivered.includes(`In-Reply-To: <butce2.${RUN}@acme.test>`) && delivered.includes("teklif.pdf") && !/^bcc:/im.test(delivered), "an answer goes out in the thread, with its file, without the Bcc line");
  check((await uidsIn("INBOX", { answered: true })).length === 1, "the message answered is marked so");
  await sweep();
  const sentList = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: folder("sent").id });
  const answer = sentList.items.find((t) => t.threadId === butce.threadId);
  check(answer && answer.count === 3, "the sent folder keeps a copy, read into the same thread", sentList.items);

  // Drafts
  const hidden = `gizli.${RUN}@leafdesk.test`;
  const note = new File([PDF], "not.pdf", { type: "application/pdf" });
  const firstSave = await drafts.saveDraft(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [hidden], subject: "Taslak konu", html: `<p>İlk hali</p><div data-signature=""><p>Ada</p></div>` }, [note]);
  const [draftFolder] = await db
    .select()
    .from(mailFolder)
    .where(and(eq(mailFolder.mailboxId, boxId), eq(mailFolder.role, "drafts")));
  check(draftFolder?.path === "Drafts", "a mailbox without a drafts folder gets one for drafts", draftFolder);
  check((await uidsIn("Drafts")).length === 1 && !!firstSave.id && firstSave.attachments.length === 1, "a draft is kept in the drafts folder with its file, and in the index", firstSave);
  const secondSave = await drafts.saveDraft(ids.ada, {
    mailboxId: boxId,
    to: [customer],
    cc: [],
    bcc: [hidden],
    subject: "Taslak konu",
    html: `<p>İkinci hali</p><div data-signature=""><p>Ada</p></div>`,
    draft: { id: firstSave.id, messageId: firstSave.messageId, keep: firstSave.attachments.map((a) => a.part) },
  });
  const draftRows = await db.select().from(mailMessage).where(eq(mailMessage.folderId, draftFolder.id));
  check((await uidsIn("Drafts")).length === 1 && draftRows.length === 1 && draftRows[0].id === secondSave.id && draftRows[0].draft, "saving again replaces the draft, on the server and in the index", draftRows);
  check(secondSave.messageId === firstSave.messageId && secondSave.attachments[0]?.name === "not.pdf", "under the same Message-ID, keeping the file read back from the server", secondSave);
  const reopened = await drafts.openDraft(ids.ada, secondSave.id!);
  check(
    reopened.bcc[0]?.address === hidden && reopened.to[0]?.address === customer && reopened.subject === "Taslak konu" && reopened.html.includes("İkinci hali") && reopened.html.includes("data-signature") && !reopened.html.includes("style="),
    "a draft opens again with its Bcc, its words and its signature, as the editor writes them",
    reopened,
  );
  check(reopened.attachments.length === 1 && reopened.replyTo === null, "and its file", reopened.attachments);
  check((await errorCode(() => drafts.openDraft(ids.bob, secondSave.id!))) === "noMailbox", "only to its owner");
  check((await errorCode(() => drafts.openDraft(ids.ada, butce.messageId))) === "invalid", "a message that isn't a draft doesn't open as one");
  const replyDraft = await drafts.saveDraft(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "Re: Bütçe", html: "<p>Cevap taslağı</p>", replyTo: butce.messageId });
  const withDraft = (await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id })).items.find((t) => t.threadId === butce.threadId);
  check(withDraft?.hasDraft, "a thread answered in a draft says so in the inbox", withDraft);
  check((await drafts.openDraft(ids.ada, replyDraft.id!)).replyTo === butce.messageId, "a reply's draft knows the message it answers");
  await sendMail(ids.ada, {
    mailboxId: boxId,
    to: [customer],
    cc: [],
    bcc: [],
    subject: "Taslak konu",
    html: `<p>Son hali</p><div data-signature=""><p>Ada</p></div>`,
    draft: { id: secondSave.id, messageId: secondSave.messageId, keep: secondSave.attachments.map((a) => a.part) },
  });
  await settle();
  const fromDraft = await lastMessageTo(customer);
  check(fromDraft.includes("Son hali") && fromDraft.includes("not.pdf") && !fromDraft.includes("data-signature"), "a draft sent goes with the file it kept, its signature unmarked", [fromDraft.includes("Son hali"), fromDraft.includes("not.pdf"), fromDraft.includes("data-signature")]);
  const draftsLeft = await db.select().from(mailMessage).where(eq(mailMessage.folderId, draftFolder.id));
  check((await uidsIn("Drafts")).length === 1 && draftsLeft.length === 1 && draftsLeft[0].id === replyDraft.id, "and leaves the drafts folder once sent", draftsLeft);
  await drafts.discardDraft(ids.ada, { id: replyDraft.id, messageId: replyDraft.messageId, keep: [] });
  check((await uidsIn("Drafts")).length === 0 && !(await db.select().from(mailMessage).where(eq(mailMessage.folderId, draftFolder.id))).length, "a draft thrown away goes from the server and the index");
  check(!(await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id })).items.find((t) => t.threadId === butce.threadId)?.hasDraft, "and its thread says no more that it has one");

  // Undoing a send
  const toUndo = await drafts.saveDraft(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "Geri alınacak", html: "<p>Ilk yazilan</p>" });
  const hold = await holdMail(ids.ada, {
    mailboxId: boxId,
    to: [customer],
    cc: [],
    bcc: [],
    subject: "Geri alınacak",
    html: "<p>Bekleyen son hali</p>",
    draft: { id: toUndo.id, messageId: toUndo.messageId, keep: [] },
  });
  check(sendStatus(ids.ada, hold.sendId).state === "held" && sendStatus(ids.bob, hold.sendId).state === "gone", "a message sent waits for Undo, known to its sender alone");
  check((await errorCode(() => undoSend(ids.bob, hold.sendId))) === "gone", "only its sender takes it back");
  const undone = await undoSend(ids.ada, hold.sendId);
  const back = undone?.id ? await drafts.openDraft(ids.ada, undone.id) : null;
  check(!!back?.html.includes("Bekleyen son hali") && back.messageId === toUndo.messageId && (await uidsIn("Drafts")).length === 1, "taken back, it is a draft again as it was sent, in place of its draft", back);
  await sendHeld(hold.sendId);
  await settle();
  check(sendStatus(ids.ada, hold.sendId).state === "undone" && !(await lastMessageTo(customer)).includes("Bekleyen son hali"), "and doesn't go when its seconds are up");
  const goes = await holdMail(ids.ada, {
    mailboxId: boxId,
    to: [customer],
    cc: [],
    bcc: [],
    subject: "Geri alınacak",
    html: "<p>Simdi gidiyor</p>",
    draft: { id: undone!.id, messageId: back!.messageId, keep: [] },
  });
  await sendHeld(goes.sendId);
  await settle();
  check(sendStatus(ids.ada, goes.sendId).state === "sent" && (await lastMessageTo(customer)).includes("Simdi gidiyor") && (await uidsIn("Drafts")).length === 0, "a message not taken back goes, and its draft with it");
  check((await undoSend(ids.ada, goes.sendId)) === null, "and can't be taken back once gone");

  // Writing with formatting, from the other mailbox
  await sendMail(ids.ada, {
    mailboxId: salesBoxId,
    to: [customer],
    cc: [],
    bcc: [],
    subject: "Fiyat listesi",
    html: `<p>Merhaba <strong>Ayse</strong>,</p><ul><li><p>liste ekte</p></li></ul><p><a href="javascript:x()">tikla</a></p><script>x()</script>`,
  });
  await settle();
  const formatted = await lastMessageTo(customer);
  check(new RegExp(`^From: .*<${sales.replace(/\./g, "\\.")}>`, "m").test(formatted.replace(/\r\n[ \t]+/g, " ")), "a new message goes out from the mailbox picked", formatted.slice(0, 400));
  check(/multipart\/alternative/i.test(formatted) && formatted.includes("<strong>Ayse</strong>") && formatted.includes("- liste ekte"), "with its formatting and a plain-text part written from it");
  check(!/<script|javascript:/i.test(formatted), "and nothing the editor doesn't write");
  check((await errorCode(() => sendMail(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "", html: "<p></p>" }))) === "invalid", "a message with no subject and nothing written isn't sent");

  // Suggesting addresses
  const suggested = await suggestAddresses(ids.ada, { mailboxId: boxId, query: "ayse" });
  check(suggested[0]?.address === customer, "a recipient field suggests the people written with", suggested);
  check((await suggestAddresses(ids.ada, { mailboxId: boxId, query: "kaya" }))[0]?.address === customer, "by a word of their name too");
  check(!(await suggestAddresses(ids.ada, { mailboxId: boxId, query: "ada." })).some((a) => a.address === ada), "never the mailbox itself");
  check((await errorCode(() => suggestAddresses(ids.bob, { mailboxId: boxId, query: "ayse" }))) !== null, "and only to the mailbox's owner");

  // The sweep
  await outside.sendMail({ ...base, subject: "Yeni sipariş", text: "Sipariş formu." });
  await asAda(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = ((await client.search({ subject: "Bütçe" }, { uid: true })) || []).sort((a, b) => a - b);
      await client.messageFlagsAdd(String(uids[0]), ["\\Flagged"], { uid: true });
      await client.messageDelete(String(uids[1]), { uid: true });
    } finally {
      lock.release();
    }
  });
  await sweep();
  const after = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id });
  check(after.items.some((t) => t.subject === "Yeni sipariş" && t.unread), "the sweep reads new mail", after.items.map((t) => t.subject));

  // An answer quoting the mail before it
  await outside.sendMail({
    ...base,
    subject: "Re: Yeni sipariş",
    text: "Onaylıyoruz.\n\n> Sipariş formu | adet",
    html: `<div>Onaylıyoruz.</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Ada wrote:</div><blockquote class="gmail_quote"><table><tr><td>Sipariş formu</td></tr></table></blockquote></div>`,
  });
  await sweep();
  const quoting = (await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id })).items.find((t) => t.subject === "Re: Yeni sipariş");
  const answerBody = quoting ? await read.readBody(ids.ada, { id: quoting.messageId }) : null;
  check(!!answerBody?.html?.includes("Onaylıyoruz.") && !answerBody.html.includes("Sipariş formu") && !!answerBody.quotedHtml?.includes("<table>"), "an answer's HTML comes without the mail it quotes, which comes apart", answerBody?.quotedHtml);

  // Answering with the mail before it quoted under what is written
  const quotedDraft = await drafts.saveDraft(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "Re: Yeni sipariş", html: "<p>Tesekkurler</p>", replyTo: quoting!.messageId, quote: { header: ["Ayse yazdi:"] } });
  const openedQuote = await drafts.openDraft(ids.ada, quotedDraft.id!);
  check(openedQuote.html.includes("Tesekkurler") && !openedQuote.html.includes("Onaylıyoruz") && !!openedQuote.quote?.includes("Onaylıyoruz.") && openedQuote.quote.includes("Ayse yazdi:"), "a draft keeps the quote under what is written, and opens with it apart", openedQuote);
  const resaved = await drafts.saveDraft(ids.ada, {
    mailboxId: boxId,
    to: [customer],
    cc: [],
    bcc: [],
    subject: "Re: Yeni sipariş",
    html: "<p>Tesekkurler, yarin gonderiyoruz</p>",
    replyTo: quoting!.messageId,
    draft: { id: quotedDraft.id, messageId: quotedDraft.messageId, mailboxId: boxId, keep: [] },
    quote: { header: null },
  });
  check(!!(await drafts.openDraft(ids.ada, resaved.id!)).quote?.includes("<table>"), "saved again, it takes the quote from the draft before, its table kept");
  await sendMail(ids.ada, {
    mailboxId: boxId,
    to: [customer],
    cc: [],
    bcc: [],
    subject: "Re: Yeni sipariş",
    html: "<p>Tesekkurler, yarin gonderiyoruz</p>",
    replyTo: quoting!.messageId,
    draft: { id: resaved.id, messageId: resaved.messageId, mailboxId: boxId, keep: [] },
    quote: { header: null },
  });
  const quotedSent = (await lastMessageTo(customer)).replace(/=\r?\n/g, "");
  check(
    quotedSent.includes("yarin gonderiyoruz") && quotedSent.includes("leafdesk_quote") && quotedSent.includes("<table>") && /^> > Sipari.* \| adet/m.test(quotedSent) && !/^> Tesekkurler/m.test(quotedSent),
    "the answer sent carries the original's HTML under it, and its own text part quoted with >, kept from draft to draft",
    quotedSent.slice(-1500),
  );
  await outside.sendMail({
    ...base,
    subject: "Logo",
    html: `<p>Yeni logomuz</p><img src="cid:logo.${RUN}@acme.test">`,
    attachments: [{ filename: "logo.png", content: PNG, cid: `logo.${RUN}@acme.test` }],
  });
  await sweep();
  const logo = (await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id })).items.find((t) => t.subject === "Logo");
  await sendMail(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "Re: Logo", html: "<p>Cok guzel</p>", replyTo: logo!.messageId, quote: { header: ["Ayse yazdi:"] } });
  const logoSent = (await lastMessageTo(customer)).replace(/=\r?\n/g, "");
  check(logoSent.includes(`cid:logo.${RUN}@acme.test`) && new RegExp(`Content-ID: <logo\\.${RUN}@acme\\.test>`, "i").test(logoSent), "an image the original carries goes along with the quote", logoSent.slice(0, 3000));
  await sendMail(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "Re: Logo", html: "<p>Alintisiz</p>", replyTo: logo!.messageId, quote: null });
  const bare = (await lastMessageTo(customer)).replace(/=\r?\n/g, "");
  check(bare.includes("Alintisiz") && !bare.includes("leafdesk_quote") && !bare.includes("Yeni logomuz"), "an answer whose quote was taken off goes without it");
  const logoDraft = await drafts.saveDraft(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "Re: Logo", html: "<p>Taslaktan</p>", replyTo: logo!.messageId, quote: { header: ["Ayse yazdi:"] } });
  check(!logoDraft.attachments.length, "the images a quote carries aren't listed as the draft's files", logoDraft.attachments);
  const logoAgain = await drafts.saveDraft(ids.ada, {
    mailboxId: boxId,
    to: [customer],
    cc: [],
    bcc: [],
    subject: "Re: Logo",
    html: "<p>Taslaktan, ikinci</p>",
    replyTo: logo!.messageId,
    draft: { id: logoDraft.id, messageId: logoDraft.messageId, mailboxId: boxId, keep: [] },
    quote: { header: null },
  });
  await sendMail(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "Re: Logo", html: "<p>Taslaktan, ikinci</p>", replyTo: logo!.messageId, draft: { id: logoAgain.id, messageId: logoAgain.messageId, mailboxId: boxId, keep: [] }, quote: { header: null } });
  const logoFromDraft = (await lastMessageTo(customer)).replace(/=\r?\n/g, "");
  check(logoFromDraft.includes("Taslaktan, ikinci") && (logoFromDraft.match(/Content-ID: <logo\./gi) ?? []).length === 1, "and go along, once, when the draft is saved again and sent", logoFromDraft.slice(0, 3000));

  // Forwarding with the original under its header, and its files
  await outside.sendMail({
    ...base,
    subject: "Fiyat listesi",
    text: "Liste asagida.\nKalem | Tutar",
    html: `<p>Liste asagida.</p><table><tr><td>Kalem</td><td>Tutar</td></tr></table><img src="cid:imza.${RUN}@acme.test">`,
    attachments: [
      { filename: "liste.pdf", content: PDF, contentType: "application/pdf" },
      { filename: "imza.png", content: PNG, cid: `imza.${RUN}@acme.test` },
    ],
  });
  await sweep();
  const liste = (await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id })).items.find((t) => t.subject === "Fiyat listesi");
  const forwardHeader = ["---------- Forwarded message ----------", `From: ${customer}`, "Subject: Fiyat listesi"];
  const forwardDraft = await drafts.saveDraft(ids.ada, { mailboxId: boxId, to: [sales], cc: [], bcc: [], subject: "Fwd: Fiyat listesi", html: "<p>Bilgine</p>", forward: liste!.messageId, quote: { header: forwardHeader } });
  const openedForward = await drafts.openDraft(ids.ada, forwardDraft.id!);
  check(
    !openedForward.html.includes("Kalem") && !!openedForward.quote?.includes("<table>") && openedForward.quote.includes("Forwarded message") && openedForward.attachments.map((a) => a.name).join() === "liste.pdf",
    "a forward's draft keeps the original apart, under its header, with the original's files but not its pictures",
    openedForward,
  );
  const forwardAgain = await drafts.saveDraft(ids.ada, {
    mailboxId: boxId,
    to: [sales],
    cc: [],
    bcc: [],
    subject: "Fwd: Fiyat listesi",
    html: "<p>Bilgine, son hali</p>",
    draft: { id: forwardDraft.id, messageId: forwardDraft.messageId, mailboxId: boxId, keep: openedForward.attachments.map((a) => a.part) },
    quote: { header: null },
  });
  await sendMail(ids.ada, {
    mailboxId: boxId,
    to: [sales],
    cc: [],
    bcc: [],
    subject: "Fwd: Fiyat listesi",
    html: "<p>Bilgine, son hali</p>",
    draft: { id: forwardAgain.id, messageId: forwardAgain.messageId, mailboxId: boxId, keep: forwardAgain.attachments.map((a) => a.part) },
    quote: { header: null },
  });
  const forwarded = (await lastMessageTo(sales)).replace(/=\r?\n/g, "");
  check(
    forwarded.includes("Bilgine, son hali") &&
      forwarded.includes("leafdesk_forward") &&
      (forwarded.match(/Forwarded message/g) ?? []).length === 2 &&
      forwarded.includes("<table>") &&
      /^Kalem \| Tutar/m.test(forwarded) &&
      !/^> /m.test(forwarded) &&
      forwarded.includes("liste.pdf") &&
      (forwarded.match(/Content-ID: <imza\./gi) ?? []).length === 1,
    "a forward goes with the original under its header (once in each part), its text unquoted, its file and its picture",
    forwarded.slice(0, 4000),
  );

  // Pictures put in the text
  const picture = (name: string) => new File([PNG], name, { type: "image/png" });
  const firstCid = `ekran1.${RUN}@leafdesk`;
  await sendMail(
    ids.ada,
    { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "Ekran", html: `<p>Ekran:</p><img src="cid:${firstCid}" alt="ekran"><img src="cid:yok.${RUN}@leafdesk"><p>Bitti</p>` },
    [],
    [{ cid: firstCid, file: picture("ekran.png") }],
  );
  const withPicture = (await lastMessageTo(customer)).replace(/=\r?\n/g, "");
  check(
    /multipart\/related/i.test(withPicture) && (withPicture.match(new RegExp(`Content-ID: <ekran1\\.${RUN}@leafdesk>`, "gi")) ?? []).length === 1 && withPicture.includes(`src=3D"cid:${firstCid}"`) && !withPicture.includes("cid:yok.") && /^Ekran:\r?\nBitti/m.test(withPicture),
    "a picture put in the text goes as a part of the message it shows, one without a part is left out, the text part is only words",
    withPicture.slice(0, 3000),
  );
  check((await errorCode(() => sendMail(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "x", html: "<p>x</p>" }, [], [{ cid: `not.${RUN}@leafdesk`, file: new File(["x"], "x.txt", { type: "text/plain" }) }]))) === "invalid", "only pictures go in the text");
  const secondCid = `ekran2.${RUN}@leafdesk`;
  const pictureDraft = await drafts.saveDraft(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "Ekran 2", html: `<p>Bak</p><img src="cid:${secondCid}">` }, [], [{ cid: secondCid, file: picture("ekran2.png") }]);
  const openedPicture = await drafts.openDraft(ids.ada, pictureDraft.id!);
  check(
    !pictureDraft.attachments.length && !openedPicture.attachments.length && openedPicture.html.includes(`data-cid="${secondCid}"`) && openedPicture.html.includes("src=\"data:image/png;base64,"),
    "a draft's picture isn't one of its files, and opens as data the editor shows, marked with its Content-ID",
    openedPicture.html.slice(0, 300),
  );
  const pictureAgain = await drafts.saveDraft(ids.ada, {
    mailboxId: boxId,
    to: [customer],
    cc: [],
    bcc: [],
    subject: "Ekran 2",
    html: `<p>Bak, son hali</p><img src="cid:${secondCid}">`,
    draft: { id: pictureDraft.id, messageId: pictureDraft.messageId, mailboxId: boxId, keep: [] },
  });
  await sendMail(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [], subject: "Ekran 2", html: `<p>Bak, son hali</p><img src="cid:${secondCid}">`, draft: { id: pictureAgain.id, messageId: pictureAgain.messageId, mailboxId: boxId, keep: [] } });
  const pictureSent = (await lastMessageTo(customer)).replace(/=\r?\n/g, "");
  check(pictureSent.includes("son hali") && (pictureSent.match(new RegExp(`Content-ID: <ekran2\\.${RUN}@leafdesk>`, "gi")) ?? []).length === 1, "saved again and sent without sending it again, the picture comes over from the draft, once", pictureSent.slice(0, 2500));
  await sweep();
  const sentPicture = (await read.listThreads(ids.ada, { mailboxId: boxId, folderId: folder("sent").id })).items.find((t) => t.subject === "Ekran 2");
  const sentBody = sentPicture ? await read.readBody(ids.ada, { id: sentPicture.messageId }) : null;
  check(!!sentBody?.html?.includes("data:image/png;base64,") && !sentBody.attachments.length, "the copy in the sent folder shows it in place, not as a file", sentBody?.attachments);
  const inInbox = await db.select().from(mailMessage).where(eq(mailMessage.folderId, inbox.id));
  check(inInbox.filter((m) => m.subjectKey === "bütçe").length === 1, "and leaves out what was deleted elsewhere", inInbox.map((m) => m.subject));
  check(inInbox.find((m) => m.subjectKey === "bütçe")?.flagged, "and takes flags changed elsewhere");

  // Search
  const found = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id, search: `from:ayse konu:teklif` });
  check(found.items.length === 1 && found.items[0].threadId === teklif!.threadId, "search finds by sender and subject in every folder but the trash", found.items.map((t) => t.subject));
  check((await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id, search: "sipariş formu" })).items.length === 1, "and words of the first line");

  // Leaving mailing lists
  const robot = `robot.${RUN}@lists.test`;
  const list = { from: `Liste <${stranger}>`, to: ada, text: "Liste" };
  const oneClickHeaders = { "List-Unsubscribe": "<https://lists.test/u?x=1>, <mailto:unsub@lists.test>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  await outside.sendMail({ ...list, subject: "Tek tık liste", headers: oneClickHeaders });
  await outside.sendMail({ ...list, subject: "Posta liste", headers: { "List-Unsubscribe": `<mailto:${robot}?subject=Abonelik%20iptal>` } });
  await outside.sendMail({ ...list, subject: "Sahte liste", headers: { ...oneClickHeaders, "Authentication-Results": "mx.lists.test; dmarc=fail header.from=lists.test" } });
  await settle();
  await sweep();
  const lists = (await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id })).items;
  const listMessage = (subject: string) => lists.find((t) => t.subject === subject)!.messageId;
  const offers = await Promise.all(["Tek tık liste", "Posta liste", "Sahte liste"].map(async (s) => (await read.readBody(ids.ada, { id: listMessage(s) })).unsubscribe));
  check(
    offers[0]?.how === "oneClick" && offers[1]?.how === "mail" && offers[1].address === robot && offers[2]?.how === "web" && offers[2].url === "https://lists.test/u?x=1",
    "a list offers its one-click address, else a mail to it; a sender failing the check, only its web page",
    offers,
  );
  const posted: { url: string; method: string; body: string; reach: unknown }[] = [];
  const listAnswers = (status: number) => async (url: string | URL | Request, init: RequestInit = {}, reach: unknown = {}) => {
    posted.push({ url: String(url), method: init.method ?? "GET", body: String(init.body), reach });
    return new Response(null, { status });
  };
  check((await unsubscribe(ids.ada, { id: listMessage("Tek tık liste") }, listAnswers(200))) === "oneClick", "one click unsubscribes");
  check(
    posted[0]?.url === "https://lists.test/u?x=1" && posted[0].method === "POST" && posted[0].body === "List-Unsubscribe=One-Click" && (posted[0].reach as { untrusted?: boolean }).untrusted === true,
    "by posting List-Unsubscribe=One-Click to the list's address, as an untrusted address",
    posted,
  );
  check((await errorCode(() => unsubscribe(ids.ada, { id: listMessage("Tek tık liste") }, listAnswers(500)))) === "unsubscribeFailed", "a list that refuses it says so");
  check((await errorCode(() => unsubscribe(ids.bob, { id: listMessage("Tek tık liste") }, listAnswers(200)))) === "noMailbox" && posted.length === 2, "another member can't unsubscribe the mailbox");
  check((await unsubscribe(ids.ada, { id: listMessage("Posta liste") })) === "mail", "a list with only an address to mail unsubscribes by mail");
  check(/^Subject: Abonelik iptal$/m.test(await lastMessageTo(robot)), "the mail goes from the mailbox to the list's address, with the subject the list asks for");
  check((await errorCode(() => unsubscribe(ids.ada, { id: listMessage("Sahte liste") }, listAnswers(200)))) === "invalid" && posted.length === 2, "nothing goes to a sender that failed the check");

  // Live: a watched inbox (IDLE) tells of new mail as it comes, already read into the index.
  check(await asAda(async (client) => client.capabilities.has("IDLE")), "the test server takes IDLE");
  const heard: { mailboxId: string; folderId: string }[] = [];
  const unwatch = watchMailbox(boxId, (change) => heard.push(change));
  try {
    // The watch signs in and selects the inbox first.
    await settle();
    await settle();
    await outside.sendMail({ ...base, subject: `Canlı ${RUN}`, text: "Şimdi geldi." });
    for (let i = 0; i < 25 && !heard.length; i++) await settle();
    check(heard[0]?.mailboxId === boxId && heard[0]?.folderId === inbox.id, "new mail in a watched inbox is told at once", heard);
    const [live] = await db.select({ id: mailMessage.id }).from(mailMessage).where(and(eq(mailMessage.folderId, inbox.id), eq(mailMessage.subject, `Canlı ${RUN}`)));
    check(live, "and is in the index by then");
  } finally {
    unwatch();
    stopWatching(boxId);
  }

  // Paging
  const firstPage = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: folder("sent").id });
  check(firstPage.next === null, "a short list has no next page");

  const kept = await db.select({ n: mailFolder.id }).from(mailFolder).where(eq(mailFolder.mailboxId, boxId));
  check(kept.length === 7, "seven folders are kept: six, and the drafts folder made for drafts");
  console.log(`\n${passed} checks passed`);
} finally {
  outside.close();
  if (boxId) closeImap(boxId);
  if (salesBoxId) closeImap(salesBoxId);
  if (boxId) stopWatching(boxId);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
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
