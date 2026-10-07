import { and, count, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  accessRequest,
  databaseAutomation,
  databaseProperty,
  notification,
  page,
  pageReminder,
  user,
  workspace,
  workspaceJoinRequest,
  type JoinRequestKind,
  type NotificationKind,
} from "@/db/schema";
import { newAssignees } from "@/lib/properties";
import {
  FULL_RANK,
  ownsWorkspace,
  pageVisibleTo,
  peopleWithFullAccess,
  requireMembership,
  workspaceOwnerIds,
  workspaceRoleOf,
  workspacesHiddenFromApp,
} from "@/server/access";
import { agentUserIds, isAgentUser, notAgentUser } from "@/server/agents/users";
import { getCollab } from "@/server/collab/bridge";
import { mailStatus } from "@/server/mail";
import { requestLocale } from "@/server/mail/locale";
import { inboxKinds } from "@/server/notification-preferences";
import { canInviteGuests } from "@/server/workspaces";

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
    if (added.length) {
      await db.insert(notification).values(
        added.map((a) => ({
          userId: a.userId,
          workspaceId,
          kind: "assignment" as const,
          actorId,
          pageId: a.pageId,
          propertyId: a.propertyId,
        })),
      );
    }
    signal(workspaceId);
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
    await db.transaction(async (tx) => {
      await tx.delete(notification).where(unreadShare(userId, pageId));
      await tx
        .insert(notification)
        .values({ userId, workspaceId, kind: "page_shared", actorId, pageId, emailDueAt, emailLocale });
    });
    signal(workspaceId);
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

/** How long a comment waits before its email goes out: replies in a lively thread add up to one email. */
export const COMMENT_EMAIL_DELAY_MS = 2 * 60_000;

/**
 * Tells people about a new comment in a thread. A thread someone hasn't read yet stays one
 * notification, moved up to the latest comment. Never throws: the comment went through.
 */
export async function recordComment(actorId: string, workspaceId: string, pageId: string, threadId: string, userIds: string[]) {
  const recipients = [...new Set(userIds)].filter((id) => id !== actorId);
  if (!recipients.length) return;
  try {
    // Only people who can still open the page hear about it.
    const visible = await db
      .select({ id: user.id })
      .from(user)
      .innerJoin(page, eq(page.id, pageId))
      .where(and(inArray(user.id, recipients), notAgentUser(user.id), isNull(page.archivedAt), sql`page_access_level(${user.id}, ${page.id}) > 0`));
    if (!visible.length) return;
    const emailDueAt = mailStatus() === "disabled" ? null : new Date(Date.now() + COMMENT_EMAIL_DELAY_MS);
    const emailLocale = await requestLocale();
    await db.transaction(async (tx) => {
      await tx.delete(notification).where(
        and(
          eq(notification.kind, "comment"),
          // Copies of a page carry its threads, ids included.
          eq(notification.pageId, pageId),
          eq(notification.threadId, threadId),
          inArray(notification.userId, visible.map((v) => v.id)),
          isNull(notification.readAt),
        ),
      );
      await tx.insert(notification).values(
        visible.map((v) => ({ userId: v.id, workspaceId, kind: "comment" as const, actorId, pageId, threadId, emailDueAt, emailLocale })),
      );
    });
    signal(workspaceId);
  } catch (error) {
    console.error("could not record comment notifications", error);
  }
}

