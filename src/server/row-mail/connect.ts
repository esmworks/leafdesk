import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import { MAX_MAIL_BYTES, type MailboxFolders, type MailboxServers } from "@/lib/mail";
import { isBlockedAddress } from "@/server/ssrf";

/**
 * Connections to members' mail servers. A member types the host names, so they are held to the
 * rules of connections (server/connections/fetch.ts): public addresses only, TLS always, unless
 * the instance lists the host in MAIL_ALLOWED_HOSTS. The name is resolved here, checked, and the
 * connection made to that address with the name kept for TLS, so it can't resolve elsewhere later.
 */

export class MailConnectError extends Error {
  constructor(
    readonly code: "blocked" | "notFound" | "auth" | "tls" | "unreachable" | "noInbox",
    message: string,
  ) {
    super(message);
  }
}

const CONNECT_TIMEOUT = 20_000;

export function allowedMailHost(host: string, port: number, allowed = env.mailAllowedHosts) {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  return allowed.includes(name) || allowed.includes(`${name}:${port}`);
}

type Resolve = (host: string) => Promise<{ address: string }[]>;
const systemResolve: Resolve = (host) => dnsLookup(host, { all: true });

/** The address to connect to for a mail host, refused when private (unless allowed). */
export async function resolveMailHost(host: string, port: number, resolve: Resolve = systemResolve) {
  const name = host.trim().replace(/^\[|\]$/g, "");
  const allowed = allowedMailHost(name, port);
  if (isIP(name)) {
    if (!allowed && isBlockedAddress(name)) throw new MailConnectError("blocked", `${name} is a private address`);
    return { address: name, servername: undefined, allowed };
  }
  if (!allowed && (!name.includes(".") || /^localhost\.?$/i.test(name) || /\.(localhost|local|internal|home\.arpa)\.?$/i.test(name))) {
    throw new MailConnectError("blocked", `${name} is a local host name`);
  }
  let addresses: { address: string }[];
  try {
    addresses = await resolve(name);
  } catch {
    throw new MailConnectError("notFound", `No address for ${name}`);
  }
  if (!addresses.length) throw new MailConnectError("notFound", `No address for ${name}`);
  if (!allowed && addresses.some((a) => isBlockedAddress(a.address))) throw new MailConnectError("blocked", `${name} has a private address`);
  return { address: addresses[0].address, servername: name, allowed };
}

export type MailCredentials = { servers: MailboxServers; username: string; password: string };

/** An IMAP client for the mailbox, connected; the caller logs out. */
export async function openImap({ servers, username, password }: MailCredentials) {
  const target = await resolveMailHost(servers.imapHost, servers.imapPort);
  const client = new ImapFlow({
    host: target.address,
    port: servers.imapPort,
    secure: servers.imapSecure,
    servername: target.servername,
    // Never send the password in the clear: STARTTLS is required on a port without TLS.
    doSTARTTLS: !servers.imapSecure && !target.allowed ? true : undefined,
    tls: target.servername ? { servername: target.servername } : undefined,
    auth: { user: username, pass: password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECT_TIMEOUT,
    greetingTimeout: CONNECT_TIMEOUT,
    socketTimeout: 5 * 60_000,
    maxLiteralSize: MAX_MAIL_BYTES + 1024 * 1024,
    maxResponseSize: MAX_MAIL_BYTES + 2 * 1024 * 1024,
    clientInfo: { name: "Leafdesk" },
  });
  // A dropped connection emits an error; without a listener it would take the process down.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    throw connectError(error);
  }
  return client;
}

/** An SMTP transport for the mailbox. */
export async function smtpTransport({ servers, username, password }: MailCredentials) {
  const target = await resolveMailHost(servers.smtpHost, servers.smtpPort);
  return nodemailer.createTransport({
    host: target.address,
    port: servers.smtpPort,
    secure: servers.smtpSecure,
    requireTLS: !servers.smtpSecure && !target.allowed,
    tls: target.servername ? { servername: target.servername } : undefined,
    auth: { user: username, pass: password },
    connectionTimeout: CONNECT_TIMEOUT,
    greetingTimeout: CONNECT_TIMEOUT,
    socketTimeout: 60_000,
  });
}

/** What went wrong connecting, in our terms. */
export function connectError(error: unknown): MailConnectError {
  if (error instanceof MailConnectError) return error;
  const e = error as { authenticationFailed?: boolean; code?: string; responseCode?: number; message?: string };
  const message = e?.message ?? String(error);
  if (e?.authenticationFailed || e?.code === "EAUTH" || e?.responseCode === 535 || /auth/i.test(e?.code ?? "")) {
    return new MailConnectError("auth", "The server refused the user name or password");
  }
  if (/certificate|tls|ssl|self.signed/i.test(message) || e?.code === "ETLS") return new MailConnectError("tls", message);
  return new MailConnectError("unreachable", message);
}

