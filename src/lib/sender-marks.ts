import { sniffImage } from "./avatar";
import { dmarcFailed } from "./mail";
import { PUBLIC_EMAIL_DOMAINS } from "./sso-config";

/**
 * The round mark beside each conversation of the Mail list: the other party's initial, a member's
 * own picture, or the logo of the organization a message verifiably came from
 * (server/mail-client/sender-logos.ts). A picture or a logo lends a message the face of someone the
 * owner trusts, so either shows only when the mailbox's provider says the sender's domain vouched
 * for the message (DMARC passed); otherwise the initial does.
 */

/** What the provider's check said of a message's sender: vouched for, not, or nothing to go by. */
export type SenderAuth = "pass" | "fail" | "none";

const domainOf = (address: string) => address.trim().toLowerCase().split("@")[1] ?? "";

/** The mailbox a message came to, whose provider's own `Authentication-Results` are the ones to go by. */
export type ReceivingMailbox = { imapHost: string; auth: string };

const isGoogle = (box: ReceivingMailbox) => box.auth === "google" || /(^|\.)(gmail|googlemail)\.com$/i.test(box.imapHost);
const isMicrosoft = (box: ReceivingMailbox) => box.auth === "microsoft" || /(^|\.)(outlook\.com|office365\.com|hotmail\.com|live\.com)$/i.test(box.imapHost);

/**
 * Whether the first `Authentication-Results` header is the mailbox provider's own: Google's
 * (`mx.google.com`) or Microsoft's (which names no server). Both check every message and put their
 * result on top, above anything a sender wrote. Another server can't be told apart from a sender:
 * one that checks nothing passes on whatever result a sender made up, under any server's name (its
 * own is easy to guess from its MX record), so mail to other providers never counts as checked.
 */
export function fromReceiver(header: string, box: ReceivingMailbox): boolean {
  const first = header.split(";")[0].trim().toLowerCase();
  if (isMicrosoft(box)) return first.includes("=");
  if (isGoogle(box)) return first.split(/\s+/)[0].replace(/\.$/, "") === "mx.google.com";
  return false;
}

/**
 * What `Authentication-Results` say of a message from `fromAddress` to `box`. A pass counts only in
 * the first header, and only when the mailbox's provider wrote it (`fromReceiver`) for the domain the
 * message is from; a failure anywhere counts (lib/mail.ts `dmarcFailed`).
 */
export function senderAuth(authenticationResults: string[] | undefined, fromAddress: string, box: ReceivingMailbox): SenderAuth {
  const headers = authenticationResults ?? [];
  if (dmarcFailed(headers)) return "fail";
  const domain = domainOf(fromAddress);
  if (!domain || !headers[0] || !fromReceiver(headers[0], box)) return "none";
  for (const result of headers[0].split(";")) {
    if (!/\bdmarc=pass\b/i.test(result)) continue;
    const from = /\bheader\.from=([^\s;]+)/i.exec(result)?.[1]?.toLowerCase().replace(/\.$/, "");
    if (from === domain) return "pass";
  }
  return "none";
}

/** The domain whose logo a sender may show: none for a public mail service, whose users are people, not it. */
export function logoDomain(address: string): string | null {
  const domain = domainOf(address);
  if (!domain || !/^[a-z0-9.-]{1,253}$/.test(domain) || !domain.includes(".") || PUBLIC_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

/** Second-level labels under a country's domain that many register under ("com.tr", "co.uk"). */
const SECOND_LEVEL = new Set(["ac", "biz", "co", "com", "edu", "gen", "go", "gob", "gov", "info", "k12", "ltd", "mil", "ne", "net", "nom", "or", "org", "plc", "sch", "web"]);

/**
 * The organization's own domain of a mail domain ("e.istexpo.com" → "istexpo.com",
 * "bilgi.kuveytturk.com.tr" → "kuveytturk.com.tr"), by a rule of thumb: the last two labels, or
 * three under a country's common second level.
 */
export function organizationDomain(domain: string): string {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  const keep = labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** Where a BIMI record (`v=BIMI1; l=https://…/logo.svg; a=…`) says the domain's logo is; null without an https one. */
export function bimiLocation(record: string): string | null {
  const tags = new Map<string, string>();
  for (const part of record.split(";")) {
    const at = part.indexOf("=");
    if (at > 0) tags.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  if (tags.get("v")?.toUpperCase() !== "BIMI1") return null;
  const location = tags.get("l")?.split(",")[0]?.trim();
  if (!location) return null;
  try {
    const url = new URL(location);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** The image types a logo is kept in. SVG only from a BIMI record, and only one that passes `plainSvg`. */
export const LOGO_TYPES = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  svg: "image/svg+xml",
} as const;
export type LogoFormat = keyof typeof LOGO_TYPES;

/** The largest logo kept. BIMI caps its SVGs at 32 KB; site icons are rarely past a few dozen. */
export const MAX_LOGO_BYTES = 128 * 1024;
/** Narrower raster icons look blurred at the list's size. */
export const MIN_LOGO_WIDTH = 32;

/** The format of a logo from its first bytes (never its name or declared type): a picture, an icon file or an SVG. */
export function sniffLogo(bytes: Uint8Array): LogoFormat | null {
  const image = sniffImage(bytes);
  if (image) return image;
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "ico";
  const start = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^\uFEFF/, "").trimStart();
  if (/^<(\?xml|svg[\s>]|!--)/i.test(start)) return "svg";
  return null;
}

/** The width of a PNG, or of an icon file's widest picture; null when the format doesn't say it plainly. */
export function logoWidth(bytes: Uint8Array, format: LogoFormat): number | null {
  if (format === "png" && bytes.length >= 24) return ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
  if (format === "ico" && bytes.length >= 6) {
    const count = bytes[4] | (bytes[5] << 8);
    let widest = 0;
    for (let i = 0; i < count && 6 + i * 16 < bytes.length; i++) widest = Math.max(widest, bytes[6 + i * 16] || 256);
    return widest;
  }
  return null;
}

/**
 * Whether an SVG is a plain drawing: no scripts, event handlers, embedded documents or anything it
 * would load. A logo shown in `<img>` runs none of those, but one opened at its own address could.
 */
export function plainSvg(text: string): boolean {
  const svg = text.toLowerCase();
  if (!svg.includes("<svg")) return false;
  if (/<(script|foreignobject|iframe|embed|object|image|animate|set|a)[\s>/]/.test(svg)) return false;
  if (/\son[a-z]+\s*=/.test(svg) || svg.includes("javascript:") || svg.includes("<!entity") || svg.includes("@import")) return false;
  // Only links within the drawing ("#gradient"), never to another address.
  if (/(href|src)\s*=\s*["']?\s*[^"'#\s]/.test(svg)) return false;
  if (/url\(\s*["']?\s*[^"'#\s)]/.test(svg)) return false;
  return true;
}
