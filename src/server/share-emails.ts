import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { accessRequest, databaseAutomation, databaseProperty, notification, page, pageReminder, user, workspace, workspaceJoinRequest } from "@/db/schema";
import type { Locale } from "@/i18n/config";
import { env } from "@/lib/env";
import { commentText } from "@/lib/comments";
import { pageLabel } from "@/lib/labels";
import { ownsWorkspace, resolvePageAccess } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import {
  accessRequestEmail,
  automationEmail,
  commentEmail,
  dateReminderEmail,
  joinRequestEmail,
  mailStatus,
  mentionEmail,
  reminderEmail,
  sendMail,
  shareEmail,
  type OutgoingMail,
} from "@/server/mail";
import { recipientLocale } from "@/server/mail/locale";
import { emailTranslator } from "@/server/mail/templates";
import { wantsEmail } from "@/server/notification-preferences";

/**
 * Emails people about pages shared with them, comments in their threads, mentions of them, their
 * reminders, requests for access to their pages and what database automations tell them, and owners
 * about join requests. The queue is the notification itself: `recordShare`, `recordComment`,
 * `recordMentions`, `recordReminder`, `recordAccessRequest`, `recordJoinRequest` and the automation
 * worker set `email_due_at` (a little ahead, or now for reminders and requests), undoing the share or the mention (or answering or deciding the request)
 * deletes the notification, and the sweep sends what is still there once it falls due. A restart
 * delays these emails instead of losing them.
 *
 * Each email is written in its recipient's language when it is known (see server/mail/locale.ts),
 * else in the one it was queued with (`email_locale`: the actor's, or the requester's).
 *
 * The answer to an access request goes to the requester right away instead (`mailNow`): they may
 * be outside the workspace, with no inbox to queue it in.
 */

/** How often the server looks for share emails that are due. */
const SWEEP_INTERVAL_MS = 5_000;

type Due = Pick<
  typeof notification.$inferSelect,
  | "kind"
  | "userId"
  | "actorId"
  | "pageId"
  | "threadId"
  | "mentionId"
  | "accessRequestId"
  | "joinRequestId"
  | "automationId"
  | "workspaceId"
  | "emailLocale"
  | "readAt"
  | "date"
  | "propertyId"
>;

let mailer: (mail: OutgoingMail) => Promise<void> = sendMail;

/** Takes the due emails off the queue (all of them with `everything`) and sends them. */
async function deliverDue(everything = false) {
  // Clearing the due time before sending means an email is sent at most once, even with two sweeps racing.
  const due = await db
    .update(notification)
    .set({ emailDueAt: null })
    .where(
      and(
        inArray(notification.kind, ["page_shared", "comment", "mention", "reminder", "access_request", "join_request", "automation"]),
        everything ? isNotNull(notification.emailDueAt) : lte(notification.emailDueAt, new Date()),
        // A snoozed notification's email waits until it comes back (see snoozeNotification).
        isNull(notification.snoozedUntil),
      ),
    )
    .returning({
      kind: notification.kind,
      userId: notification.userId,
      actorId: notification.actorId,
      pageId: notification.pageId,
      threadId: notification.threadId,
      mentionId: notification.mentionId,
      accessRequestId: notification.accessRequestId,
      joinRequestId: notification.joinRequestId,
      automationId: notification.automationId,
      workspaceId: notification.workspaceId,
      emailLocale: notification.emailLocale,
      readAt: notification.readAt,
      date: notification.date,
      propertyId: notification.propertyId,
    });
  for (const entry of due) {
    try {
      await send(entry);
    } catch (error) {
      console.error(`could not send ${entry.kind} email`, error);
    }
  }
}

/**
 * Tells an owner about a join request, if it still waits, they still own the workspace and want
 * these emails.
 */
async function sendJoinRequest(userId: string, workspaceId: string, joinRequestId: string | null, locale: Locale) {
  if (!joinRequestId || !(await wantsEmail(userId, "join_request"))) return;
  const [row] = await db
    .select({
      kind: workspaceJoinRequest.kind,
      email: workspaceJoinRequest.email,
      askerName: user.name,
      // Still an owner: someone demoted since the request came in doesn't get the email.
      recipient: sql<string | null>`(select u.email from ${user} u where u.id = ${userId} and ${ownsWorkspace(userId, sql`${workspaceId}`)})`,
      workspaceName: workspace.name,
    })
    .from(workspaceJoinRequest)
    .innerJoin(workspace, eq(workspace.id, workspaceJoinRequest.workspaceId))
    .leftJoin(user, eq(user.id, workspaceJoinRequest.requestedBy))
    .where(and(eq(workspaceJoinRequest.id, joinRequestId), eq(workspaceJoinRequest.status, "pending")));
  if (!row?.recipient) return;
  const content = joinRequestEmail(locale, {
    kind: row.kind,
    askerName: row.askerName ?? "",
    email: row.email,
    workspaceName: row.workspaceName,
    link: `${env.appUrl}/w/${workspaceId}/settings?tab=members&view=requests`,
  });
  await mailer({ to: row.recipient, ...content });
}

/**
 * Sends one email if the person hasn't seen the notification yet, still can open the page and wants
 * it. Access requests: only while they can still answer it (full access). Join requests have no
 * page (see sendJoinRequest).
 */