/**
 * Names a sent folder goes by when the server doesn't mark it as one, in the languages Leafdesk
 * speaks. The IMAP client already knows many from their names; these cover the ones it misses
 * (Gönderilenler, 보낸편지함, 已傳送…) and the common ones besides.
 */
const SENT_FOLDER_NAMES = [
  ...["Sent", "Sent Items", "Sent Messages", "Sent Mail", "Sent Mails", "Sent Email"],
  ...["Gönderilenler", "Gönderilmiş Öğeler", "Gönderilen Öğeler", "Gönderilmiş", "Gönderilen", "Gönderilmiş Postalar", "Gönderilen Postalar"],
  ...["Gesendet", "Gesendete Objekte", "Gesendete Elemente", "Gesendete Nachrichten"],
  ...["Enviados", "Elementos enviados", "Mensajes enviados", "Correo enviado"],
  ...["Envoyés", "Éléments envoyés", "Messages envoyés"],
  ...["Inviati", "Inviata", "Posta inviata", "Elementi inviati", "Messaggi inviati"],
  ...["Enviadas", "Itens enviados", "Mensagens enviadas"],
  ...["Wysłane", "Elementy wysłane", "Wiadomości wysłane"],
  ...["Отправленные", "Отправленные письма", "Отправленные элементы"],
  ...["Надіслані", "Відправлені", "Надіслані елементи", "Відправлені елементи"],
  ...["المرسلة", "العناصر المرسلة", "البريد المرسل", "المرسل"],
  ...["ارسال شده", "موارد ارسال شده", "فرستاده شده", "ارسالی"],
  ...["נשלחו", "נשלח", "פריטים שנשלחו", "דואר שנשלח"],
  ...["送信済み", "送信済みアイテム", "送信済みメール", "送信済みトレイ"],
  ...["보낸 편지함", "보낸 메일함", "보낸 메일", "보낸 항목"],
  ...["已发送", "已发送邮件", "已发邮件", "已发送项目", "已發送", "已傳送", "已傳送郵件", "寄件備份", "已寄出"],
];

/** A folder name as compared: case, accents, spaces, dashes and invisible marks don't count. */
const folderKey = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\p{M}\s​-‏._-]+/gu, "");

const SENT_FOLDER_RANK = new Map(SENT_FOLDER_NAMES.map((name, i) => [folderKey(name), i] as const).reverse());

type ListedFolder = { path: string; name: string; parent: string[]; flags: Set<string>; specialUse?: string };

/**
 * The sent folder by its name, for servers that don't mark one: a folder at the top or right under
 * the inbox (INBOX.Sent, INBOX/Sent), never one deeper down, which is somebody's own filing.
 */
export function guessSentFolder<T extends ListedFolder>(listed: T[]): T | undefined {
  const candidates = listed.flatMap((folder) => {
    const rank = SENT_FOLDER_RANK.get(folderKey(folder.name));
    const depth = folder.parent.length;
    if (rank === undefined || folder.specialUse || folder.flags.has("\\Noselect") || folder.flags.has("\\NonExistent")) return [];
    if (depth > 1 || (depth === 1 && folder.parent[0].toUpperCase() !== "INBOX")) return [];
    return [{ folder, depth, rank }];
  });
  candidates.sort((a, b) => a.depth - b.depth || a.rank - b.rank);
  return candidates[0]?.folder;
}

/**
 * Checks both directions: signs in to IMAP and finds the inbox and the sent folder (marked by the
 * server, or by its name), then signs in to SMTP. Returns where each folder stands now, so reading
 * starts with the mail that comes after.
 */
export async function testMailbox(credentials: MailCredentials): Promise<MailboxFolders> {
  const client = await openImap(credentials);
  const folders: MailboxFolders = {};
  try {
    const listed = await client.list();
    const inbox = listed.find((f) => f.specialUse === "\\Inbox" || f.path.toUpperCase() === "INBOX");
    if (!inbox) throw new MailConnectError("noInbox", "The server lists no inbox");
    const sent = listed.find((f) => f.specialUse === "\\Sent") ?? guessSentFolder(listed);
    for (const [key, folder] of [["inbox", inbox], ["sent", sent]] as const) {
      if (!folder) continue;
      const status = await client.status(folder.path, { uidNext: true, uidValidity: true });
      if (!status) continue;
      folders[key] = { path: folder.path, uidValidity: String(status.uidValidity ?? ""), lastUid: Math.max(0, (status.uidNext ?? 1) - 1) };
    }
  } catch (error) {
    throw connectError(error);
  } finally {
    await client.logout().catch(() => {});
  }
  const transport = await smtpTransport(credentials);
  try {
    await transport.verify();
  } catch (error) {
    throw connectError(error);
  } finally {
    transport.close();
  }
  return folders;
}
