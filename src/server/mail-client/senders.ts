import { and, asc, count, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { mailMessage, mailSenderRule, type mailbox } from "@/db/schema";
import { MAX_SENDER_RULES, ruleFor, ruleSender, SENDER_RULE_KINDS, senderDomain, type SenderRuleKind, type SenderRuleView } from "@/lib/mail-senders";
import { RowMailError } from "@/server/row-mail/settings";
import { junkMessages } from "./write";

/**
 * A person's sender rules (lib/mail-senders.ts): which section of the inbox a sender's mail goes
 * to, and the addresses whose mail goes to the junk as it comes. The list reads them in SQL
 * (`senderRuleKind`); push notifications, agents' mail runs and the index's arrivals ask
 * `senderRules`.
 */

type Box = typeof mailbox.$inferSelect;

/** The kind of the rule holding for the sender in `address`, as SQL: the address's own, else its domain's; null without one. */
export function senderRuleKind(userId: string, address: SQL | AnyColumn): SQL<SenderRuleKind | null> {
  return sql<SenderRuleKind | null>`(select r.kind from ${mailSenderRule} r where r.user_id = ${userId} and r.sender in (lower(${address}), split_part(lower(${address}), '@', 2)) order by length(r.sender) desc limit 1)`;
}

/** The rules holding for these senders, by address in lower case; senders without one are left out. */
export async function senderRules(userId: string, addresses: string[]): Promise<Map<string, SenderRuleKind>> {
  const lower = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const keys = [...new Set(lower.flatMap((a) => [a, senderDomain(a) ?? ""]).filter(Boolean))];
  if (!keys.length) return new Map();
  const rows = await db
    .select({ sender: mailSenderRule.sender, kind: mailSenderRule.kind })
    .from(mailSenderRule)
    .where(and(eq(mailSenderRule.userId, userId), inArray(mailSenderRule.sender, keys)));
  const rules = new Map(rows.map((r) => [r.sender, r.kind]));
  return new Map(lower.flatMap((a) => (ruleFor(a, rules) ? [[a, ruleFor(a, rules)!] as const] : [])));
}

/** The person's rules, for Settings: domains with addresses, by name. */
export async function listSenderRules(userId: string): Promise<SenderRuleView[]> {
  return db.select({ sender: mailSenderRule.sender, kind: mailSenderRule.kind }).from(mailSenderRule).where(eq(mailSenderRule.userId, userId)).orderBy(asc(mailSenderRule.sender));
}

/**
 * Puts a sender's mail in a section of the inbox from now on, or blocks the address; replaces the
 * sender's rule, and returns the one it replaced, for Undo.
 */
export async function setSenderRule(userId: string, input: { sender: string; kind: SenderRuleKind }): Promise<{ previous: SenderRuleKind | null }> {
  const kind = SENDER_RULE_KINDS.find((k) => k === input?.kind);
  const sender = kind ? ruleSender(input?.sender, kind) : null;
  if (!kind || !sender) throw new RowMailError("invalid");
  const [own] = await db.select({ kind: mailSenderRule.kind }).from(mailSenderRule).where(and(eq(mailSenderRule.userId, userId), eq(mailSenderRule.sender, sender)));
  if (!own) {
    const [kept] = await db.select({ n: count() }).from(mailSenderRule).where(eq(mailSenderRule.userId, userId));
    if ((kept?.n ?? 0) >= MAX_SENDER_RULES) throw new RowMailError("invalid");
  }
  await db
    .insert(mailSenderRule)
    .values({ userId, sender, kind })
    .onConflictDoUpdate({ target: [mailSenderRule.userId, mailSenderRule.sender], set: { kind, createdAt: new Date() } });
  return { previous: own?.kind ?? null };
}

/** Takes a sender's rule away: their mail is sorted as it comes again, and a blocked address's no longer goes to the junk. */
export async function removeSenderRule(userId: string, input: { sender: string }) {
  const sender = typeof input?.sender === "string" ? input.sender.trim().toLowerCase().replace(/^@/, "") : "";
  if (sender) await db.delete(mailSenderRule).where(and(eq(mailSenderRule.userId, userId), eq(mailSenderRule.sender, sender)));
  return null;
}

/**
 * Mail just come to the inbox (indexer.ts `arrived`) from an address its owner blocked goes to the
 * junk. Returns how many messages went.
 */
export async function junkBlocked(box: Box, messageIds: string[]): Promise<number> {
  if (!messageIds.length) return 0;
  const messages = await db
    .select()
    .from(mailMessage)
    .where(and(eq(mailMessage.mailboxId, box.id), inArray(mailMessage.id, messageIds)));
  const rules = await senderRules(
    box.userId,
    messages.map((m) => m.fromAddress),
  );
  const blocked = messages.filter((m) => rules.get(m.fromAddress.toLowerCase()) === "block");
  await junkMessages(box, blocked);
  return blocked.length;
}
