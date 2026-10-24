import { and, count, desc, eq, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import type { RequestedLevel } from "@/lib/access-requests";
import { UNSNOOZABLE_KINDS } from "@/lib/snooze";
import {
  accessRequest,
  agentRun,
  connection,
  databaseAutomation,
  databaseProperty,
  emailSequence,
  notification,
  OWNER_KINDS,
  page,
  rowEmail,
  sequenceEnrollment,
  user,
  workspace,
  workspaceAgent,
  workspaceJoinRequest,
  type AgentRunState,
  type JoinRequestKind,
  type NotificationKind,
  type PageLevel,
} from "@/db/schema";
import { addReactor, parseReactors, reactionSummary, removeReactor, type Reactor } from "@/lib/comment-reactions";
import { avatarSrc } from "@/lib/avatar";
import { callConnectionName, callToSend, inboxCallInput, isScheduleRun, type AgentRunCode, type AgentRunStatus } from "@/lib/agents";
import { newAssignees } from "@/lib/properties";
import type { PropertyType } from "@/lib/property-types";
import { readableProperties, referencedIds, resolveValue, type ActivityValue } from "@/lib/row-activity";
import { isEmptyRowUpdate, mergeRowUpdates, parseRowUpdate, visibleRowUpdate, type RowUpdate } from "@/lib/row-updates";
import { isSuggestionNotice, type SuggestionNotice } from "@/lib/suggestions";
import {
  accessRank,
  FULL_RANK,
  findMembership,
  inWorkspace,
  levelFromRank,
  ownsWorkspace,
  pageVisibleTo,
  peopleWithFullAccess,
  rankOf,
  requireMembership,
  workspaceOwnerIds,
  workspaceRoleOf,
  workspacesHiddenFromApp,
} from "@/server/access";
import { loadLookups } from "@/server/activity-lookups";
import { runsAnsweredBy } from "@/server/agents/approvers";
import { inboxProposals } from "@/server/agents/memory";
import { agentUserIds, isAgentUser, notAgentUser } from "@/server/agents/users";
import { getCollab } from "@/server/collab/bridge";
import { mailStatus } from "@/server/mail";
import { requestLocale } from "@/server/mail/locale";
import { rowMailAccess } from "@/server/row-mail/access";
import { inboxKinds } from "@/server/notification-preferences";
import { propertyAccessFor } from "@/server/property-access";
import { pushNotifications } from "@/server/push";
import { snippetOf } from "@/server/semantic-text";
import { canInviteGuests } from "@/server/workspaces";
import { countPendingFor } from "@/server/pending-changes";
import { startSweep } from "@/server/sweep";

/**
 * The in-app inbox: one list per user and workspace. Sidebars in a workspace listen on its signal
 * channel and refetch their own inbox on "inbox", so nothing about the notification itself is
 * broadcast. Agents' users (see server/agents/users.ts) have no inbox: nothing here notifies them,
 * and so no email about a notification goes to them either.
 */

export const INBOX_EVENT = "inbox";
/** The inbox shows the latest notifications only. */
const INBOX_LIMIT = 50;
/** How long a share waits before its email goes out, so undoing it right away sends nothing. */
export const SHARE_EMAIL_DELAY_MS = 10_000;

type Change = { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> };

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function signal(workspaceId: string) {
  getCollab().broadcast(`ws:${workspaceId}`, INBOX_EVENT);
}

/** Tells the workspace's sidebars to refetch their inbox, after notifications went away some other way. */
export const signalInbox = signal;

/**
 * Notifies people someone else newly assigned to rows, and takes back unread notifications of
 * anyone the changes unassign, so a mis-click fixed right away leaves nothing behind. Never throws:
 * the edit itself already went through.
 */
export async function recordAssignments(actorId: string | null, workspaceId: string, personProps: { id: string }[], changes: Change[]) {
  try {
    const removed = changes.flatMap((c) =>
      personProps.flatMap((prop) => {
        const kept = new Set(ids(c.after[prop.id]));
        return ids(c.before[prop.id])
          .filter((userId) => !kept.has(userId))
          .map((userId) => ({ userId, pageId: c.rowId, propertyId: prop.id }));
      }),
    );
    const assigned = changes.flatMap((c) =>
      newAssignees(personProps, c.before, c.after, actorId).map((a) => ({ ...a, pageId: c.rowId })),
    );
    const agents = await agentUserIds(assigned.map((a) => a.userId));
    const added = assigned.filter((a) => !agents.has(a.userId));
    if (!removed.length && !added.length) return;
    // Dropping the unread ones first also keeps a quick unassign/reassign down to one notification.
    const unread = [...removed, ...added].map((n) =>
      and(eq(notification.userId, n.userId), eq(notification.pageId, n.pageId), eq(notification.propertyId, n.propertyId)),
    );
    await db
      .delete(notification)
      .where(and(eq(notification.kind, "assignment"), isNull(notification.readAt), or(...unread)));
    const inserted = added.length
      ? await db
          .insert(notification)
          .values(
            added.map((a) => ({
              userId: a.userId,
              workspaceId,
              kind: "assignment" as const,
              actorId,
              pageId: a.pageId,
              propertyId: a.propertyId,
            })),
          )
          .returning({ id: notification.id })
      : [];
    signal(workspaceId);
    pushNotifications(inserted.map((n) => n.id));
  } catch (error) {
    console.error("could not record assignment notifications", error);
  }
}

/**
 * Tells `userId` that `actorId` shared a page with them, and queues the email about it. A share
 * changed again before it was read stays one notification. Never throws: the share went through.
 */
export async function recordShare(actorId: string, workspaceId: string, userId: string, pageId: string) {
  if (actorId === userId) return;
  try {
    if (await isAgentUser(userId)) return;
    const emailDueAt = mailStatus() === "disabled" ? null : new Date(Date.now() + SHARE_EMAIL_DELAY_MS);
    const emailLocale = await requestLocale();
    const inserted = await db.transaction(async (tx) => {
      await tx.delete(notification).where(unreadShare(userId, pageId));
      return tx
        .insert(notification)
        .values({ userId, workspaceId, kind: "page_shared", actorId, pageId, emailDueAt, emailLocale })
        .returning({ id: notification.id });
    });
    signal(workspaceId);
    pushNotifications(inserted.map((n) => n.id));
  } catch (error) {
    console.error("could not record share notification", error);
  }
}

/** Takes back the unread share notification (and its email) when that share is removed; never throws. */
export async function withdrawShare(workspaceId: string, userId: string, pageId: string) {
  try {
    const dropped = await db.delete(notification).where(unreadShare(userId, pageId)).returning({ id: notification.id });
    if (dropped.length) signal(workspaceId);
  } catch (error) {
    console.error("could not withdraw share notification", error);
  }
}

/**
 * Those of `userIds` who are people (not agents) and can open `pageId`, which must not be in the
 * trash: who may hear about something on the page.
 */
export async function pageRecipients(userIds: string[], pageId: string): Promise<string[]> {
  if (!userIds.length) return [];
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .innerJoin(page, eq(page.id, pageId))
    .where(and(inArray(user.id, userIds), notAgentUser(user.id), isNull(page.archivedAt), sql`page_access_level(${user.id}, ${page.id}) > 0`));
  return rows.map((r) => r.id);
}

/** How long a comment waits before its email goes out: replies in a lively thread add up to one email. */
export const COMMENT_EMAIL_DELAY_MS = 2 * 60_000;

/**
 * Tells people about a new comment in a thread. A thread someone hasn't read yet stays one
 * notification, moved up to the latest comment. Never throws: the comment went through. With
 * `notice`, it is about the thread's suggested edit instead (server/suggested-edits.ts): a new one,
 * or its answer, which is not emailed (the thread has no comment of the actor to quote).
 */
export async function recordComment(
  actorId: string,
  workspaceId: string,
  pageId: string,
  threadId: string,
  userIds: string[],
  notice?: SuggestionNotice,
) {
  const recipients = [...new Set(userIds)].filter((id) => id !== actorId);
  if (!recipients.length) return;
  try {
    // Only people who can still open the page hear about it.
    const visible = await pageRecipients(recipients, pageId);
    if (!visible.length) return;
    const emailDueAt =
      mailStatus() === "disabled" || (notice && notice !== "suggested") ? null : new Date(Date.now() + COMMENT_EMAIL_DELAY_MS);
    const emailLocale = await requestLocale();
    const inserted = await db.transaction(async (tx) => {
      await tx.delete(notification).where(
        and(
          eq(notification.kind, "comment"),
          // Copies of a page carry its threads, ids included.
          eq(notification.pageId, pageId),
          eq(notification.threadId, threadId),
          inArray(notification.userId, visible),
          isNull(notification.readAt),
        ),
      );
      return tx
        .insert(notification)
        .values(
          visible.map((userId) => ({ userId, workspaceId, kind: "comment" as const, actorId, pageId, threadId, emailDueAt, emailLocale, message: notice ?? null })),
        )
        .returning({ id: notification.id });
    });
    signal(workspaceId);
    pushNotifications(inserted.map((n) => n.id));
  } catch (error) {
    console.error("could not record comment notifications", error);
  }
}

/**
 * Takes back unread notifications about a thread that was deleted, and every reaction notification
 * about its comments (read ones too: they quote the comment); never throws.
 */
export async function withdrawComments(workspaceId: string, pageId: string, threadId: string) {
  try {
    const dropped = await db
      .delete(notification)
      .where(
        and(
          eq(notification.pageId, pageId),
          eq(notification.threadId, threadId),
          or(and(eq(notification.kind, "comment"), isNull(notification.readAt)), eq(notification.kind, "reaction")),
        ),
      )
      .returning({ id: notification.id });
    if (dropped.length) signal(workspaceId);
  } catch (error) {
    console.error("could not withdraw comment notifications", error);
  }
}

/**
 * The unread reaction notification of `userId` about comment `commentId` (in thread `threadId` of
 * page `pageId`), locked for the change; a snoozed one only when `snoozedToo`.
 */
const unreadReaction = (userId: string, pageId: string, threadId: string, commentId: string, snoozedToo: boolean) =>
  and(
    eq(notification.kind, "reaction"),
    eq(notification.userId, userId),
    eq(notification.pageId, pageId),
    eq(notification.threadId, threadId),
    eq(notification.commentId, commentId),
    isNull(notification.readAt),
    snoozedToo ? undefined : isNull(notification.snoozedUntil),
  );

/**
 * Tells `authorId` that `actorId` reacted with `emoji` to their comment `commentId`. While they
 * haven't read it, more reactions to the same comment go into the same notification, moved up to
 * the latest; a snoozed one waits for its time as it is. Only people who can open the page hear
 * about it (not agents), never about their own reactions, and never by email. Pushed (where the
 * author turned that on) only when the notification is new, not for each reaction it collects.
 * Never throws: the reaction went through.
 */
export async function recordReaction(
  actorId: string,
  workspaceId: string,
  { pageId, threadId, commentId, authorId, emoji, excerpt }: { pageId: string; threadId: string; commentId: string; authorId: string; emoji: string; excerpt: string },
) {
  if (actorId === authorId) return;
  try {
    if (!(await pageRecipients([authorId], pageId)).length) return;
    const reactor: Reactor = { userId: actorId, emoji };
    const inserted = await db.transaction(async (tx) => {
      const [earlier] = await tx
        .select({ id: notification.id, reactions: notification.reactions })
        .from(notification)
        .where(unreadReaction(authorId, pageId, threadId, commentId, false))
        .orderBy(desc(notification.createdAt))
        .limit(1)
        .for("update");
      if (earlier) {
        await tx
          .update(notification)
          .set({ reactions: addReactor(parseReactors(earlier.reactions), reactor), actorId, message: excerpt, createdAt: new Date() })
          .where(eq(notification.id, earlier.id));
        return [];
      }
      return tx
        .insert(notification)
        .values({ userId: authorId, workspaceId, kind: "reaction", actorId, pageId, threadId, commentId, reactions: [reactor], message: excerpt })
        .returning({ id: notification.id });
    });
    signal(workspaceId);
    pushNotifications(inserted.map((n) => n.id));
  } catch (error) {
    console.error("could not record reaction notification", error);
  }
}

/**
 * Takes `actorId`'s reaction with `emoji` back out of `authorId`'s unread notification about the
 * comment (snoozed or not), and the notification away once no reaction is left in it; never throws.
 */
export async function withdrawReaction(
  actorId: string,
  workspaceId: string,
  { pageId, threadId, commentId, authorId, emoji }: { pageId: string; threadId: string; commentId: string; authorId: string; emoji: string },
) {
  try {
    const changed = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: notification.id, reactions: notification.reactions })
        .from(notification)
        .where(unreadReaction(authorId, pageId, threadId, commentId, true))
        .for("update");
      for (const row of rows) {
        const left = removeReactor(parseReactors(row.reactions), { userId: actorId, emoji });
        if (!left.length) await tx.delete(notification).where(eq(notification.id, row.id));
        else await tx.update(notification).set({ reactions: left, actorId: left.at(-1)!.userId }).where(eq(notification.id, row.id));
      }
      return rows.length > 0;
    });
    if (changed) signal(workspaceId);
  } catch (error) {
    console.error("could not withdraw reaction notification", error);
  }
}

