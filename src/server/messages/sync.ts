/**
 * What a client loads when it opens (`bootstrap`) and asks for after a lost connection (`sync`):
 * every change since its last `rev`, from the rows themselves, so nothing said while it was away is
 * missed (live changes are only a faster way to the same rows). What was deleted leaves no row to
 * find, so a sync also lists the ids that still exist of what a client keeps whole (channels,
 * memberships, drafts, saved messages, sections, scheduled messages) and it drops the rest.
 */
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelMember, channelMessage, channelSection, messageDraft, messageStatus, messageThread, savedMessage, scheduledMessage, workspaceAgent } from "@/db/schema";
import type { Bootstrap, Changes, PersonView } from "@/lib/message-wire";
import { user } from "@/db/schema";
import { workspacePeople } from "@/server/workspaces";
import { ensureStarted } from "./channels";
import { channelVisibleTo, currentRev, workspaceRole } from "./core";
import { presenceIn } from "./hub";
import { channelViews, draftViews, membershipViews, messageViews, savedViews, scheduledViews, sectionViews, statusViews, threadViews } from "./views";

/** A sync with more changed messages than this answers `reset`: the client loads afresh. */
const SYNC_MESSAGES = 2000;
/** Threads a client keeps: those followed, and others it read lately. */
const THREADS = 300;

/** The channels a person's list holds: those they are in, and the public ones still open. */
const listed = (userId: string) =>
  and(
    channelVisibleTo(userId),
    or(sql`exists (select 1 from ${channelMember} cm where cm.channel_id = ${channel.id} and cm.user_id = ${userId})`, isNull(channel.archivedAt)),
  );

/** The people of the workspace the person may know of: everyone for its members, those they share a channel with for a guest. */
export async function peopleFor(userId: string, workspaceId: string, guest: boolean): Promise<PersonView[]> {
  const people = await workspacePeople(workspaceId);
  const agents = await db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image })
    .from(workspaceAgent)
    .innerJoin(user, eq(user.id, workspaceAgent.userId))
    .where(and(eq(workspaceAgent.workspaceId, workspaceId), isNull(workspaceAgent.archivedAt)));
  let all: PersonView[] = [...people.map((p) => ({ ...p, agent: false })), ...agents.map((a) => ({ ...a, role: "agent", agent: true }))];
  if (guest) {
    const shared = await db.execute<{ user_id: string }>(sql`select distinct other.user_id from ${channelMember} mine
      join ${channelMember} other on other.channel_id = mine.channel_id
      where mine.user_id = ${userId} and mine.workspace_id = ${workspaceId}`);
    const known = new Set([userId, ...shared.map((r) => r.user_id)]);
    all = all.filter((p) => known.has(p.id));
  }
  return all;
}

export async function bootstrap(userId: string, workspaceId: string): Promise<Bootstrap> {
  const role = await workspaceRole(userId, workspaceId);
  await ensureStarted(userId, workspaceId);
  const rev = await currentRev(workspaceId);
  const [channels, memberships, threads, drafts, saved, sections, statuses, scheduled, people] = await Promise.all([
    channelViews(and(eq(channel.workspaceId, workspaceId), listed(userId))),
    membershipViews(userId, eq(channelMember.workspaceId, workspaceId)),
    threadViews(
      userId,
      and(
        eq(messageThread.workspaceId, workspaceId),
        sql`${messageThread.threadId} in (select t.thread_id from ${messageThread} t where t.user_id = ${userId} and t.workspace_id = ${workspaceId}
          order by t.following desc, t.last_reply_at desc nulls last limit ${THREADS})`,
      ),
    ),
    draftViews(userId, eq(messageDraft.workspaceId, workspaceId)),
    savedViews(userId, eq(savedMessage.workspaceId, workspaceId)),
    sectionViews(userId, eq(channelSection.workspaceId, workspaceId)),
    statusViews(eq(messageStatus.workspaceId, workspaceId)),
    scheduledViews(userId, eq(scheduledMessage.workspaceId, workspaceId)),
    peopleFor(userId, workspaceId, role === "guest"),
  ]);
  // A guest hears only of the people they may know of.
  const knows = role === "guest" ? new Set(people.map((p) => p.id)) : null;
  return {
    rev,
    me: userId,
    people,
    presence: presenceIn(workspaceId, knows),
    channels,
    memberships,
    threads,
    drafts,
    saved,
    sections,
    statuses: knows ? statuses.filter((s) => knows.has(s.userId)) : statuses,
    scheduled,
  };
}

