import { and, desc, eq, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { mailbox, mailDatabase, page, rowEmail, user } from "@/db/schema";
import type { AgentEmailRecord } from "@/lib/agents";
import { checkEmailDraft, explainEmailDraftProblems } from "@/lib/email-draft-check";
import { MAX_MAIL_TEXT, normalizeAddress, replySubject } from "@/lib/mail";
import { redactText } from "@/lib/redact";
import type { AiTool } from "@/server/ai";
import { proposeChange } from "@/server/pending-changes";
import { rowMailAccess } from "@/server/row-mail/access";
import { workspaceSettings } from "@/server/workspaces";

/**
 * Emails an agent drafts on a row (draft_email): never sent by the agent, each one waits in its
 * sender's review queue (pending-changes.ts) and goes out from their mailbox once they approve it.
 * The sender is the person the run works for; a run that works for no one drafts none.
 *
 * The agent doesn't read the row's mail: messages come from outside the workspace and could carry
 * anyone's instructions. It writes from the row and its task, and the draft goes to whom the row's
 * mail decides (the latest message's other party, else the row's own addresses).
 */

export const DRAFT_EMAIL = "draft_email";

/** Whose mailbox a run's drafts go out from. */
export type DraftSender = { userId: string; name: string; address: string };

/**
 * The sender of a run's drafts on rows of `databaseId`: the member the run works for, when email
 * on rows is on in the workspace, mail is matched to the database's rows and they have a mailbox
 * there. Null: the run drafts no email.
 */
export async function draftSender(member: string | null, workspaceId: string, databaseId: string | null): Promise<DraftSender | null> {
  if (!member || !databaseId) return null;
  const [settings, [matched], [box]] = await Promise.all([
    workspaceSettings(workspaceId),
    db
      .select({ id: mailDatabase.databaseId })
      .from(mailDatabase)
      .where(and(eq(mailDatabase.databaseId, databaseId), eq(mailDatabase.workspaceId, workspaceId))),
    db
      .select({ address: mailbox.address, displayName: mailbox.displayName, name: user.name })
      .from(mailbox)
      .innerJoin(user, eq(user.id, mailbox.userId))
      .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, member))),
  ]);
  if (!settings.email || !matched || !box) return null;
  return { userId: member, name: box.displayName || box.name, address: box.address };
}

/** The database a row belongs to, for a row's run. */
export async function databaseOfRow(rowId: string): Promise<string | null> {
  const [row] = await db.select({ parentId: page.parentId }).from(page).where(eq(page.id, rowId));
  return row?.parentId ?? null;
}

/** The draft_email tool of a run whose drafts go out from `sender`; `anyRow`: a database's run, naming the row. */
export function draftEmailTool(sender: DraftSender, { anyRow }: { anyRow: boolean }): AiTool {
  return {
    name: DRAFT_EMAIL,
    description:
      `Drafts an email on ${anyRow ? "a row of the database this run looks after" : "the row"}, from ${sender.name}'s mailbox (${sender.address}), to the row's own addresses: ` +
      `it answers the row's latest email when there is one (keeping its subject), else starts a new message. Nothing is sent: ${sender.name} reads the draft under For review and sends or dismisses it. ` +
      "Write the finished message in plain text, as they would send it: no Markdown, HTML or placeholders to fill in, signed with their name. A draft that isn't finished is refused.",
    parameters: {
      type: "object",
      properties: {
        ...(anyRow ? { row_id: { type: "string", description: "The row's page_id (from a source)." } } : {}),
        subject: { type: "string", description: "The subject, on one line (a reply keeps its thread's subject instead)." },
        text: { type: "string", description: "The message, in plain text." },
        reason: { type: "string", description: "Why you draft it, in a sentence, for the person reviewing it." },
      },
      required: [...(anyRow ? ["row_id"] : []), "subject", "text", "reason"],
      additionalProperties: false,
    },
  };
}

type Drafted = { content: string; isError?: boolean; step?: AgentEmailRecord };

/**
 * Keeps an email the agent drafted on `rowId` for its sender to review: checked first, so a draft
 * that isn't a finished message goes back to the agent with what is wrong.
 */