/** Takes back every notification about reactions to a comment that was deleted (they quote it); never throws. */
export async function withdrawReactions(workspaceId: string, pageId: string, threadId: string, commentId: string) {
  try {
    const dropped = await db
      .delete(notification)
      .where(
        and(
          eq(notification.kind, "reaction"),
          eq(notification.pageId, pageId),
          eq(notification.threadId, threadId),
          eq(notification.commentId, commentId),
        ),
      )
      .returning({ id: notification.id });
    if (dropped.length) signal(workspaceId);
  } catch (error) {
    console.error("could not withdraw reaction notifications", error);
  }
}

/** How long a mention waits before its email goes out, so taking it back right away sends nothing. */
export const MENTION_EMAIL_DELAY_MS = 60_000;

/**
 * Tells people they were mentioned on a page (see server/mentions.ts, which calls this once per new
 * mention). Only people who can open the page hear about it; an unread mention notification about
 * the same page is moved up to the latest mention, so a page mentioning someone often stays one
 * line in their inbox. Never throws: the page was saved.
 */
export async function recordMentions(
  actorId: string | null,
  workspaceId: string,
  pageId: string,
  mentions: { userId: string; mentionId: string }[],
  locale: string | null = null,
) {
  const first = new Map<string, string>();
  for (const m of mentions) if (m.userId !== actorId && !first.has(m.userId)) first.set(m.userId, m.mentionId);
  if (!first.size) return;
  try {
    const visible = await pageRecipients([...first.keys()], pageId);
    if (!visible.length) return;
    const emailDueAt = mailStatus() === "disabled" ? null : new Date(Date.now() + MENTION_EMAIL_DELAY_MS);
    const inserted = await db.transaction(async (tx) => {
      await tx.delete(notification).where(
        and(
          eq(notification.kind, "mention"),
          eq(notification.pageId, pageId),
          inArray(notification.userId, visible),
          isNull(notification.readAt),
        ),
      );
      return tx
        .insert(notification)
        .values(
          visible.map((userId) => ({
            userId,
            workspaceId,
            kind: "mention" as const,
            actorId,
            pageId,
            mentionId: first.get(userId)!,
            emailDueAt,
            emailLocale: locale,
          })),
        )
        .returning({ id: notification.id });
    });
    signal(workspaceId);
    pushNotifications(inserted.map((n) => n.id));
  } catch (error) {
    console.error("could not record mention notifications", error);
  }
}