/** Takes back unread notifications about a thread that was deleted; never throws. */
export async function withdrawComments(workspaceId: string, pageId: string, threadId: string) {
  try {
    const dropped = await db
      .delete(notification)
      .where(
        and(
          eq(notification.kind, "comment"),
          eq(notification.pageId, pageId),
          eq(notification.threadId, threadId),
          isNull(notification.readAt),
        ),
      )
      .returning({ id: notification.id });
    if (dropped.length) signal(workspaceId);
  } catch (error) {
    console.error("could not withdraw comment notifications", error);
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
    const visible = await db
      .select({ id: user.id })
      .from(user)
      .innerJoin(page, eq(page.id, pageId))
      .where(and(inArray(user.id, [...first.keys()]), notAgentUser(user.id), isNull(page.archivedAt), sql`page_access_level(${user.id}, ${page.id}) > 0`));
    if (!visible.length) return;
    const emailDueAt = mailStatus() === "disabled" ? null : new Date(Date.now() + MENTION_EMAIL_DELAY_MS);
    await db.transaction(async (tx) => {
      await tx.delete(notification).where(
        and(
          eq(notification.kind, "mention"),
          eq(notification.pageId, pageId),
          inArray(notification.userId, visible.map((v) => v.id)),
          isNull(notification.readAt),
        ),
      );
      await tx.insert(notification).values(
        visible.map((v) => ({
          userId: v.id,
          workspaceId,
          kind: "mention" as const,
          actorId,
          pageId,
          mentionId: first.get(v.id)!,
          emailDueAt,
          emailLocale: locale,
        })),
      );
    });
    signal(workspaceId);
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
 * A reminder the user set fell due (see server/mentions.ts): tells them in the inbox and, right
 * away, by email, if they can still open the page.
 */
export async function recordReminder(userId: string, pageId: string, mentionId: string) {
  const [target] = await db
    .select({ workspaceId: page.workspaceId })
    .from(page)
    .where(and(eq(page.id, pageId), isNull(page.archivedAt), sql`page_access_level(${userId}, ${page.id}) > 0`))
    .limit(1);
  if (!target) return;
  await db.insert(notification).values({
    userId,
    workspaceId: target.workspaceId,
    kind: "reminder",
    actorId: null,
    pageId,
    mentionId,
    emailDueAt: mailStatus() === "disabled" ? null : new Date(),
  });
  signal(target.workspaceId);
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
  await db.insert(notification).values(
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
  );
  signal(workspaceId);
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
    await db.insert(notification).values(
      recipients.map((userId) => ({
        userId,
        workspaceId,
        kind: "join_request" as const,
        actorId,
        joinRequestId,
        emailDueAt,
        emailLocale: locale,
      })),
    );
    signal(workspaceId);
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
  actorName: string | null;
  /** Null for join requests only. */
  pageId: string | null;
  pageTitle: string | null;
  pageIcon: string | null;
  databaseTitle: string | null;
  propertyName: string | null;
  /** Reminders: the date they were set on (YYYY-MM-DD). */
  reminderDate: string | null;
  /** Automations: the name of the automation that sent it (`pageId` is the row, `databaseTitle` its database). */
  automationName: string | null;
  /** Access requests: what the user needs to answer it. */
  accessRequest: InboxAccessRequest | null;
  /** Join requests: someone asking to join, or a member asking to invite `requestEmail`. */
  requestKind: JoinRequestKind | null;
  requestEmail: string | null;
};

export type InboxAccessRequest = {
  id: string;
  requesterEmail: string;
  message: string | null;
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
 * them (full access) and the requester still can't open the page; join requests (which have no
 * page) only while the user owns the workspace. Null when every kind is off. Expects `page`
 * left-joined.
 */
async function inboxFilter(userId: string, workspaceId?: string): Promise<SQL | null> {
  const kinds = await inboxKinds(userId);
  if (!kinds.length) return null;
  return and(
    eq(notification.userId, userId),
    workspaceId ? eq(notification.workspaceId, workspaceId) : undefined,
    inArray(notification.kind, kinds),
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
            sql`page_access_level(${notification.actorId}, ${page.id}) = 0`,
          ),
        ),
      ),
      and(eq(notification.kind, "join_request"), ownsWorkspace(userId, notification.workspaceId)),
    ),
  )!;
}

/**
 * The user's notifications, newest first: in one workspace, or in all of them (MCP). Visibility
 * follows the page, so a workspace the user left shows nothing.
 */
