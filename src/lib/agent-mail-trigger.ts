import { normalizeAddress } from "./mail";
import { MAX_MAIL_SENDERS, MAX_MAIL_SUBJECT, MAX_MAIL_TASK } from "./agents";

/**
 * New email starting an agent's run (server/agents/mail-trigger.ts): set by the mailbox's owner on
 * a mailbox they opened to the agent (agent_mailbox), for the inbox. Each new message the filters
 * take starts one run per thread, with `task`; a message the owner sent, a draft, and mail a
 * machine wrote (auto-replies, mailing lists, bulk mail: `mail_message.automated`) start none.
 */

/**
 * Which new email starts a run: from one of `senders` (an address, or a domain as `@example.com` or
 * `example.com`, its subdomains too; none: anyone), with `subject` among its subject's words (empty:
 * any), and with `knownOnly`, only from someone who is a row of a database the owner can open (as
 * the Mail tab's row chip finds them).
 */
export type MailTriggerFilters = { senders: string[]; subject: string; knownOnly: boolean };

export const NO_MAIL_FILTERS: MailTriggerFilters = { senders: [], subject: "", knownOnly: false };

/** A mailbox's trigger as its owner sets it. */
export type MailTriggerInput = { on: boolean; task: string; filters: MailTriggerFilters };

/** One of `senders`, as kept: an address, or a domain with the "@" before it. Null when it is neither. */
export function senderPattern(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (text.includes("@") && !text.startsWith("@")) return normalizeAddress(text);
  const domain = text.replace(/^@/, "");
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ? `@${domain}` : null;
}

/** `value` (a list, or text with entries between commas, semicolons, spaces or line breaks) as senders; null when one is neither an address nor a domain, or there are too many. */
export function parseMailSenders(value: unknown): string[] | null {
  const items = typeof value === "string" ? value.split(/[,;\s]+/).filter(Boolean) : value;
  if (!Array.isArray(items)) return null;
  const out: string[] = [];
  for (const item of items) {
    const pattern = typeof item === "string" ? senderPattern(item) : null;
    if (!pattern) return null;
    if (!out.includes(pattern)) out.push(pattern);
  }
  return out.length <= MAX_MAIL_SENDERS ? out : null;
}

/** Checks a trigger an owner sends; null when a part is wrong. A trigger turned on needs a task. */
export function parseMailTrigger(value: unknown): MailTriggerInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const filters = (v.filters ?? {}) as Record<string, unknown>;
  if (typeof v.on !== "boolean" || typeof v.task !== "string" || typeof filters !== "object") return null;
  const task = v.task.trim();
  const senders = parseMailSenders(filters.senders ?? []);
  const subject = typeof filters.subject === "string" ? filters.subject.replace(/\s+/g, " ").trim() : filters.subject === undefined ? "" : null;
  const knownOnly = filters.knownOnly === undefined ? false : filters.knownOnly;
  if (!senders || subject === null || typeof knownOnly !== "boolean") return null;
  if (task.length > MAX_MAIL_TASK || subject.length > MAX_MAIL_SUBJECT || (v.on && !task)) return null;
  return { on: v.on, task, filters: { senders, subject, knownOnly } };
}

/** Whether a sender's address is one of the patterns (none: anyone). */
export function senderAllowed(address: string, senders: readonly string[]): boolean {
  if (!senders.length) return true;
  const from = address.trim().toLowerCase();
  const at = from.lastIndexOf("@");
  const domain = at >= 0 ? from.slice(at + 1) : "";
  return senders.some((p) => (p.startsWith("@") ? domain === p.slice(1) || domain.endsWith(`.${p.slice(1)}`) : from === p));
}

/** Whether every word of `subject` (the filter) is in the message's subject, ignoring case. */
export function subjectAllowed(messageSubject: string, subject: string): boolean {
  if (!subject) return true;
  const have = messageSubject.toLocaleLowerCase();
  return subject
    .toLocaleLowerCase()
    .split(" ")
    .every((word) => have.includes(word));
}

/**
 * Whether a new message may start a run, before the row check (`knownOnly`, server side): not one
 * the owner sent from one of their mailbox addresses (`own`), not a draft, not mail a machine
 * wrote, and passing the sender and subject filters.
 */
export function mailTriggerTakes(
  message: { fromAddress: string; subject: string; draft: boolean; automated: boolean },
  own: readonly string[],
  filters: MailTriggerFilters,
): boolean {
  const from = message.fromAddress.trim().toLowerCase();
  if (!from || message.draft || message.automated || own.some((a) => a.toLowerCase() === from)) return false;
  return senderAllowed(from, filters.senders) && subjectAllowed(message.subject, filters.subject);
}