/**
 * Takes back unread notifications about mentions that were removed from the page; returns the
 * mentions whose notification it took back. Never throws.
 */
export async function withdrawMentions(workspaceId: string, pageId: string, mentionIds: string[]): Promise<string[]> {
  if (!mentionIds.length) return [];
  try {
    const dropped = await db
      .delete(notification)
      .where(
        and(
          eq(notification.kind, "mention"),
          eq(notification.pageId, pageId),
          inArray(notification.mentionId, mentionIds),
          isNull(notification.readAt),
        ),
      )
      .returning({ mentionId: notification.mentionId });
    if (dropped.length) signal(workspaceId);
    return dropped.flatMap((d) => (d.mentionId ? [d.mentionId] : []));
  } catch (error) {
    console.error("could not withdraw mention notifications", error);
    return [];
  }
}

/**
 * A reminder the user set on the mentioned `date` fell due (see server/mentions.ts): tells them in
 * the inbox and, right away, by email, if they can still open the page.
 */
export async function recordReminder(userId: string, pageId: string, mentionId: string, date: string) {
  const [target] = await db
    .select({ workspaceId: page.workspaceId })
    .from(page)
    .where(and(eq(page.id, pageId), isNull(page.archivedAt), sql`page_access_level(${userId}, ${page.id}) > 0`))
    .limit(1);
  if (!target) return;
  const inserted = await db
    .insert(notification)
    .values({
      userId,
      workspaceId: target.workspaceId,
      kind: "reminder",
      actorId: null,
      pageId,
      mentionId,
      date,
      emailDueAt: mailStatus() === "disabled" ? null : new Date(),
    })
    .returning({ id: notification.id });
  signal(target.workspaceId);
  pushNotifications(inserted.map((n) => n.id));
}

/**
 * The user's verification of the page ends at `until`, soon or already (when `now` is at or past
 * it; see server/verification.ts): tells them in the inbox and, right away, by email, if they can
 * still open the page and it isn't in the trash.
 */
export async function recordVerificationReminder(userId: string, pageId: string, until: Date, now: Date = new Date()) {
  const [target] = await db
    .select({ workspaceId: page.workspaceId })
    .from(page)
    .where(and(eq(page.id, pageId), isNull(page.archivedAt), sql`${accessRank(userId, sql`${page.id}`)} > 0`))
    .limit(1);
  if (!target) return;
  const inserted = await db
    .insert(notification)
    .values({
      userId,
      workspaceId: target.workspaceId,
      kind: "verification",
      actorId: null,
      pageId,
      date: until.toISOString(),
      // Whether it says "ends" or "ended" reads from this against `date`.
      createdAt: now,
      emailDueAt: mailStatus() === "disabled" ? null : now,
    })
    .returning({ id: notification.id });
  signal(target.workspaceId);
  pushNotifications(inserted.map((n) => n.id));
}

/**
 * Tells everyone in the workspace with full access to the page that `requesterId` asked for access
 * (request `requestId`), and emails them right away. The email is in each approver's language, else
 * in the requester's (`locale`, see server/share-emails.ts). Returns who was told.
 */
export async function recordAccessRequest(
  workspaceId: string,
  pageId: string,
  requestId: string,
  requesterId: string,
  locale: string,
): Promise<string[]> {
  const approvers = await peopleWithFullAccess(workspaceId, pageId, requesterId);
  if (!approvers.length) return [];
  const emailDueAt = mailStatus() === "disabled" ? null : new Date();
  const inserted = await db
    .insert(notification)
    .values(
      approvers.map((id) => ({
        userId: id,
        workspaceId,
        kind: "access_request" as const,
        actorId: requesterId,
        pageId,
        accessRequestId: requestId,
        emailDueAt,
        emailLocale: locale,
      })),
    )
    .returning({ id: notification.id });
  signal(workspaceId);
  pushNotifications(inserted.map((n) => n.id));
  return approvers;
}

/**
 * Keeps the share email from going out: the requester whose access request was approved gets an
 * email about the answer instead. The share stays in their inbox.
 */
export async function skipShareEmail(userId: string, pageId: string) {
  await db
    .update(notification)
    .set({ emailDueAt: null })
    .where(and(unreadShare(userId, pageId), isNotNull(notification.emailDueAt)));
}

/**
 * Tells the workspace's owners (but the one who asked) that someone asks to join it or to invite
 * someone (see server/join-requests.ts), and queues the email about it. Never throws: the request
 * was filed, and the owners see it in Settings > Members either way.
 */
export async function recordJoinRequest(workspaceId: string, joinRequestId: string, actorId: string | null, locale: string | null) {
  try {
    const recipients = (await workspaceOwnerIds(workspaceId)).filter((id) => id !== actorId);
    if (!recipients.length) return;
    const emailDueAt = mailStatus() === "disabled" ? null : new Date();
    const inserted = await db
      .insert(notification)
      .values(
        recipients.map((userId) => ({
          userId,
          workspaceId,
          kind: "join_request" as const,
          actorId,
          joinRequestId,
          emailDueAt,
          emailLocale: locale,
        })),
      )
      .returning({ id: notification.id });
    signal(workspaceId);
    pushNotifications(inserted.map((n) => n.id));
  } catch (error) {
    console.error("could not record join request notifications", error);
  }
}

