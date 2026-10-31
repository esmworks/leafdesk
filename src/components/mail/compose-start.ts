import { normalizeAddress, replySubject } from "@/lib/mail";
import { forwardSubject, type MailAddress, type MailBody, type MailboxTabView, type MailMessageView } from "@/lib/mail-client";

/**
 * What a message written in the Mail tab starts from, apart from the composer (composer.tsx) so
 * the thread view can ask about answers without loading the editor.
 */

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";
export type ComposeSource = { message: MailMessageView; body: MailBody | null };
/** A recipient in a field: `bad` when what was typed isn't an address. */
export type Recipient = MailAddress & { bad?: boolean };

/** A recipient as a header line shows it: a name with a comma or quote in it is quoted. */
export const showAddress = (a: MailAddress) => (!a.name ? a.address : /[,;"<>]/.test(a.name) ? `"${a.name.replace(/["\\]/g, "")}" <${a.address}>` : `${a.name} <${a.address}>`);

/** Text cut at commas, semicolons and new lines, but not inside quotes or angle brackets. */
export function splitAddresses(value: string) {
  const parts: string[] = [];
  let part = "";
  let quoted = false;
  let angled = false;
  for (const ch of value) {
    if (ch === '"' && !angled) quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if (!quoted && !angled && (ch === "," || ch === ";" || ch === "\n")) {
      parts.push(part);
      part = "";
    } else part += ch;
  }
  parts.push(part);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** One recipient typed as "Name <address>" or the bare address. */
export function parseRecipient(part: string): Recipient {
  const angled = /^(.*?)<([^>]+)>\s*$/.exec(part);
  const address = normalizeAddress(angled?.[2] ?? part);
  if (!address) return { address: part, name: null, bad: true };
  const name = angled?.[1].trim().replace(/^"(.*)"$/, "$1").trim();
  return { address, name: name || null };
}

/** Who an answer goes to: the sender (or their Reply-To), or one's own recipients; reply-all copies the others. */
function answerAddresses(all: boolean, box: MailboxTabView, message: MailMessageView, replyTo: MailAddress[] | null) {
  const mine = message.from.address === box.address;
  const to = mine ? message.to : (replyTo ?? [message.from]);
  const taken = new Set([box.address, ...to.map((a) => a.address)]);
  const cc = all ? [...message.to, ...message.cc].filter((a) => !taken.has(a.address) && (taken.add(a.address), true)) : [];
  return { to, cc };
}

/** Whether reply-all would write to anyone a reply doesn't: only then is it offered. */
export const replyAllAdds = (box: MailboxTabView, message: MailMessageView) => answerAddresses(true, box, message, null).cc.length > 0;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Lines of text as the editor's paragraphs. */
const paragraphs = (lines: string[]) => lines.map((line) => `<p>${escape(line)}</p>`).join("");

export type ComposeStart = { to: Recipient[]; cc: Recipient[]; subject: string; html: string };

/** A signature's HTML as the editor reads it into a message (mail-editor.tsx `Signature`). */
export const signatureBlock = (html: string) => `<div data-signature="">${html}</div>`;

/**
 * What a message starts with: a line to write on, an empty one and the mailbox's signature, then for a
 * reply, reply-all or forward the earlier message, quoted under who wrote it when, or under a
 * forward's header.
 */
export function startFrom(mode: ComposeMode, box: MailboxTabView, source: ComposeSource | null, header: (m: MailMessageView) => string, forwarded: (m: MailMessageView) => string[]): ComposeStart {
  const signature = box.signature ? `<p></p>${signatureBlock(box.signature)}` : "";
  if (!source || mode === "new") return { to: [], cc: [], subject: "", html: signature && `<p></p>${signature}` };
  const { message, body } = source;
  const lines = (body?.text ?? message.preview).replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (mode === "forward") return { to: [], cc: [], subject: forwardSubject(message.subject), html: `<p></p>${signature}${signature && "<p></p>"}${paragraphs(forwarded(message))}<p></p>${paragraphs(lines)}` };
  const { to, cc } = answerAddresses(mode === "replyAll", box, message, body?.replyTo.length ? body.replyTo : null);
  return { to, cc, subject: replySubject(message.subject), html: `<p></p>${signature}<p></p><p>${escape(header(message))}</p><blockquote>${paragraphs(lines)}</blockquote>` };
}
