import { and, eq, gt, inArray, isNotNull, isNull, lte, max, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accessRequest,
  databaseAutomation,
  databaseProperty,
  isOwnerKind,
  notification,
  page,
  pageUpdateEmail as pageUpdateEmailLog,
  pageVerification,
  user,
  workspace,
  workspaceJoinRequest,
} from "@/db/schema";
import type { Locale } from "@/i18n/config";
import { env } from "@/lib/env";
import { commentHash, commentText } from "@/lib/comments";
import { pageLabel } from "@/lib/labels";
import { PAGE_EMAIL_COOLDOWN_MS, PAGE_EMAIL_WINDOW_MS, planPageEmails } from "@/lib/page-watch";
import { managesPeopleOf, rankOf, resolvePageAccess, workspaceRoleOf } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { threadsVisibleTo } from "@/server/property-comments";
import {
  accessRequestEmail,
  automationEmail,
  commentEmail,
  dateReminderEmail,
  joinRequestEmail,
  mailStatus,
  mentionEmail,
  pageUpdateDigestEmail,
  pageUpdateEmail,
  pageVerificationEmail,
  reminderEmail,
  rowUpdateEmail,
  sendMail,
  shareEmail,
  type OutgoingMail,
} from "@/server/mail";
import { recipientLocale } from "@/server/mail/locale";
import { emailTranslator } from "@/server/mail/templates";
import { wantsEmail } from "@/server/notification-preferences";
import { rowUpdateFor } from "@/server/notifications";
import { startSweep } from "@/server/sweep";

/**
 * Emails people about pages shared with them, comments in their threads, mentions of them, their
 * reminders, requests for access to their pages, what database automations tell them and changes to
 * the rows they follow, verifiers about their verifications ending, and owners about join requests.
 * The queue is the notification itself:
 * `recordShare`, `recordComment`, `recordMentions`, `recordReminder`, `recordAccessRequest`,
 * `recordJoinRequest`, `recordRowUpdate` and the automation
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
  | "id"
  | "kind"
  | "userId"
  | "actorId"
  | "pageId"
  | "threadId"
  | "accessRequestId"
  | "joinRequestId"
  | "automationId"
  | "workspaceId"
  | "emailLocale"
  | "readAt"
  | "date"
  | "propertyId"
  | "message"
  | "createdAt"
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
        inArray(notification.kind, [
          "page_shared",
          "comment",
          "mention",
          "reminder",
          "access_request",
          "join_request",
          "automation",
          "row_update",
          "page_updated",
          "verification",
        ]),
        everything ? isNotNull(notification.emailDueAt) : lte(notification.emailDueAt, new Date()),
        // A snoozed notification's email waits until it comes back (see snoozeNotification).
        isNull(notification.snoozedUntil),
      ),
    )
    .returning({
      id: notification.id,
      kind: notification.kind,
      userId: notification.userId,
      actorId: notification.actorId,
      pageId: notification.pageId,
      threadId: notification.threadId,
      accessRequestId: notification.accessRequestId,
      joinRequestId: notification.joinRequestId,
      automationId: notification.automationId,
      workspaceId: notification.workspaceId,
      emailLocale: notification.emailLocale,
      readAt: notification.readAt,
      date: notification.date,
      propertyId: notification.propertyId,
      message: notification.message,
      createdAt: notification.createdAt,
    });
  // Page updates are held back together, per person (see sendPageUpdates).
  const pageUpdates = new Map<string, Due[]>();
  for (const entry of due) {
    if (entry.kind === "page_updated") {
      pageUpdates.set(entry.userId, [...(pageUpdates.get(entry.userId) ?? []), entry]);
      continue;
    }
    try {
      await send(entry);
    } catch (error) {
      console.error(`could not send ${entry.kind} email`, error);
    }
  }
  for (const [userId, entries] of pageUpdates) {
    try {
      await sendPageUpdates(userId, entries);
    } catch (error) {
      console.error("could not send page update emails", error);
    }
  }
}

/**
 * Emails one person about pages they watch that others edited (server/page-watch.ts), held back
 * as lib/page-watch `planPageEmails` says: a page they heard about within the cooldown waits for it
 * to end, a few emails a day go out one by one, and once that is used up the rest wait and go out
 * together in one digest. Nothing goes out for a notification they read, a page they can no longer
 * open or have open right now (they watched it change), or when they turned these emails off.
 */