/** Takes back the owners' unread notifications (and emails) about a request once it is decided; never throws. */
export async function withdrawJoinRequest(workspaceId: string, joinRequestId: string) {
  try {
    const dropped = await db
      .delete(notification)
      .where(and(eq(notification.joinRequestId, joinRequestId), isNull(notification.readAt)))
      .returning({ id: notification.id });
    if (dropped.length) signal(workspaceId);
  } catch (error) {
    console.error("could not withdraw join request notifications", error);
  }
}

/**
 * Tells followers of row `pageId` what `actorId` changed in it (see server/row-follow.ts), each
 * about the changes given for them, and emails them right away (the changes already waited for
 * the burst of edits to end). An unread update by the same person about the same row is folded in
 * and moved up, so someone who doesn't look stays one line behind. Never throws.
 */
export async function recordRowUpdate(
  actorId: string,
  workspaceId: string,
  pageId: string,
  told: { userId: string; changes: RowUpdate }[],
  locale: string | null,
) {
  const recipients = told.filter((t) => t.userId !== actorId);
  if (!recipients.length) return;
  try {
    const emailDueAt = mailStatus() === "disabled" ? null : new Date();
    const inserted = await db.transaction(async (tx) => {
      const earlier = await tx
        .delete(notification)
        .where(
          and(
            eq(notification.kind, "row_update"),
            eq(notification.pageId, pageId),
            eq(notification.actorId, actorId),
            inArray(notification.userId, recipients.map((r) => r.userId)),
            isNull(notification.readAt),
            // A snoozed one waits for its time as it is; this update comes on its own.
            isNull(notification.snoozedUntil),
          ),
        )
        .returning({ userId: notification.userId, changes: notification.changes });
      const before = new Map(earlier.map((e) => [e.userId, parseRowUpdate(e.changes)]));
      const values = recipients.flatMap(({ userId, changes }) => {
        const merged = before.has(userId) ? mergeRowUpdates(before.get(userId)!, changes) : changes;
        if (isEmptyRowUpdate(merged)) return [];
        return [{ userId, workspaceId, kind: "row_update" as const, actorId, pageId, changes: merged, emailDueAt, emailLocale: locale }];
      });
      return values.length ? tx.insert(notification).values(values).returning({ id: notification.id }) : [];
    });
    signal(workspaceId);
    pushNotifications(inserted.map((n) => n.id));
  } catch (error) {
    console.error("could not record row update notifications", error);
  }
}

/**
 * Tells watchers of page `pageId` that `actorId` edited it (see server/page-watch.ts), and queues
 * the email about it, which server/share-emails.ts holds back to a cooldown per page and a daily
 * cap. An unread update about the same page, by anyone, is replaced and moved up, so a page someone
 * doesn't look at stays one line in their inbox. Never throws.
 */
export async function recordPageUpdate(actorId: string, workspaceId: string, pageId: string, userIds: string[], locale: string | null) {
  const recipients = [...new Set(userIds)].filter((id) => id !== actorId);
  if (!recipients.length) return;
  try {
    const emailDueAt = mailStatus() === "disabled" ? null : new Date();
    const inserted = await db.transaction(async (tx) => {
      await tx
        .delete(notification)
        .where(
          and(
            eq(notification.kind, "page_updated"),
            eq(notification.pageId, pageId),
            inArray(notification.userId, recipients),
            isNull(notification.readAt),
            // A snoozed one waits for its time as it is; this update comes on its own.
            isNull(notification.snoozedUntil),
          ),
        );
      return tx
        .insert(notification)
        .values(recipients.map((userId) => ({ userId, workspaceId, kind: "page_updated" as const, actorId, pageId, emailDueAt, emailLocale: locale })))
        .returning({ id: notification.id });
    });
    signal(workspaceId);
    pushNotifications(inserted.map((n) => n.id));
  } catch (error) {
    console.error("could not record page update notifications", error);
  }
}

/**
 * Tells `userIds` (the mailbox's owner, the row's followers and people; see server/row-mail) that
 * message `rowEmailId` came in on row `rowId`. Nothing is emailed: the message is in a mailbox
 * already. Never throws.
 */
export async function recordRowEmail(workspaceId: string, rowId: string, rowEmailId: string, userIds: string[]) {
  const recipients = [...new Set(userIds)];
  if (!recipients.length) return;
  try {
    const inserted = await db
      .insert(notification)
      .values(recipients.map((userId) => ({ userId, workspaceId, kind: "row_email" as const, pageId: rowId, rowEmailId })))
      .returning({ id: notification.id });
    signal(workspaceId);
    pushNotifications(inserted.map((n) => n.id));
  } catch (error) {
    console.error("could not record row email notifications", error);
  }
}

const unreadShare = (userId: string, pageId: string) =>
  and(
    eq(notification.kind, "page_shared"),
    eq(notification.userId, userId),
    eq(notification.pageId, pageId),
    isNull(notification.readAt),
  );

export type InboxItem = {
  id: string;
  kind: NotificationKind;
  workspaceId: string;
  workspaceName: string;
  createdAt: Date;
  read: boolean;
  actorId: string | null;
  actorName: string | null;
  /** The actor's profile picture (`user.image`), for the inbox's avatars. */
  actorImage: string | null;
  /** Null for join requests only. */
  pageId: string | null;
  pageTitle: string | null;
  pageIcon: string | null;
  /** Comments: the thread it is about. */
  threadId: string | null;
  databaseTitle: string | null;
  propertyName: string | null;
  /** Reminders: the date that fell due (YYYY-MM-DD; see notification.date). Automations: set for a "date passed" run. */
  reminderDate: string | null;
  /** Reminders on a date property: the zone a date's time reads in (whoever set the reminder's), when it has one. */
  reminderTimeZone: string | null;
  /** Automations: the name of the automation that sent it (`pageId` is the row, `databaseTitle` its database). */
  automationName: string | null;
  /** Automations: the message its notify step wrote, if any. */
  automationMessage: string | null;
  /** Access requests: what the user needs to answer it. */
  accessRequest: InboxAccessRequest | null;
  /** Join requests: someone asking to join, or a member asking to invite `requestEmail`. */
  requestKind: JoinRequestKind | null;
  requestEmail: string | null;
  /** Agent approvals: the call an agent waits to make, while it still waits. */
  approval: InboxApproval | null;
  /** Agents' notes: what the run proposed for the agent's memory, while some of it still waits. */
  memory: InboxAgentMemory | null;
  /** A scheduled run's report: how the run ended and what the agent said. */
  report: InboxAgentReport | null;
  /** Row updates: what changed in the row, of what the user may see in it now. */
  rowUpdate: InboxRowUpdate | null;
  /** Row emails: the message that came in on the row (`pageId`). */
  rowEmail: InboxRowEmail | null;
  /** Changes waiting for review: how many the user could answer now (the item shows while there are any). */
  review: { count: number } | null;
  /** Follow-ups: the sequence of the row (`pageId`) whose next email didn't pass the check. */
  followUp: { sequence: string } | null;
  /** Reactions: to which comment of thread `threadId`, with what and by whom (the latest first). */
  reaction: InboxReaction | null;
  /** Comments: when it is about the thread's suggested edit, what happened to it (lib/suggestions). */
  suggestion: SuggestionNotice | null;
};