async function send({
  kind,
  userId,
  actorId,
  pageId,
  threadId,
  mentionId,
  accessRequestId,
  joinRequestId,
  automationId,
  workspaceId,
  emailLocale,
  readAt,
  date,
  propertyId,
}: Due) {
  if (readAt || kind === "assignment" || kind === "agent_approval") return;
  const locale = await recipientLocale(userId, emailLocale);
  if (kind === "join_request") return sendJoinRequest(userId, workspaceId, joinRequestId, locale);
  if (!pageId) return;
  const { page: target, level } = await resolvePageAccess(userId, pageId);
  if (!target || target.archivedAt || level === "none") return;
  if (kind === "access_request" && level !== "full") return;
  if (!(await wantsEmail(userId, kind))) return;
  // The latest comment someone else wrote in the thread; none when the thread or it was deleted since.
  let text = "";
  if (kind === "comment") {
    const thread = threadId ? (await getCollab().readThreads(pageId)).find((t) => t.id === threadId) : undefined;
    const latest = thread?.comments.findLast((c) => c.userId === actorId && c.body);
    if (!latest) return;
    text = commentText(latest.body);
  }
  const [[recipient], [actor], [space]] = await Promise.all([
    db.select({ email: user.email }).from(user).where(eq(user.id, userId)),
    actorId ? db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, actorId)) : [],
    db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId)),
  ]);
  if (!recipient?.email) return;
  const pageTitle = pageLabel(target.title, emailTranslator(locale)("share.untitled"));
  const link = `${env.appUrl}/w/${workspaceId}/p/${pageId}`;
  if (kind === "mention") {
    await mailer({ to: recipient.email, ...mentionEmail(locale, { actorName: actor?.name ?? "", pageTitle, workspaceName: space?.name ?? "", link }) });
    return;
  }
  if (kind === "reminder") {
    // A date property's reminder carries its date; a date mention's is in page_reminder.
    if (date && propertyId) {
      const [about] = await db
        .select({ propertyName: databaseProperty.name, databaseTitle: page.title })
        .from(databaseProperty)
        .innerJoin(page, eq(page.id, databaseProperty.databaseId))
        .where(eq(databaseProperty.id, propertyId));
      if (!about) return;
      const databaseTitle = pageLabel(about.databaseTitle, emailTranslator(locale)("share.untitled"));
      const names = { date, pageTitle, databaseTitle, propertyName: about.propertyName, workspaceName: space?.name ?? "", link };
      await mailer({ to: recipient.email, ...dateReminderEmail(locale, names) });
      return;
    }
    const [reminder] = mentionId
      ? await db
          .select({ date: pageReminder.date })
          .from(pageReminder)
          .where(and(eq(pageReminder.pageId, pageId), eq(pageReminder.mentionId, mentionId)))
      : [];
    if (!reminder) return;
    await mailer({ to: recipient.email, ...reminderEmail(locale, { date: reminder.date, pageTitle, workspaceName: space?.name ?? "", link }) });
    return;
  }
  if (kind === "access_request") {
    // Answered since (which deletes the notification too, but the sweep may have taken it first).
    const [request] = accessRequestId
      ? await db.select({ message: accessRequest.message }).from(accessRequest).where(eq(accessRequest.id, accessRequestId))
      : [];
    if (!request || !actor) return;
    const content = accessRequestEmail(locale, {
      requesterName: actor.name,
      requesterEmail: actor.email,
      pageTitle,
      workspaceName: space?.name ?? "",
      message: request.message,
      link,
    });
    await mailer({ to: recipient.email, ...content });
    return;
  }
  if (kind === "automation") {
    // Deleted since (which deletes the notification too, but the sweep may have taken it first).
    const [automation] = automationId
      ? await db
          .select({ name: databaseAutomation.name, databaseTitle: page.title })
          .from(databaseAutomation)
          .innerJoin(page, eq(page.id, databaseAutomation.databaseId))
          .where(eq(databaseAutomation.id, automationId))
      : [];
    if (!automation) return;
    const content = automationEmail(locale, {
      automationName: automation.name,
      actorName: actor?.name ?? "",
      pageTitle,
      databaseTitle: pageLabel(automation.databaseTitle, emailTranslator(locale)("share.untitled")),
      workspaceName: space?.name ?? "",
      link,
    });
    await mailer({ to: recipient.email, ...content });
    return;
  }
  if (kind === "comment") {
    const content = commentEmail(locale, { actorName: actor?.name ?? "", pageTitle, workspaceName: space?.name ?? "", text, link });
    await mailer({ to: recipient.email, ...content });
    return;
  }
  const content = shareEmail(locale, {
    actorName: actor?.name ?? "",
    pageTitle,
    workspaceName: space?.name ?? "",
    level,
    link,
  });
  await mailer({ to: recipient.email, ...content });
}

let sweeping = false;

/** Server only: sends notification emails as they fall due, including any left from before a restart. */
export function startShareEmails() {
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await deliverDue();
    } catch (error) {
      console.error("could not deliver notification emails", error);
    } finally {
      sweeping = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Emails sent right away by mailNow that haven't finished yet. */
const sending = new Set<Promise<void>>();

/**
 * Sends an email now, without waiting for it: a slow or failing mail server shouldn't hold up or
 * undo the change it is about. Does nothing when the server can't send email.
 */
export function mailNow(mail: OutgoingMail) {
  if (mailStatus() === "disabled") return;
  const delivery: Promise<void> = mailer(mail)
    .catch((error) => console.error("could not send email", error))
    .finally(() => sending.delete(delivery));
  sending.add(delivery);
}

/** Scripts and tests: send everything queued now instead of after the delay, and wait for mailNow. */
export async function flushShareEmails() {
  await deliverDue(true);
  await Promise.all(sending);
}

/** Scripts and tests: capture emails instead of sending them (null restores sending). */
export function setShareMailer(send: ((mail: OutgoingMail) => Promise<void>) | null) {
  mailer = send ?? sendMail;
}