async function sendPageUpdates(userId: string, entries: Due[]) {
  if (!(await wantsEmail(userId, "page_updated"))) return;
  const openNow = new Set<string>();
  const wanted: (Due & { pageId: string; pageTitle: string })[] = [];
  for (const entry of entries) {
    if (entry.readAt || !entry.pageId) continue;
    const { page: target, level } = await resolvePageAccess(userId, entry.pageId);
    if (!target || target.archivedAt || level === "none") continue;
    if (!openNow.has(entry.pageId) && getCollab().openUserIds(entry.pageId).includes(userId)) openNow.add(entry.pageId);
    if (openNow.has(entry.pageId)) continue;
    wanted.push({ ...entry, pageId: entry.pageId, pageTitle: target.title });
  }
  if (!wanted.length) return;
  const now = new Date();
  const [lastSent, window] = await Promise.all([
    db
      .select({ pageId: pageUpdateEmailLog.pageId, at: max(pageUpdateEmailLog.sentAt) })
      .from(pageUpdateEmailLog)
      .where(
        and(
          eq(pageUpdateEmailLog.userId, userId),
          inArray(pageUpdateEmailLog.pageId, wanted.map((w) => w.pageId)),
          gt(pageUpdateEmailLog.sentAt, new Date(now.getTime() - PAGE_EMAIL_COOLDOWN_MS)),
        ),
      )
      .groupBy(pageUpdateEmailLog.pageId),
    // One email per time sent: a digest's pages share theirs.
    db
      .selectDistinct({ at: pageUpdateEmailLog.sentAt })
      .from(pageUpdateEmailLog)
      .where(and(eq(pageUpdateEmailLog.userId, userId), gt(pageUpdateEmailLog.sentAt, new Date(now.getTime() - PAGE_EMAIL_WINDOW_MS)))),
  ]);
  const plan = planPageEmails({
    now,
    due: wanted.map((w) => ({ id: w.id, pageId: w.pageId })),
    lastSentByPage: new Map(lastSent.flatMap((l) => (l.at ? [[l.pageId, l.at] as const] : []))),
    sentInWindow: window.map((w) => w.at),
  });
  // Waiting: due again then, unless a newer update about the page replaced it meanwhile.
  for (const { id, until } of plan.later) {
    await db.update(notification).set({ emailDueAt: until }).where(and(eq(notification.id, id), isNull(notification.readAt)));
  }
  if (!plan.single.length && !plan.digest.length) return;
  const actorIds = [...new Set(wanted.flatMap((w) => (w.actorId ? [w.actorId] : [])))];
  const [[recipient], actors, spaces] = await Promise.all([
    db.select({ email: user.email }).from(user).where(eq(user.id, userId)),
    actorIds.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, actorIds)) : [],
    db
      .select({ id: workspace.id, name: workspace.name })
      .from(workspace)
      .where(inArray(workspace.id, [...new Set(wanted.map((w) => w.workspaceId))])),
  ]);
  if (!recipient?.email) return;
  const locale = await recipientLocale(userId, wanted[0]!.emailLocale);
  const untitled = emailTranslator(locale)("share.untitled");
  const about = (w: (typeof wanted)[number]) => ({
    actorName: actors.find((a) => a.id === w.actorId)?.name ?? "",
    pageTitle: pageLabel(w.pageTitle, untitled),
    workspaceName: spaces.find((s) => s.id === w.workspaceId)?.name ?? "",
    link: `${env.appUrl}/w/${w.workspaceId}/p/${w.pageId}`,
  });
  const byId = new Map(wanted.map((w) => [w.id, w]));
  const logSent = (pageIds: string[], sentAt: Date) =>
    db.insert(pageUpdateEmailLog).values(pageIds.map((pageId) => ({ userId, pageId, sentAt })));
  for (const id of plan.single) {
    const entry = byId.get(id)!;
    await mailer({ to: recipient.email, ...pageUpdateEmail(locale, about(entry)) });
    await logSent([entry.pageId], new Date());
  }
  if (plan.digest.length) {
    const pages = plan.digest.map((id) => byId.get(id)!);
    await mailer({ to: recipient.email, ...pageUpdateDigestEmail(locale, { pages: pages.map(about), link: env.appUrl }) });
    await logSent([...new Set(pages.map((p) => p.pageId))], new Date());
  }
}

/**
 * Tells an owner or membership admin about a join request, if it still waits, they still decide
 * them (managesPeopleOf) and want these emails.
 */