export type InboxReaction = {
  commentId: string;
  emojis: string[];
  people: { id: string; name: string; image: string | null }[];
  /** The start of the comment, as it read when reacted to. */
  excerpt: string;
};

export type InboxRowEmail = { id: string; from: string; subject: string; snippet: string };

/** How much of a message's text the inbox shows. */
const EMAIL_SNIPPET_CHARS = 160;

/** A change of a row someone follows, as the inbox shows it: "Status: To do → Done". */
export type InboxRowChange = {
  /** Null for the row's title. */
  property: { id: string; name: string; type: PropertyType } | null;
  from: ActivityValue;
  to: ActivityValue;
};

export type InboxRowUpdate = { changes: InboxRowChange[]; body: boolean };

export type InboxAgentReport = {
  runId: string;
  agentId: string;
  agentName: string;
  status: AgentRunStatus;
  code: AgentRunCode | null;
  /** The start of the agent's answer; null when the run looked after a database the user can no longer open. */
  text: string | null;
};

/** The most of a report the inbox shows; the whole of it is in the run. */
const REPORT_CHARS = 400;

export type InboxAgentMemory = {
  runId: string;
  agentId: string;
  agentName: string;
  /** How many of the run's proposals still wait for an owner. */
  count: number;
  /** The first one's text; null when the run was on a row the user can't open (see agents/memory.ts). */
  text: string | null;
};

export type InboxApproval = {
  runId: string;
  callId: string;
  agentId: string;
  agentName: string;
  connectionName: string;
  tool: string;
  /** The call's input, as JSON, credentials masked (cut to fit). */
  input: string;
  /** `input` is exactly what would be sent: it may be approved where shown, or else from its run. */
  whole: boolean;
  askedAt: string;
};

export type InboxAccessRequest = {
  id: string;
  /** Empty for a guest's inbox when the requester is in the workspace: guests don't learn members' addresses. */
  requesterEmail: string;
  message: string | null;
  /** What they asked for: "view" is any access (from the no-access screen). */
  level: RequestedLevel;
  /** What they have now: none, or less than `level` for those asking for more. */
  current: PageLevel;
  /** The requester is in the workspace (as a member or guest); otherwise approving adds them as a guest. */
  inWorkspace: boolean;
  /** The user may approve it: always for people in the workspace, for others when they may invite guests. */
  approvable: boolean;
};

const databasePage = alias(page, "database_page");
const actor = alias(user, "actor");

/**
 * Notifications about pages the user can still open, of the kinds they keep in their inbox; ones
 * for trashed or unshared pages stay hidden. Access requests show only while the user can answer
 * them (full access) and the requester still can't open the page; join requests and what agents
 * leave for an owner (none has a page) only while the user owns the workspace; snoozed ones not
 * until their time. Null when every kind is off. Expects `page` left-joined.
 */
async function inboxFilter(userId: string, workspaceId?: string, only?: NotificationKind[]): Promise<SQL | null> {
  const kinds = (await inboxKinds(userId)).filter((k) => !only || only.includes(k));
  if (!kinds.length) return null;
  return and(
    eq(notification.userId, userId),
    workspaceId ? eq(notification.workspaceId, workspaceId) : undefined,
    inArray(notification.kind, kinds),
    // Snoozed ones come back by themselves (deliverSnoozed); until then they aren't there.
    or(isNull(notification.snoozedUntil), lte(notification.snoozedUntil, sql`now()`)),
    // A message hidden from its row leaves the inbox too.
    or(
      ne(notification.kind, "row_email"),
      sql`exists (select 1 from ${rowEmail} where ${rowEmail.id} = ${notification.rowEmailId} and ${rowEmail.status} <> 'hidden')`,
    ),
    or(
      and(
        isNotNull(page.id),
        isNull(page.archivedAt),
        pageVisibleTo(userId),
        or(
          ne(notification.kind, "access_request"),
          and(
            sql`page_access_level(${userId}, ${page.id}) = ${FULL_RANK}`,
            isNotNull(notification.actorId),
            // The requester still has less than they asked for (see server/access-requests).
            sql`exists (select 1 from ${accessRequest} where ${accessRequest.id} = ${notification.accessRequestId} and page_access_level(${accessRequest.requesterId}, ${accessRequest.pageId}) < ${rankOf(accessRequest.level)})`,
          ),
        ),
      ),
      and(inArray(notification.kind, ["join_request", ...OWNER_KINDS]), ownsWorkspace(userId, notification.workspaceId)),
      // Changes waiting for review have no page: they show while the user is in the workspace.
      and(eq(notification.kind, "review"), inWorkspace(sql`${userId}`, notification.workspaceId)),
    ),
  )!;
}

/**
 * The user's notifications, newest first: in one workspace, or in all of them (MCP). Visibility
 * follows the page, so a workspace the user left shows nothing. With `ids`, only those, as the
 * inbox would show them (push notifications, see server/push.ts).
 */
