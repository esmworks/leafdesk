import { senderDomain } from "./sender-domain";
import { PUBLIC_EMAIL_DOMAINS } from "./sso-config";

/**
 * Where a mailbox owner's inbox puts mail (server/mail-client/senders.ts): in Focus, what people
 * wrote, or in Other, what machines sent (lists, newsletters, notices; `mail_message.automated`).
 * A sender rule overrides that for one address or everyone at a domain, and a blocked address's
 * mail goes to the junk as it comes. Import-free but for the list of public mail services, so the
 * thread menu can carry it.
 */

export const MAIL_SECTIONS = ["focus", "other"] as const;
export type MailSection = (typeof MAIL_SECTIONS)[number];

export const SENDER_RULE_KINDS = ["focus", "other", "block"] as const;
export type SenderRuleKind = (typeof SENDER_RULE_KINDS)[number];

export type SenderRuleView = { sender: string; kind: SenderRuleKind };

/** The most rules a person keeps: enough for every newsletter, few enough to look through in Settings. */
export const MAX_SENDER_RULES = 2000;

export { senderDomain };

/**
 * A domain a rule may name for everyone there: not a public mail service's, whose people have
 * nothing to do with each other.
 */
export function ruleDomain(address: string): string | null {
  const domain = senderDomain(address);
  return domain && !PUBLIC_EMAIL_DOMAINS.has(domain) ? domain : null;
}

/**
 * What a rule names as kept: an address, lower case, or a bare domain for everyone at it. Null for
 * anything else, a public mail service's domain among them; blocking takes an address only, so a
 * mistyped domain never sends a whole company's mail to the junk.
 */
export function ruleSender(value: unknown, kind: SenderRuleKind): string | null {
  if (typeof value !== "string") return null;
  const sender = value.trim().toLowerCase().replace(/^@/, "");
  if (sender.length > 320 || /[\s<>()",;:]/.test(sender)) return null;
  if (sender.includes("@")) return /^[^@]+@[^@]+\.[^@]+$/.test(sender) ? sender : null;
  if (kind === "block") return null;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(sender) && !PUBLIC_EMAIL_DOMAINS.has(sender) ? sender : null;
}

/** The rule that holds for an address: its own, else its domain's. */
export function ruleFor(address: string, rules: ReadonlyMap<string, SenderRuleKind>): SenderRuleKind | null {
  const own = rules.get(address.trim().toLowerCase());
  if (own) return own;
  const domain = senderDomain(address);
  return (domain && rules.get(domain)) || null;
}

/** The section of a message in the inbox: a rule's, else Other for what a machine sent. */
export function sectionOf(automated: boolean, rule: SenderRuleKind | null): MailSection {
  if (rule) return rule === "focus" ? "focus" : "other";
  return automated ? "other" : "focus";
}

/** Whether a rule's sender is a domain, for everyone at it. */
export const isDomainRule = (sender: string) => !sender.includes("@");
