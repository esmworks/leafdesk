import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mailbox, user } from "@/db/schema";
import type { AgentEmailRecord } from "@/lib/agents";
import { checkEmailDraft, explainEmailDraftProblems } from "@/lib/email-draft-check";
import { MAX_MAIL_TEXT } from "@/lib/mail";
import { redactText } from "@/lib/redact";
import type { AiTool } from "@/server/ai";
import { sendFromMailbox } from "@/server/row-mail/send";
import { workspaceSettings } from "@/server/workspaces";

/**
 * Email an agent sends (send_email): from the mailbox of the person a run works for, to the
 * addresses people who can edit the agent set (its `mail_recipients`, lib/agent-mail.ts), and to no
 * one else. The run names no address, so what it reads (form answers, synced rows) can't send mail
 * elsewhere; that list is what stands behind each message, so it goes out at once, without review,
 * whatever the agent does with rows. One message a run, sent while the run waits: nothing is queued
 * or retried, and the run's steps are its record.
 */

export const SEND_EMAIL = "send_email";

/** Whose mailbox a run's email goes out from. */
export type MailSender = { userId: string; name: string; box: typeof mailbox.$inferSelect };

/**
 * The sender of a run's email: the member the run works for, when the agent has recipients, email
 * is on in the workspace and they have a mailbox there. Null: the run sends none.
 */
export async function mailSender(member: string | null, workspaceId: string, recipients: string[]): Promise<MailSender | null> {
  if (!member || !recipients.length) return null;
  const [settings, [found]] = await Promise.all([
    workspaceSettings(workspaceId),
    db
      .select({ box: mailbox, name: user.name })
      .from(mailbox)
      .innerJoin(user, eq(user.id, mailbox.userId))
      .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, member), eq(mailbox.isDefault, true))),
  ]);
  if (!settings.email || !found) return null;
  return { userId: member, name: found.box.displayName || found.name, box: found.box };
}

/** The send_email tool of a run whose email goes out from `sender` to `recipients`. */
export function sendEmailTool(sender: MailSender, recipients: string[]): AiTool {
  return {
    name: SEND_EMAIL,
    description:
      `Sends an email from ${sender.name}'s mailbox (${sender.box.address}) to ${recipients.join(", ")}: the addresses set on you, all of them, and no others. ` +
      "It goes out at once, without review, and once a run: write one finished message with everything in it. " +
      `Plain text, as ${sender.name} would send it: no Markdown, HTML or placeholders to fill in. A message that isn't finished is refused.`,
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "The subject, on one line." },
        text: { type: "string", description: "The message, in plain text." },
      },
      required: ["subject", "text"],
      additionalProperties: false,
    },
  };
}

type Sent = { content: string; isError?: boolean; step?: AgentEmailRecord };

/** Sends the agent's message to `recipients`, checked first; `sentBefore`: the run sent one already. */
export async function sendAgentEmail(input: { sender: MailSender; recipients: string[]; args: Record<string, unknown>; sentBefore: boolean }): Promise<Sent> {
  const { sender, recipients, args } = input;
  if (input.sentBefore) return { content: "You sent this run's email already: a run sends one. Nothing was sent.", isError: true };
  const subject = typeof args.subject === "string" ? args.subject.replace(/\s+/g, " ").trim() : "";
  const text = typeof args.text === "string" ? args.text.replace(/\r\n/g, "\n").trim() : "";
  if (!subject) return { content: "A message needs a subject. Nothing was sent.", isError: true };
  const check = checkEmailDraft({ subject, text });
  if (!check.ok) return { content: `The message isn't finished: ${explainEmailDraftProblems(check)}. Write it again. Nothing was sent.`, isError: true };
  if (text.length > MAX_MAIL_TEXT) return { content: "The message is too long. Nothing was sent.", isError: true };
  const step = (outcome: "sent" | "failed"): AgentEmailRecord => ({ kind: "email", pageId: null, subject: redactText(subject).slice(0, 200), outcome, to: recipients });
  try {
    await sendFromMailbox(sender.box, { fromName: sender.name, to: recipients, subject, text });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    return { content: `The mail server refused the message (${reason}). Nothing was sent; don't try again in this run.`, isError: true, step: step("failed") };
  }
  return { content: `Sent to ${recipients.join(", ")}, subject "${subject}". Don't send it again.`, step: step("sent") };
}