export async function listNotifications(
  userId: string,
  {
    workspaceId,
    unreadOnly = false,
    limit = INBOX_LIMIT,
    ids: only,
    kinds,
  }: { workspaceId?: string; unreadOnly?: boolean; limit?: number; ids?: string[]; kinds?: NotificationKind[] } = {},
): Promise<InboxItem[]> {
  if (only && !only.length) return [];
  if (workspaceId) await requireMembership(userId, workspaceId);
  const [filter, hidden] = await Promise.all([
    inboxFilter(userId, workspaceId, kinds),
    workspaceId || only ? new Set<string>() : workspacesHiddenFromApp(userId),
  ]);
  if (!filter) return [];
  const rows = await db
    .select({
      id: notification.id,
      kind: notification.kind,
      workspaceId: notification.workspaceId,
      workspaceName: workspace.name,
      createdAt: notification.createdAt,
      readAt: notification.readAt,
      actorId: notification.actorId,
      actorName: actor.name,
      actorImage: actor.image,
      pageId: page.id,
      pageTitle: page.title,
      pageIcon: page.icon,
      threadId: notification.threadId,
      // A row can be shared without its database: then the database's name stays hidden too.
      databaseTitle: sql<string | null>`case when page_access_level(${userId}, ${databasePage.id}) > 0 then ${databasePage.title} end`,
      propertyName: databaseProperty.name,
      reminderDate: notification.date,
      reminderTimeZone: sql<string | null>`${databaseProperty.options}->'date'->'reminder'->>'timeZone'`,
      automationName: databaseAutomation.name,
      automationMessage: notification.message,
      requestKind: workspaceJoinRequest.kind,
      requestEmail: workspaceJoinRequest.email,
      actorEmail: actor.email,
      requestId: accessRequest.id,
      requestMessage: accessRequest.message,
      requestLevel: accessRequest.level,
      requesterLevel: sql<number | null>`page_access_level(${accessRequest.requesterId}, ${accessRequest.pageId})`,
      requesterRole: workspaceRoleOf(accessRequest.requesterId, accessRequest.workspaceId),
      agentRunId: notification.agentRunId,
      rowDatabaseId: page.parentId,
      rowCreatedBy: page.createdBy,
      rowProperties: page.properties,
      changes: notification.changes,
      rowEmailId: notification.rowEmailId,
      followUpSequence: emailSequence.name,
      commentId: notification.commentId,
      reactions: notification.reactions,
    })
    .from(notification)
    .leftJoin(page, eq(page.id, notification.pageId))
    .innerJoin(workspace, eq(workspace.id, notification.workspaceId))
    .leftJoin(workspaceJoinRequest, eq(workspaceJoinRequest.id, notification.joinRequestId))
    .leftJoin(databasePage, and(eq(databasePage.id, page.parentId), eq(databasePage.kind, "database")))
    .leftJoin(actor, eq(actor.id, notification.actorId))
    .leftJoin(databaseProperty, eq(databaseProperty.id, notification.propertyId))
    .leftJoin(accessRequest, eq(accessRequest.id, notification.accessRequestId))
    .leftJoin(databaseAutomation, eq(databaseAutomation.id, notification.automationId))
    .leftJoin(sequenceEnrollment, eq(sequenceEnrollment.id, notification.sequenceEnrollmentId))
    .leftJoin(emailSequence, eq(emailSequence.id, sequenceEnrollment.sequenceId))
    .where(
      and(
        filter,
        only ? inArray(notification.id, only) : undefined,
        unreadOnly ? isNull(notification.readAt) : undefined,
        // All workspaces (MCP): not those whose owners hid them from connected apps.
        hidden.size ? notInArray(notification.workspaceId, [...hidden]) : undefined,
      ),
    )
    .orderBy(desc(notification.createdAt))
    .limit(limit);
  // Guests don't learn the addresses of people in the workspace (see listAccessRequests).
  const guestIn = new Map<string, Promise<boolean>>();
  const isGuestIn = (id: string) => {
    if (!guestIn.has(id)) guestIn.set(id, findMembership(userId, id).then((m) => m?.role === "guest"));
    return guestIn.get(id)!;
  };
  // Approving someone from outside brings them in as a guest, which not everyone may do.
  const inviting = new Map<string, Promise<boolean>>();
  const mayInvite = (id: string) => {
    if (!inviting.has(id)) inviting.set(id, canInviteGuests(userId, id));
    return inviting.get(id)!;
  };
  const runsOf = (kind: NotificationKind) => rows.flatMap((r) => (r.kind === kind && r.agentRunId ? [r.agentRunId] : []));
  const reviewWorkspaces = [...new Set(rows.filter((r) => r.kind === "review").map((r) => r.workspaceId))];
  const [approvals, proposals, reports, updates, emails, reviews, reactions] = await Promise.all([
    approvalsOf(userId, runsOf("agent_approval")),
    inboxProposals(userId, runsOf("agent_memory")),
    reportsOf(userId, runsOf("agent_report")),
    rowUpdatesOf(userId, rows.filter((r) => r.kind === "row_update")),
    rowEmailsOf(userId, rows.filter((r) => r.kind === "row_email")),
    Promise.all(reviewWorkspaces.map(async (id) => [id, await countPendingFor(userId, id)] as const)).then((counts) => new Map(counts)),
    reactionsOf(rows.filter((r) => r.kind === "reaction")),
  ]);
  // A row update with nothing left the user may see (a property's access changed since) isn't shown,
  // nor a call the user no longer answers (they can't open its row any more).
  const shown = rows.filter(
    (r) =>
      (r.kind !== "row_update" || updates.has(r.id)) &&
      // Nor a message the user may no longer read (the email property's access changed since).
      (r.kind !== "row_email" || emails.has(r.id)) &&
      // Nor changes for review once none waits for the user any more.
      (r.kind !== "review" || (reviews.get(r.workspaceId) ?? 0) > 0) &&
      !(r.kind === "agent_approval" && r.agentRunId && approvals.get(r.agentRunId) === null),
  );
  return Promise.all(
    shown.map(async ({ readAt, actorEmail, actorImage, requestId, requestMessage, requestLevel, requesterLevel, requesterRole, agentRunId, rowDatabaseId, rowCreatedBy, rowProperties, changes, rowEmailId, followUpSequence, commentId, reactions: _reactions, automationMessage, ...row }) => ({
      ...row,
      actorImage: avatarSrc(actorImage),
      // A reaction's message is the comment it quotes (see reaction below), a comment's what became of its suggestion.
      automationMessage: row.kind === "reaction" || row.kind === "comment" ? null : automationMessage,
      suggestion: row.kind === "comment" && isSuggestionNotice(automationMessage) ? automationMessage : null,
      reaction: reactions.get(row.id) ?? null,
      rowUpdate: updates.get(row.id) ?? null,
      rowEmail: emails.get(row.id) ?? null,
      review: row.kind === "review" ? { count: reviews.get(row.workspaceId) ?? 0 } : null,
      followUp: row.kind === "follow_up" ? { sequence: followUpSequence ?? "" } : null,
      read: readAt !== null,
      approval: agentRunId && row.kind === "agent_approval" ? (approvals.get(agentRunId) ?? null) : null,
      memory: agentRunId && row.kind === "agent_memory" ? (proposals.get(agentRunId) ?? null) : null,
      report: agentRunId && row.kind === "agent_report" ? (reports.get(agentRunId) ?? null) : null,
      accessRequest:
        row.kind === "access_request" && requestId
          ? {
              id: requestId,
              requesterEmail: requesterRole !== null && (await isGuestIn(row.workspaceId)) ? "" : (actorEmail ?? ""),
              message: requestMessage,
              level: requestLevel ?? "view",
              current: levelFromRank(requesterLevel),
              inWorkspace: requesterRole !== null,
              approvable: requesterRole !== null || (await mayInvite(row.workspaceId)),
            }
          : null,
    })),
  );
}

/** What these reaction notifications tell: who reacted with what, the latest first, and to which comment. */
async function reactionsOf(rows: { id: string; commentId: string | null; reactions: unknown; automationMessage: string | null }[]) {
  const out = new Map<string, InboxReaction>();
  const summaries = rows.flatMap((r) => (r.commentId ? [{ row: r, commentId: r.commentId, ...reactionSummary(parseReactors(r.reactions)) }] : []));
  const ids = [...new Set(summaries.flatMap((s) => s.userIds))];
  if (!ids.length) return out;
  const people = new Map(
    (await db.select({ id: user.id, name: user.name, image: user.image }).from(user).where(inArray(user.id, ids))).map((p) => [
      p.id,
      { id: p.id, name: p.name, image: avatarSrc(p.image) },
    ]),
  );
  for (const s of summaries) {
    out.set(s.row.id, {
      commentId: s.commentId,
      emojis: s.emojis,
      people: s.userIds.flatMap((id) => people.get(id) ?? []),
      excerpt: s.row.automationMessage ?? "",
    });
  }
  return out;
}