async function sendJoinRequest(userId: string, workspaceId: string, joinRequestId: string | null, locale: Locale) {
  if (!joinRequestId || !(await wantsEmail(userId, "join_request"))) return;
  const [row] = await db
    .select({
      kind: workspaceJoinRequest.kind,
      email: workspaceJoinRequest.email,
      askerName: user.name,
      // Still deciding requests: someone demoted since the request came in doesn't get the email.
      recipient: sql<string | null>`(select u.email from ${user} u where u.id = ${userId} and ${managesPeopleOf(userId, sql`${workspaceId}`)})`,
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
  id,
  kind,
  userId,
  actorId,
  pageId,
  threadId,
  accessRequestId,
  joinRequestId,
  automationId,
  workspaceId,
  emailLocale,
  readAt,
  date,
  propertyId,
  message,
  createdAt,
}: Due) {
  if (readAt || kind === "assignment" || isOwnerKind(kind)) return;
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
    const thread = threadId ? (await threadsVisibleTo(userId, pageId)).find((t) => t.id === threadId) : undefined;
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
    if (!date) return;
    // A date property's reminder, else one set on a date mention.
    if (propertyId) {
      const [about] = await db
        .select({
          propertyName: databaseProperty.name,
          databaseId: page.id,
          databaseTitle: page.title,
          options: databaseProperty.options,
        })
        .from(databaseProperty)
        .innerJoin(page, eq(page.id, databaseProperty.databaseId))
        // A deleted property reminds no one.
        .where(and(eq(databaseProperty.id, propertyId), isNull(databaseProperty.deletedAt)));
      if (!about) return;
      // A row can be shared without its database: then the database's name stays hidden too.
      const databaseTitle =
        (await resolvePageAccess(userId, about.databaseId)).level === "none"
          ? null
          : pageLabel(about.databaseTitle, emailTranslator(locale)("share.untitled"));
      // A time reads in the zone of whoever set the reminder.
      const timeZone = about.options.date?.reminder?.timeZone ?? "UTC";
      const names = { date, pageTitle, databaseTitle, propertyName: about.propertyName, workspaceName: space?.name ?? "", link, timeZone };
      await mailer({ to: recipient.email, ...dateReminderEmail(locale, names) });
      return;
    }
    await mailer({ to: recipient.email, ...reminderEmail(locale, { date, pageTitle, workspaceName: space?.name ?? "", link }) });
    return;
  }
  if (kind === "verification") {
    if (!date) return;
    // Verified again since (another end) or the verification removed: nothing to say any more.
    const [current] = await db.select({ expiresAt: pageVerification.expiresAt }).from(pageVerification).where(eq(pageVerification.pageId, pageId));
    if (current?.expiresAt?.toISOString() !== date) return;
    const content = pageVerificationEmail(locale, { until: date, ended: createdAt >= new Date(date), pageTitle, workspaceName: space?.name ?? "", link });
    await mailer({ to: recipient.email, ...content });
    return;
  }
  if (kind === "access_request") {
    // Answered since (which deletes the notification too, but the sweep may have taken it first).
    const [request] = accessRequestId
      ? await db
          .select({
            message: accessRequest.message,
            level: accessRequest.level,
            wanted: sql<boolean>`page_access_level(${accessRequest.requesterId}, ${accessRequest.pageId}) < ${rankOf(accessRequest.level)}`,
            requesterRole: workspaceRoleOf(accessRequest.requesterId, accessRequest.workspaceId),
            recipientRole: workspaceRoleOf(sql`${userId}`, accessRequest.workspaceId),
          })
          .from(accessRequest)
          .where(eq(accessRequest.id, accessRequestId))
      : [];
    // Or they got that access some other way since.
    if (!request || !request.wanted || !actor) return;
    // Guests don't learn the addresses of people in the workspace (see listAccessRequests).
    const hideEmail = request.recipientRole === "guest" && request.requesterRole !== null;
    const content = accessRequestEmail(locale, {
      requesterName: actor.name,
      requesterEmail: hideEmail ? null : actor.email,
      pageTitle,
      workspaceName: space?.name ?? "",
      message: request.message,
      link,
      level: request.level,
    });
    await mailer({ to: recipient.email, ...content });
    return;
  }
  if (kind === "automation") {
    // Deleted since (which deletes the notification too, but the sweep may have taken it first).
    const [automation] = automationId
      ? await db
          .select({ name: databaseAutomation.name, databaseId: page.id, databaseTitle: page.title })
          .from(databaseAutomation)
          .innerJoin(page, eq(page.id, databaseAutomation.databaseId))
          .where(eq(databaseAutomation.id, automationId))
      : [];
    if (!automation) return;
    // A row can be shared without its database: then the database's name stays hidden too.
    const databaseShown = (await resolvePageAccess(userId, automation.databaseId)).level !== "none";
    const content = automationEmail(locale, {
      automationName: automation.name,
      actorName: actor?.name ?? "",
      pageTitle,
      databaseTitle: databaseShown ? pageLabel(automation.databaseTitle, emailTranslator(locale)("share.untitled")) : null,
      workspaceName: space?.name ?? "",
      link,
      // A "date passed" run's notification has the row's date it ran for.
      datePassed: date !== null,
      message,
    });
    await mailer({ to: recipient.email, ...content });
    return;
  }
  if (kind === "row_update") {
    // Only what they may see in the row now: a property's access may have changed since.
    const update = await rowUpdateFor(userId, id);
    if (!update) return;
    const content = rowUpdateEmail(locale, {
      actorName: actor?.name ?? "",
      pageTitle,
      databaseTitle: update.databaseTitle === null ? null : pageLabel(update.databaseTitle, emailTranslator(locale)("share.untitled")),
      workspaceName: space?.name ?? "",
      changes: update.changes.map((c) => ({ property: c.property?.name ?? null, from: c.from, to: c.to })),
      body: update.body,
      link,
    });
    await mailer({ to: recipient.email, ...content });
    return;
  }
  if (kind === "comment") {
    // A new suggested edit (server/suggested-edits.ts): its thread's first comment quotes the change.
    const content = commentEmail(locale, {
      actorName: actor?.name ?? "",
      pageTitle,
      workspaceName: space?.name ?? "",
      text,
      link: threadId ? `${link}${commentHash(threadId)}` : link,
      suggested: message === "suggested",
    });
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

/** Server only: sends notification emails as they fall due, including any left from before a restart. */
export function startShareEmails() {
  return startSweep(SWEEP_INTERVAL_MS, () => deliverDue(), "could not deliver notification emails");
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