export type SyncAnswer = (Changes & { reset?: false; people: PersonView[]; keep: { channels: string[]; memberships: string[]; drafts: string[]; saved: string[]; sections: string[]; scheduled: string[] } }) | { reset: true; rev: number };

export async function sync(userId: string, workspaceId: string, since: unknown): Promise<SyncAnswer> {
  const role = await workspaceRole(userId, workspaceId);
  const rev = await currentRev(workspaceId);
  if (!Number.isInteger(since) || (since as number) < 0 || (since as number) > rev) return { reset: true, rev };
  const after = since as number;
  const mine = db.select({ id: channelMember.channelId }).from(channelMember).where(eq(channelMember.userId, userId));
  const [{ changed }] = await db
    .select({ changed: sql<number>`count(*)::int` })
    .from(channelMessage)
    .where(and(eq(channelMessage.workspaceId, workspaceId), gt(channelMessage.rev, after), inArray(channelMessage.channelId, mine)));
  if (changed > SYNC_MESSAGES) return { reset: true, rev };

  const newer = <T extends { rev: unknown }>(table: T) => gt(table.rev as never, after);
  const [channels, memberships, messages, threads, drafts, saved, sections, statuses, scheduled, keep] = await Promise.all([
    channelViews(and(eq(channel.workspaceId, workspaceId), newer(channel), listed(userId))),
    membershipViews(userId, and(eq(channelMember.workspaceId, workspaceId), newer(channelMember))),
    messageViews(and(eq(channelMessage.workspaceId, workspaceId), newer(channelMessage), inArray(channelMessage.channelId, mine)), { viewer: userId }),
    threadViews(userId, and(eq(messageThread.workspaceId, workspaceId), newer(messageThread))),
    draftViews(userId, and(eq(messageDraft.workspaceId, workspaceId), newer(messageDraft))),
    savedViews(userId, and(eq(savedMessage.workspaceId, workspaceId), newer(savedMessage))),
    sectionViews(userId, and(eq(channelSection.workspaceId, workspaceId), newer(channelSection))),
    statusViews(and(eq(messageStatus.workspaceId, workspaceId), newer(messageStatus))!),
    scheduledViews(userId, and(eq(scheduledMessage.workspaceId, workspaceId), newer(scheduledMessage))),
    stillThere(userId, workspaceId),
  ]);
  // People again too: names, pictures, members and agents may have changed while away.
  const people = await peopleFor(userId, workspaceId, role === "guest");
  const knows = role === "guest" ? new Set(people.map((p) => p.id)) : null;
  return { rev, people, channels, memberships, messages, threads, drafts, saved, sections, statuses: knows ? statuses.filter((s) => knows.has(s.userId)) : statuses, scheduled, keep };
}

async function stillThere(userId: string, workspaceId: string) {
  const [channels, memberships, drafts, saved, sections, scheduled] = await Promise.all([
    db.select({ id: channel.id }).from(channel).where(and(eq(channel.workspaceId, workspaceId), listed(userId))),
    db
      .select({ id: channelMember.channelId })
      .from(channelMember)
      .where(and(eq(channelMember.userId, userId), eq(channelMember.workspaceId, workspaceId))),
    db
      .select({ channelId: messageDraft.channelId, threadId: messageDraft.threadId })
      .from(messageDraft)
      .where(and(eq(messageDraft.userId, userId), eq(messageDraft.workspaceId, workspaceId))),
    db
      .select({ id: savedMessage.messageId })
      .from(savedMessage)
      .where(and(eq(savedMessage.userId, userId), eq(savedMessage.workspaceId, workspaceId))),
    db
      .select({ id: channelSection.id })
      .from(channelSection)
      .where(and(eq(channelSection.userId, userId), eq(channelSection.workspaceId, workspaceId))),
    db
      .select({ id: scheduledMessage.id })
      .from(scheduledMessage)
      .where(and(eq(scheduledMessage.userId, userId), eq(scheduledMessage.workspaceId, workspaceId))),
  ]);
  return {
    channels: channels.map((r) => r.id),
    memberships: memberships.map((r) => r.id),
    drafts: drafts.map((d) => `${d.channelId}\n${d.threadId}`),
    saved: saved.map((r) => r.id),
    sections: sections.map((r) => r.id),
    scheduled: scheduled.map((r) => r.id),
  };
}