/** The messages these row emails in `viewer`'s inbox are about, of those they may still read. */
async function rowEmailsOf(viewer: string, rows: { id: string; pageId: string | null; rowEmailId: string | null }[]) {
  const out = new Map<string, InboxRowEmail>();
  const ids = rows.flatMap((r) => (r.rowEmailId ? [r.rowEmailId] : []));
  if (!ids.length) return out;
  const messages = await db
    .select({ id: rowEmail.id, rowId: rowEmail.rowId, fromAddress: rowEmail.fromAddress, fromName: rowEmail.fromName, subject: rowEmail.subject, text: rowEmail.text })
    .from(rowEmail)
    .where(inArray(rowEmail.id, ids));
  const byId = new Map(messages.map((m) => [m.id, m]));
  const readable = new Map<string, Promise<boolean>>();
  for (const r of rows) {
    const message = r.rowEmailId ? byId.get(r.rowEmailId) : undefined;
    if (!message) continue;
    if (!readable.has(message.rowId)) readable.set(message.rowId, rowMailAccess(viewer, message.rowId).then(Boolean));
    if (!(await readable.get(message.rowId))) continue;
    out.set(r.id, {
      id: message.id,
      from: message.fromName?.trim() || message.fromAddress,
      subject: message.subject,
      snippet: message.text.replace(/\s+/g, " ").trim().slice(0, EMAIL_SNIPPET_CHARS),
    });
  }
  return out;
}

/**
 * What these row updates in `viewer`'s inbox tell, of the properties they may see in each row now
 * (the access they had when told may have been narrowed since), values read as for them. Updates
 * with nothing left to tell are left out.
 */
async function rowUpdatesOf(
  viewer: string,
  rows: {
    id: string;
    rowDatabaseId: string | null;
    rowCreatedBy: string | null;
    rowProperties: Record<string, unknown> | null;
    changes: RowUpdate | null;
  }[],
): Promise<Map<string, InboxRowUpdate>> {
  const out = new Map<string, InboxRowUpdate>();
  const databaseIds = [...new Set(rows.flatMap((r) => (r.rowDatabaseId ? [r.rowDatabaseId] : [])))];
  if (!databaseIds.length) return out;
  const [properties, accesses] = await Promise.all([
    db
      .select({
        id: databaseProperty.id,
        databaseId: databaseProperty.databaseId,
        name: databaseProperty.name,
        type: databaseProperty.type,
        options: databaseProperty.options,
        deletedAt: databaseProperty.deletedAt,
      })
      .from(databaseProperty)
      .where(inArray(databaseProperty.databaseId, databaseIds)),
    Promise.all(databaseIds.map(async (id) => [id, await propertyAccessFor(viewer, id)] as const)),
  ]);
  const access = new Map(accesses);
  const byId = new Map(properties.map((p) => [p.id, p]));
  const visible = rows.flatMap((r) => {
    if (!r.rowDatabaseId) return [];
    const row = { properties: r.rowProperties ?? {}, createdBy: r.rowCreatedBy };
    const readable = readableProperties(
      properties.filter((p) => p.databaseId === r.rowDatabaseId),
      access.get(r.rowDatabaseId)!,
      row,
    );
    const update = visibleRowUpdate(parseRowUpdate(r.changes), readable);
    return isEmptyRowUpdate(update) ? [] : [{ id: r.id, update }];
  });
  const ids = referencedIds(
    visible.flatMap(({ update }) =>
      update.changes.flatMap((c) => [
        { type: c.propertyType, value: c.from },
        { type: c.propertyType, value: c.to },
      ]),
    ),
  );
  const lookups = await loadLookups(viewer, [...ids.people], [...ids.pages]);
  for (const { id, update } of visible) {
    out.set(id, {
      body: update.body,
      changes: update.changes.map((c) => {
        const prop = c.propertyId ? byId.get(c.propertyId) : undefined;
        const read = (value: unknown) =>
          prop ? resolveValue(c.propertyType ?? prop.type, prop.options.options ?? [], value, lookups) : resolveValue("text", [], value, lookups);
        return { property: prop ? { id: prop.id, name: prop.name, type: prop.type } : null, from: read(c.from), to: read(c.to) };
      }),
    });
  }
  return out;
}

/**
 * What row update `notificationId` tells `viewer` now (see rowUpdatesOf), with the row's database
 * title when they can open it; null when nothing of it is left for them. For its email.
 */
export async function rowUpdateFor(viewer: string, notificationId: string) {
  const [row] = await db
    .select({
      id: notification.id,
      rowDatabaseId: page.parentId,
      rowCreatedBy: page.createdBy,
      rowProperties: page.properties,
      changes: notification.changes,
      databaseTitle: sql<string | null>`case when page_access_level(${viewer}, ${databasePage.id}) > 0 then ${databasePage.title} end`,
    })
    .from(notification)
    .innerJoin(page, eq(page.id, notification.pageId))
    .leftJoin(databasePage, and(eq(databasePage.id, page.parentId), eq(databasePage.kind, "database")))
    .where(and(eq(notification.id, notificationId), eq(notification.userId, viewer), eq(notification.kind, "row_update")));
  if (!row) return null;
  const update = (await rowUpdatesOf(viewer, [row])).get(row.id);
  return update ? { ...update, databaseTitle: row.databaseTitle } : null;
}

/** How these scheduled runs ended, for their reports in `viewer`'s inbox. */
async function reportsOf(viewer: string, runIds: string[]): Promise<Map<string, InboxAgentReport>> {
  if (!runIds.length) return new Map();
  const runs = await db
    .select({
      id: agentRun.id,
      status: agentRun.status,
      code: agentRun.code,
      answer: agentRun.answer,
      source: agentRun.source,
      agentId: agentRun.agentId,
      agentName: workspaceAgent.name,
    })
    .from(agentRun)
    .innerJoin(workspaceAgent, eq(workspaceAgent.id, agentRun.agentId))
    .where(inArray(agentRun.id, runIds));
  const databaseIds = [...new Set(runs.flatMap((r) => (isScheduleRun(r.source) && r.source.databaseId ? [r.source.databaseId] : [])))];
  const open = new Set(
    databaseIds.length ? (await db.select({ id: page.id }).from(page).where(and(inArray(page.id, databaseIds), pageVisibleTo(viewer)))).map((p) => p.id) : [],
  );
  const out = new Map<string, InboxAgentReport>();
  for (const r of runs) {
    // What it says may quote the database: only for those who can still open it.
    const hidden = isScheduleRun(r.source) && Boolean(r.source.databaseId) && !open.has(r.source.databaseId!);
    out.set(r.id, {
      runId: r.id,
      agentId: r.agentId,
      agentName: r.agentName,
      status: r.status,
      code: r.code ?? null,
      text: hidden ? null : snippetOf(r.answer, REPORT_CHARS),
    });
  }
  return out;
}

