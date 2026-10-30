/**
 * End-to-end check of the Mail tab against the database and a real IMAP/SMTP server (GreenMail,
 * started here in a container of its own on free ports and removed at the end): opening a mailbox
 * reads its folders, with what each is for, and the newest of the inbox; threads join answers,
 * copies in the sent folder and replies without references by subject; a thread names the row its
 * other party is; a message's body comes from the server, its HTML without scripts and remote
 * images until asked for, with the images it carries inline, and it is marked read; a file
 * downloads as it was sent; archiving, starring, reading, the trash and deleting for good reach
 * the server and the index at once; an answer goes out in the same thread and lands in the sent
 * folder; the minute's sweep reads new mail, flags changed elsewhere and messages deleted
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

const { eq, inArray } = await import("drizzle-orm");
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
const { mailAction, sendMail } = await import("@/server/mail-client/write");
const { closeImap } = await import("@/server/mail-client/pool");
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

  // Opening
  check((await read.listMailboxes(ids.ada, workspaceId))[0]?.folders === null, "a mailbox has no index before its owner opens Mail");
  const opened = await read.openMailbox(ids.ada, boxId);
  const roles = Object.fromEntries((opened.folders ?? []).map((f) => [f.name, f.role]));
  check(roles.INBOX === "inbox" && roles.Sent === "sent" && roles.Trash === "trash" && roles.Archive === "archive" && roles.Junk === "junk" && roles.Projeler === null, "opening reads the folders and what each is for", roles);
  check(opened.folders?.[0]?.role === "inbox", "the inbox comes first");
  const folder = (role: string) => opened.folders!.find((f) => f.role === role)!;
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

  const thread = await read.getThread(ids.ada, { mailboxId: boxId, threadId: teklif!.threadId, folderId: inbox.id });
  check(
    thread.messages.map((m) => m.subject).join("|") === "Teklif|Re: Teklif|Re: Teklif" && thread.messages[2].folderRole === "sent",
    "a thread's messages come oldest first, from every folder",
    thread.messages.map((m) => [m.subject, m.folderRole]),
  );

  // Bodies
  const bulten = bySubject("Ekim bülteni")!;
  const body = await read.readBody(ids.ada, { id: bulten.messageId });
  check(body.html && !/<script|onclick|<form|<input/i.test(body.html), "the HTML comes without scripts, handlers or forms", body.html);
  check(body.blockedImages === 1 && !body.html!.includes("tracker.example"), "a remote image is left out until asked for", body);
  check(body.html!.includes("data:image/png;base64,"), "an image the message carries is shown inline");
  check(/target="_blank"/.test(body.html!) && /rel="noopener noreferrer"/.test(body.html!), "links open in a new tab");
  check(body.attachments.length === 1 && body.attachments[0].name === "fiyat.pdf", "the files list leaves out the image already shown", body.attachments);
  check(body.unsubscribe === "https://lists.test/unsub?u=1" && body.text.includes("Bülten metni"), "the text and the web unsubscribe address come along", body);
  const withImages = await read.readBody(ids.ada, { id: bulten.messageId, images: true });
  check(withImages.html!.includes("https://tracker.example/pixel.gif") && withImages.blockedImages === 0, "asked for, remote images stay in");
  const [bultenRow] = await db.select().from(mailMessage).where(eq(mailMessage.id, bulten.messageId));
  check(bultenRow.seen && (await uidsIn("INBOX", { seen: true })).includes(bultenRow.uid), "opening a message marks it read in the index and on the server");
  const file = await read.readAttachment(ids.ada, { id: bulten.messageId, part: body.attachments[0].part });
  check(file.data.equals(PDF) && file.contentType === "application/pdf", "a file downloads as it was sent");
  check((await errorCode(() => read.readAttachment(ids.ada, { id: bulten.messageId, part: "9" }))) === "gone", "a part the message doesn't have isn't served");

  // Who reads it
  check((await errorCode(() => read.listThreads(ids.bob, { mailboxId: boxId, folderId: inbox.id }))) === "noMailbox", "another member can't list it");
  check((await errorCode(() => read.readBody(ids.bob, { id: bulten.messageId }))) === "noMailbox", "nor read its messages");
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
  await mailAction(ids.ada, { mailboxId: boxId, folderId: inbox.id, threadIds: [bulten.threadId], action: "trash" });
  const trash = folder("trash");
  const trashed = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: trash.id });
  check(trashed.items.length === 1 && (await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id })).items.length === 1, "the trash takes the thread out of the inbox");
  check((await errorCode(() => mailAction(ids.ada, { mailboxId: boxId, folderId: inbox.id, threadIds: [bySubject("Ynt: Bütçe")!.threadId], action: "delete" }))) === "invalid", "deleting for good is only from the trash");
  await mailAction(ids.ada, { mailboxId: boxId, folderId: trash.id, threadIds: [bulten.threadId], action: "delete" });
  check((await uidsIn("Trash")).length === 0 && !(await read.listThreads(ids.ada, { mailboxId: boxId, folderId: trash.id })).items.length, "and deletes it there");

  // Answering
  const butce = (await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id })).items[0];
  const pdf = new File([PDF], "teklif.pdf", { type: "application/pdf" });
  await sendMail(ids.ada, { mailboxId: boxId, to: [customer], cc: [], bcc: [`gizli.${RUN}@leafdesk.test`], subject: "Re: Bütçe", text: "Aldık, teşekkürler.", replyTo: butce.messageId }, [pdf]);
  await settle();
  const delivered = await new Promise<string>((resolve, reject) => {
    const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: customer, pass: "x" }, logger: false });
    client
      .connect()
      .then(async () => {
        const lock = await client.getMailboxLock("INBOX");
        let raw = "";
        for await (const m of client.fetch("1:*", { source: true })) raw = m.source?.toString() ?? raw;
        lock.release();
        await client.logout();
        resolve(raw);
      })
      .catch(reject);
  });
  check(delivered.includes(`In-Reply-To: <butce2.${RUN}@acme.test>`) && delivered.includes("teklif.pdf") && !/^bcc:/im.test(delivered), "an answer goes out in the thread, with its file, without the Bcc line");
  check((await uidsIn("INBOX", { answered: true })).length === 1, "the message answered is marked so");
  await sweep();
  const sentList = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: folder("sent").id });
  const answer = sentList.items.find((t) => t.threadId === butce.threadId);
  check(answer && answer.count === 3, "the sent folder keeps a copy, read into the same thread", sentList.items);

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
  const inInbox = await db.select().from(mailMessage).where(eq(mailMessage.folderId, inbox.id));
  check(inInbox.filter((m) => m.subjectKey === "bütçe").length === 1, "and leaves out what was deleted elsewhere", inInbox.map((m) => m.subject));
  check(inInbox.find((m) => m.subjectKey === "bütçe")?.flagged, "and takes flags changed elsewhere");

  // Search
  const found = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id, search: `from:ayse konu:teklif` });
  check(found.items.length === 1 && found.items[0].threadId === teklif!.threadId, "search finds by sender and subject in every folder but the trash", found.items.map((t) => t.subject));
  check((await read.listThreads(ids.ada, { mailboxId: boxId, folderId: inbox.id, search: "sipariş formu" })).items.length === 1, "and words of the first line");

  // Paging
  const firstPage = await read.listThreads(ids.ada, { mailboxId: boxId, folderId: folder("sent").id });
  check(firstPage.next === null, "a short list has no next page");

  const kept = await db.select({ n: mailFolder.id }).from(mailFolder).where(eq(mailFolder.mailboxId, boxId));
  check(kept.length === 6, "six folders are kept");
  console.log(`\n${passed} checks passed`);
} finally {
  outside.close();
  if (boxId) closeImap(boxId);
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