export async function draftRowEmail(input: {
  workspaceId: string;
  agent: { id: string; userId: string };
  runId: string;
  automationRunId: string | null;
  sender: DraftSender;
  rowId: string;
  args: Record<string, unknown>;
}): Promise<Drafted> {
  const { sender, rowId, args } = input;
  const subjectIn = typeof args.subject === "string" ? args.subject : "";
  const text = typeof args.text === "string" ? args.text.replace(/\r\n/g, "\n").trim() : "";
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  const failed = (content: string): Drafted => ({
    content,
    isError: true,
    step: { kind: "email", pageId: rowId, subject: redactText(subjectIn.trim()).slice(0, 200), outcome: "failed" },
  });
  if (!reason) return { content: "Give a reason: why you draft this email, for the person reviewing it. Nothing was drafted.", isError: true };
  const check = checkEmailDraft({ subject: subjectIn, text });
  if (!check.ok) return { content: `The draft isn't a finished message: ${explainEmailDraftProblems(check)}. Write it again. Nothing was drafted.`, isError: true };
  if (text.length > MAX_MAIL_TEXT) return { content: "The message is too long. Nothing was drafted.", isError: true };
  // The agent sees the row's mail (within the sender's access), and the sender may write on it.
  const [own, theirs] = await Promise.all([rowMailAccess(input.agent.userId, rowId), rowMailAccess(sender.userId, rowId)]);
  if (!own || !theirs || (theirs.level !== "edit" && theirs.level !== "full")) return failed(`${sender.name} can't write email on this row. Nothing was drafted.`);
  const target = await draftTarget(rowId, theirs.databaseId);
  if (!target) return failed("The row has no email address to write to, nor earlier mail to answer. Nothing was drafted.");
  const subject = target.earlierSubject !== null ? replySubject(target.earlierSubject) : subjectIn.replace(/\s+/g, " ").trim();
  if (!subject) return { content: "A new message needs a subject. Nothing was drafted.", isError: true };
  const { replaced } = await proposeChange({
    workspaceId: input.workspaceId,
    kind: "email_draft",
    databaseId: theirs.databaseId,
    rowId,
    payload: { to: target.to, cc: [], subject, text, replyTo: target.replyTo },
    before: null,
    reason,
    source: { kind: "agent_run", runId: input.runId, automationRunId: input.automationRunId },
    agent: input.agent,
    runId: input.runId,
    senderId: sender.userId,
    for: [],
  });
  return {
    content: `${replaced ? "Drafted again, in place of your earlier draft on this row" : "Drafted"}: ${target.replyTo ? "a reply" : "a new message"} to ${target.to.join(", ")}, subject "${subject}". It waits for ${sender.name} to send it under For review and isn't sent yet. Don't draft it again.`,
    step: { kind: "email", pageId: rowId, subject: redactText(subject).slice(0, 200), outcome: "proposed" },
  };
}

/**
 * Where a draft on the row goes, as a person's reply on it would: the other party of its latest
 * message (the sender of one received, those one sent went to), answering it; else, a new message
 * to the row's own addresses (its matched email properties).
 */
async function draftTarget(rowId: string, databaseId: string): Promise<{ to: string[]; replyTo: string | null; earlierSubject: string | null } | null> {
  const [latest] = await db
    .select({ id: rowEmail.id, direction: rowEmail.direction, fromAddress: rowEmail.fromAddress, to: rowEmail.to, subject: rowEmail.subject })
    .from(rowEmail)
    .where(and(eq(rowEmail.rowId, rowId), notInArray(rowEmail.status, ["hidden", "failed"])))
    .orderBy(desc(rowEmail.sentAt), desc(rowEmail.id))
    .limit(1);
  if (latest) {
    const to = [...new Set((latest.direction === "in" ? [latest.fromAddress] : latest.to).map(normalizeAddress).filter((a): a is string => !!a))];
    if (to.length) return { to, replyTo: latest.id, earlierSubject: latest.subject };
  }
  const [[matched], [row]] = await Promise.all([
    db.select({ propertyIds: mailDatabase.propertyIds }).from(mailDatabase).where(eq(mailDatabase.databaseId, databaseId)),
    db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)),
  ]);
  const values = (row?.properties ?? {}) as Record<string, unknown>;
  const to = [...new Set((matched?.propertyIds ?? []).map((id) => normalizeAddress(values[id])).filter((a): a is string => !!a))];
  return to.length ? { to, replyTo: null, earlierSubject: null } : null;
}