/**
 * The calls these runs wait on, for `viewer` to answer (runs no longer waiting are left out); null
 * for a call that waits for other owners than them (agents/approvers).
 */
async function approvalsOf(viewer: string, runIds: string[]): Promise<Map<string, InboxApproval | null>> {
  if (!runIds.length) return new Map();
  const runs = await db
    .select({
      id: agentRun.id,
      source: agentRun.source,
      pending: agentRun.pending,
      // The calls to send, as the agent made them: to tell whether the masked input is all of it.
      queue: sql<AgentRunState["queue"] | null>`${agentRun.state}->'queue'`,
      agentId: agentRun.agentId,
      agentName: workspaceAgent.name,
    })
    .from(agentRun)
    .innerJoin(workspaceAgent, eq(workspaceAgent.id, agentRun.agentId))
    .where(and(inArray(agentRun.id, runIds), eq(agentRun.status, "awaiting_approval")));
  const connectionIds = [...new Set(runs.flatMap((r) => (r.pending?.connectionId ? [r.pending.connectionId] : [])))];
  const names = new Map(
    connectionIds.length ? (await db.select({ id: connection.id, name: connection.name }).from(connection).where(inArray(connection.id, connectionIds))).map((c) => [c.id, c.name]) : [],
  );
  const answered = await runsAnsweredBy(viewer, runs);
  const out = new Map<string, InboxApproval | null>();
  for (const r of runs) {
    if (!r.pending) continue;
    if (!answered.has(r.id)) {
      out.set(r.id, null);
      continue;
    }
    const { input, whole } = inboxCallInput(r.pending.arguments, callToSend(r.pending, r.queue));
    out.set(r.id, {
      runId: r.id,
      callId: r.pending.callId,
      agentId: r.agentId,
      agentName: r.agentName,
      connectionName: callConnectionName(r.pending.connectionId, names),
      tool: r.pending.tool,
      input,
      whole,
      askedAt: r.pending.askedAt,
    });
  }
  return out;
}

export async function listInbox(userId: string, workspaceId: string, kinds?: NotificationKind[]): Promise<InboxItem[]> {
  return listNotifications(userId, { workspaceId, kinds });
}

export async function unreadCount(userId: string, workspaceId: string, kinds?: NotificationKind[]) {
  await requireMembership(userId, workspaceId);
  const filter = await inboxFilter(userId, workspaceId, kinds);
  if (!filter) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(notification)
    .leftJoin(page, eq(page.id, notification.pageId))
    .where(and(filter, isNull(notification.readAt)));
  return row?.n ?? 0;
}

/** The longest a notification can be snoozed for. */
const MAX_SNOOZE_MS = 30 * 86_400_000;

/**
 * Snoozes one of the user's notifications until `until` (within MAX_SNOOZE_MS): it leaves the
 * inbox, its email (if it hasn't gone yet) waits too (see share-emails), and at `until` it comes
 * back unread at the top and is pushed again (see deliverSnoozed). Returns false when there is no such notification or
 * the time is out of range.
 */
export async function snoozeNotification(userId: string, notificationId: string, until: Date, now = new Date()) {
  const time = until.getTime();
  if (!Number.isFinite(time) || time <= now.getTime() || time > now.getTime() + MAX_SNOOZE_MS) return false;
  const [row] = await db
    .update(notification)
    .set({ snoozedUntil: until, readAt: null })
    .where(and(eq(notification.id, notificationId), eq(notification.userId, userId), notInArray(notification.kind, [...UNSNOOZABLE_KINDS])))
    .returning({ workspaceId: notification.workspaceId });
  if (!row) return false;
  signal(row.workspaceId);
  return true;
}

/** Brings back the notifications whose snooze ran out (see snoozeNotification). Returns how many. */
export async function deliverSnoozed(now = new Date()) {
  const woken = await db
    .update(notification)
    .set({ snoozedUntil: null, readAt: null, createdAt: sql`${notification.snoozedUntil}` })
    .where(lte(notification.snoozedUntil, now))
    .returning({ id: notification.id, workspaceId: notification.workspaceId });
  for (const workspaceId of new Set(woken.map((n) => n.workspaceId))) signal(workspaceId);
  if (woken.length) pushNotifications(woken.map((n) => n.id));
  return woken.length;
}

/** How often snoozed notifications are looked for. */
const SNOOZE_SWEEP_MS = 30_000;

/** Wakes snoozed notifications every SNOOZE_SWEEP_MS. Returns a function that stops it. */
export function startSnoozes() {
  return startSweep(SNOOZE_SWEEP_MS, () => deliverSnoozed(), "snoozed notifications failed");
}

/** Marks the given notifications (or, without ids, the whole inbox) read. */
export async function markRead(userId: string, workspaceId: string, notificationIds?: string[]) {
  await requireMembership(userId, workspaceId);
  if (notificationIds && !notificationIds.length) return;
  await db
    .update(notification)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notification.userId, userId),
        eq(notification.workspaceId, workspaceId),
        isNull(notification.readAt),
        notificationIds ? inArray(notification.id, notificationIds) : undefined,
      ),
    );
  // The user's other tabs update their count too.
  signal(workspaceId);
}

/**
 * Marks one of the user's notifications read, in whatever workspace it is (a push notification's
 * button, see api/notifications/[id]/read). Its email, if it hasn't gone yet, then doesn't go.
 * Returns false when the user has no such notification.
 */
export async function markNotificationRead(userId: string, notificationId: string) {
  const [row] = await db
    .select({ workspaceId: notification.workspaceId, readAt: notification.readAt })
    .from(notification)
    .where(and(eq(notification.id, notificationId), eq(notification.userId, userId)));
  if (!row) return false;
  if (!row.readAt) {
    await db
      .update(notification)
      .set({ readAt: new Date() })
      .where(and(eq(notification.id, notificationId), eq(notification.userId, userId), isNull(notification.readAt)));
    signal(row.workspaceId);
  }
  return true;
}

/**
 * Marks the given notifications unread again (a swipe in the inbox on a phone). An email still to
 * come about one goes out as for any unread notification; one that went, or was left out because
 * it had been read, doesn't come again.
 */
export async function markUnread(userId: string, workspaceId: string, notificationIds: string[]) {
  await requireMembership(userId, workspaceId);
  if (!notificationIds.length) return;
  await db
    .update(notification)
    .set({ readAt: null })
    .where(
      and(
        eq(notification.userId, userId),
        eq(notification.workspaceId, workspaceId),
        isNotNull(notification.readAt),
        inArray(notification.id, notificationIds),
      ),
    );
  signal(workspaceId);
}
