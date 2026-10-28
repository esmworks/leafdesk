import { normalizeAddress } from "@/lib/mail";

/**
 * The addresses an agent may send email to (server/agents/send-mail.ts): set by people who can
 * edit it, never by its runs, so what a run reads can't send mail anywhere else.
 */

/** Addresses one agent may send to. */
export const MAX_AGENT_MAIL_RECIPIENTS = 10;

/** `value` (a list, or text with addresses between commas, semicolons or line breaks) as recipients; null when one isn't an address or there are too many. */
export function parseMailRecipients(value: unknown): string[] | null {
  const items = typeof value === "string" ? value.split(/[,;\n]/).filter((s) => s.trim()) : value;
  if (!Array.isArray(items)) return null;
  const out: string[] = [];
  for (const item of items) {
    const address = normalizeAddress(item);
    if (!address) return null;
    if (!out.includes(address)) out.push(address);
  }
  return out.length <= MAX_AGENT_MAIL_RECIPIENTS ? out : null;
}
