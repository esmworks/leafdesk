/**
 * Tasks the Mail tab's AI found in a thread (ai.ts, kind `tasks`), added as the person ticked them:
 * to-dos that mention them, so they show in My tasks (lib/page-tasks.ts), each with its due day and
 * a link back to the thread. They go into the page of the database row the other party is, when
 * there is one the person may change, else into the person's daily note.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { user } from "@/db/schema";
import { env } from "@/lib/env";
import { MENTION } from "@/lib/mentions";
import { cleanMailTask, mailTaskDay, MAX_MAIL_TASKS, type MailTask } from "@/lib/mail-tasks";
import { isPageLocked } from "@/lib/page-lock";
import { TODO_BLOCK } from "@/lib/page-tasks";
import { AccessError, requirePageAccess } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { getOrCreateDailyNote } from "@/server/journal";
import { RowMailError } from "@/server/row-mail/settings";
import { requireOwnMailbox } from "./access";
import { getThread } from "./read";

export type MailTasksInput = {
  mailboxId: string;
  folderId: string;
  threadId: string;
  tasks: MailTask[];
  /** The person's day (YYYY-MM-DD): the daily note the tasks go into without a row. */
  today: string;
  /** The link back to the thread's text, in the person's language. */
  linkText: string;
};

/** Where the tasks went: the page, and whether it is the row's (else the daily note). */
export type AddedMailTasks = { pageId: string; workspaceId: string; row: boolean; count: number };

export async function addMailTasks(userId: string, input: MailTasksInput): Promise<AddedMailTasks> {
  const box = await requireOwnMailbox(userId, input.mailboxId);
  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map(cleanMailTask).filter((t): t is MailTask => !!t);
  const today = mailTaskDay(input.today);
  if (!tasks.length || tasks.length > MAX_MAIL_TASKS || !today) throw new RowMailError("invalid");
  const thread = await getThread(userId, { mailboxId: box.id, folderId: input.folderId, threadId: input.threadId });

  const actor = { userId, model: true };
  let target: { pageId: string; row: boolean } | null = null;
  if (thread.row) {
    // A row the person may only read, or one locked, leaves the tasks to their daily note.
    const page = await requirePageAccess(userId, thread.row.rowId, "content").catch((error) => {
      if (error instanceof AccessError) return null;
      throw error;
    });
    if (page && !page.archivedAt && !isPageLocked(page)) target = { pageId: page.id, row: true };
  }
  if (!target) target = { pageId: (await getOrCreateDailyNote(actor, box.workspaceId, today)).pageId, row: false };

  const [me] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  const params = new URLSearchParams({ box: box.id, f: input.folderId, t: input.threadId });
  const link = `${env.appUrl}/w/${box.workspaceId}/mail?${params}`;
  const linkText = typeof input.linkText === "string" ? input.linkText.replace(/\s+/g, " ").trim().slice(0, 100) : "";
  const blocks = tasks.map((task) => ({
    type: TODO_BLOCK,
    props: { checked: false },
    content: [
      { type: MENTION, props: { kind: "user", id: randomUUID(), userId, name: me?.name ?? "" } },
      { type: "text", text: ` ${task.text}`, styles: {} },
      ...(task.date ? [{ type: "text", text: " ", styles: {} }, { type: MENTION, props: { kind: "date", id: randomUUID(), date: task.date } }] : []),
      ...(linkText ? [{ type: "text", text: " · ", styles: {} }, { type: "link", href: link, content: [{ type: "text", text: linkText, styles: {} }] }] : []),
    ],
  }));
  await getCollab().appendBlocks(target.pageId, blocks, actor, true);
  return { ...target, workspaceId: box.workspaceId, count: blocks.length };
}