export async function listNotifications(
  userId: string,
  { workspaceId, unreadOnly = false, limit = INBOX_LIMIT }: { workspaceId?: string; unreadOnly?: boolean; limit?: number } = {},
): Promise<InboxItem[]> {
  if (workspaceId) await requireMembership(userId, workspaceId);
  const [filter, hidden] = await Promise.all([inboxFilter(userId, workspaceId), workspaceId ? new Set<string>() : workspacesHiddenFromApp(userId)]);
  if (!filter) return [];
  const rows = await db
    .select({
      id: notification.id,
      kind: notification.kind,
      workspaceId: notification.workspaceId,
      workspaceName: workspace.name,
      createdAt: notification.createdAt,
      readAt: notification.readAt,
      actorName: actor.name,
      pageId: page.id,
      pageTitle: page.title,
      pageIcon: page.icon,
      databaseTitle: databasePage.title,
      propertyName: databaseProperty.name,
      reminderDate: pageReminder.date,
      automationName: databaseAutomation.name,
      requestKind: workspaceJoinRequest.kind,
      requestEmail: workspaceJoinRequest.email,
      actorEmail: actor.email,
      requestId: accessRequest.id,
      requestMessage: accessRequest.message,
      requesterRole: workspaceRoleOf(accessRequest.requesterId, accessRequest.workspaceId),
    })
    .from(notification)
    .leftJoin(page, eq(page.id, notification.pageId))
    .innerJoin(workspace, eq(workspace.id, notification.workspaceId))
    .leftJoin(workspaceJoinRequest, eq(workspaceJoinRequest.id, notification.joinRequestId))
    .leftJoin(databasePage, and(eq(databasePage.id, page.parentId), eq(databasePage.kind, "database")))
    .leftJoin(actor, eq(actor.id, notification.actorId))
    .leftJoin(databaseProperty, eq(databaseProperty.id, notification.propertyId))
    .leftJoin(
      pageReminder,
      and(eq(notification.kind, "reminder"), eq(pageReminder.pageId, notification.pageId), eq(pageReminder.mentionId, notification.mentionId)),
    )
    .leftJoin(accessRequest, eq(accessRequest.id, notification.accessRequestId))
    .leftJoin(databaseAutomation, eq(databaseAutomation.id, notification.automationId))
    .where(
      and(
        filter,
        unreadOnly ? isNull(notification.readAt) : undefined,
        // All workspaces (MCP): not those whose owners hid them from connected apps.
        hidden.size ? notInArray(notification.workspaceId, [...hidden]) : undefined,
      ),
    )
    .orderBy(desc(notification.createdAt))
    .limit(limit);
  // Approving someone from outside brings them in as a guest, which not everyone may do.
  const inviting = new Map<string, Promise<boolean>>();
  const mayInvite = (id: string) => {
    if (!inviting.has(id)) inviting.set(id, canInviteGuests(userId, id));
    return inviting.get(id)!;
  };
  return Promise.all(
    rows.map(async ({ readAt, actorEmail, requestId, requestMessage, requesterRole, ...row }) => ({
      ...row,
      read: readAt !== null,
      accessRequest:
        row.kind === "access_request" && requestId
          ? {
              id: requestId,
              requesterEmail: actorEmail ?? "",
              message: requestMessage,
              inWorkspace: requesterRole !== null,
              approvable: requesterRole !== null || (await mayInvite(row.workspaceId)),
            }
          : null,
    })),
  );
}

export async function listInbox(userId: string, workspaceId: string): Promise<InboxItem[]> {
  return listNotifications(userId, { workspaceId });
}

export async function unreadCount(userId: string, workspaceId: string) {
  await requireMembership(userId, workspaceId);
  const filter = await inboxFilter(userId, workspaceId);
  if (!filter) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(notification)
    .leftJoin(page, eq(page.id, notification.pageId))
    .where(and(filter, isNull(notification.readAt)));
  return row?.n ?? 0;
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
