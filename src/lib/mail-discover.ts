import type { MailboxServers } from "@/lib/mail";

/**
 * Finding a mailbox's servers from its address (server/row-mail/discover.ts asks; this part is
 * pure): an autoconfig file in the format mail clients share (the domain's own or the public
 * provider database's), DNS service records (RFC 6186, 8314), and the mail exchangers of providers
 * that take only their own sign-in. What it finds fills the form; connecting still tries it.
 */

/** Who the servers belong to when they take only their own sign-in (no password over IMAP). */
export type MailSignIn = "google" | "microsoft";

/** Where the settings were found, shown beside them. */
export type MailDiscoverySource = "autoconfig" | "ispdb" | "srv" | "mx";

export type DiscoveredMailServers = { servers: MailboxServers; username: string; source: MailDiscoverySource; signIn: MailSignIn | null };

/** The largest autoconfig file read. */
export const MAX_AUTOCONFIG_BYTES = 64 * 1024;

/** Microsoft's Outlook.com and Microsoft 365 servers. Neither takes a password over IMAP any more. */
export const MICROSOFT_SERVERS: MailboxServers = {
  imapHost: "outlook.office365.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.office365.com",
  smtpPort: 587,
  smtpSecure: false,
};

/** Outlook.com's own domains: personal Microsoft accounts. */
export const MICROSOFT_DOMAINS = ["outlook.com", "hotmail.com", "live.com", "msn.com", "windowslive.com"];

/** The text between `from` and the first `until` after it, and where that ends; null when either is missing. */
function between(text: string, from: string, until: string, start = 0): { inner: string; end: number; at: number } | null {
  const at = text.indexOf(from, start);
  if (at < 0) return null;
  const close = text.indexOf(until, at + from.length);
  if (close < 0) return null;
  return { inner: text.slice(at + from.length, close), end: close + until.length, at };
}

/** `text` without its XML comments (a comment may hold a whole server that was taken out). */
function withoutComments(text: string) {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<!--", at);
    if (open < 0) return out + text.slice(at);
    out += text.slice(at, open);
    const close = text.indexOf("-->", open + 4);
    if (close < 0) return out;
    at = close + 3;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name]).trim();

/** The elements `<tag …>…</tag>` in `text` (not nested in each other), with their opening tag's attributes. */
function elements(text: string, tag: string): { attributes: string; inner: string }[] {
  const found: { attributes: string; inner: string }[] = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf(`<${tag}`, at);
    if (open < 0) return found;
    const next = text[open + tag.length + 1];
    const headEnd = text.indexOf(">", open);
    if (headEnd < 0) return found;
    if (next !== ">" && next !== " " && next !== "\t" && next !== "\n" && next !== "\r") {
      at = headEnd + 1;
      continue;
    }
    const close = text.indexOf(`</${tag}>`, headEnd);
    if (close < 0) return found;
    found.push({ attributes: text.slice(open + tag.length + 1, headEnd), inner: text.slice(headEnd + 1, close) });
    at = close + tag.length + 3;
  }
}

const child = (text: string, tag: string) => {
  const found = between(text, `<${tag}>`, `</${tag}>`);
  return found ? decode(found.inner) : "";
};

const attribute = (attributes: string, name: string) => between(attributes, `${name}="`, '"')?.inner ?? null;

/** `%EMAILADDRESS%`, `%EMAILLOCALPART%` and `%EMAILDOMAIN%` filled in for `address`. */
function fill(template: string, address: string) {
  const at = address.lastIndexOf("@");
  return template.replaceAll("%EMAILADDRESS%", address).replaceAll("%EMAILLOCALPART%", address.slice(0, at)).replaceAll("%EMAILDOMAIN%", address.slice(at + 1));
}

type Server = { host: string; port: number; secure: boolean; username: string; oauth: boolean };

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** The servers of one kind in a provider's file: TLS from the start or STARTTLS, never plain text; implicit TLS first. */
function servers(provider: string, tag: "incomingServer" | "outgoingServer", type: "imap" | "smtp", address: string): Server[] {
  const found: Server[] = [];
  for (const { attributes, inner } of elements(provider, tag)) {
    if (attribute(attributes, "type") !== type) continue;
    const host = fill(child(inner, "hostname"), address).toLowerCase();
    const port = Number(child(inner, "port"));
    const socket = child(inner, "socketType").toUpperCase();
    if (host.length > 253 || !HOST.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || (socket !== "SSL" && socket !== "STARTTLS")) continue;
    const methods = elements(inner, "authentication").map((a) => decode(a.inner));
    found.push({ host, port, secure: socket === "SSL", username: fill(child(inner, "username") || "%EMAILADDRESS%", address), oauth: methods.length > 0 && methods.every((m) => m === "OAuth2") });
  }
  return found.sort((a, b) => Number(b.secure) - Number(a.secure));
}

/**
 * The IMAP and SMTP servers an autoconfig file (clientConfig 1.1) gives for `address`, and whether
 * they take only an OAuth sign-in; null when it gives no usable pair.
 */
export function readAutoconfig(xml: string, address: string): { servers: MailboxServers; username: string; oauthOnly: boolean } | null {
  const text = withoutComments(xml.slice(0, MAX_AUTOCONFIG_BYTES));
  const provider = elements(text, "emailProvider")[0]?.inner;
  if (!provider) return null;
  const imap = servers(provider, "incomingServer", "imap", address)[0];
  const smtp = servers(provider, "outgoingServer", "smtp", address)[0];
  if (!imap || !smtp) return null;
  return {
    servers: { imapHost: imap.host, imapPort: imap.port, imapSecure: imap.secure, smtpHost: smtp.host, smtpPort: smtp.port, smtpSecure: smtp.secure },
    username: imap.username,
    oauthOnly: imap.oauth,
  };
}

export type SrvRecord = { name: string; port: number; priority: number; weight: number };

/** The record to use of a service's SRV answer: the lowest priority, then the heaviest; none when the domain says it doesn't offer it (target "."). */
export function pickSrv(records: SrvRecord[]): { host: string; port: number } | null {
  const usable = records.filter((r) => r.name && r.name !== "." && r.port > 0);
  if (!usable.length) return null;
  usable.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  return { host: usable[0].name.replace(/\.$/, "").toLowerCase(), port: usable[0].port };
}

/** The provider whose own sign-in a domain's mail exchanger points to. */
export function signInOfMx(host: string): MailSignIn | null {
  const name = host.replace(/\.$/, "").toLowerCase();
  if (name.endsWith(".google.com") || name.endsWith(".googlemail.com")) return "google";
  if (name.endsWith(".mail.protection.outlook.com") || name.endsWith(".olc.protection.outlook.com")) return "microsoft";
  return null;
}

/**
 * The domain a mail exchanger belongs to, to look its provider up by (`mx.yandex.net` →
 * `yandex.net`): its last two labels, or three under a short second-level one (`co.uk`).
 */
export function mxDomain(host: string): string | null {
  const labels = host.replace(/\.$/, "").toLowerCase().split(".");
  if (labels.length < 2) return null;
  const take = labels.length > 2 && labels[labels.length - 1].length === 2 && labels[labels.length - 2].length <= 3 ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** The sign-in a known address takes without looking anything up. */
export function signInOfAddress(address: string): MailSignIn | null {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") return "google";
  return MICROSOFT_DOMAINS.includes(domain) ? "microsoft" : null;
}
