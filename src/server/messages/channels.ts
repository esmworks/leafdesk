/**
 * Channels and direct conversations: making them, who is in them, their names and settings, and
 * each person's own settings of one (notifications, star, section). Every change goes through
 * core.ts `write`; what happened in a channel is also written in it as a system message.
 */
import { and, asc, eq, ilike, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { createTranslator } from "next-intl";
import { db } from "@/db";
import { channel, channelMember, channelMessage, channelSection, messageStatus, workspaceAgent } from "@/db/schema";
import { loadMessages } from "@/i18n/messages";
import { channelName, channelNameError, directKey, MESSAGE_LIMITS, type ChannelKind, type ChannelNotify, type PostingPolicy, type SystemEvent } from "@/lib/messages";
import { recordAudit } from "@/server/audit";
import { recipientLocale } from "@/server/mail/locale";
import { workspacePeople } from "@/server/workspaces";
import type { Tx } from "@/server/workspaces";
import { channelVisibleTo, MessageError, requireChannel, workspaceRole, write, type Changed, type ChannelRow } from "./core";

/** Takes the channel's next message number and returns it (the row stays locked until the write ends). */
export async function nextSeq(tx: Tx, channelId: string, rev: number, shown: boolean): Promise<number> {
  const [row] = await tx
    .update(channel)
    .set({ lastSeq: sql`${channel.lastSeq} + 1`, rev, ...(shown ? { lastMessageAt: new Date() } : {}) })
    .where(eq(channel.id, channelId))
    .returning({ seq: channel.lastSeq });
  if (!row) throw new MessageError("notFound");
  return row.seq;
}

/** Writes what happened in a channel as a system message there. */
export async function systemMessage(tx: Tx, changed: Changed, row: Pick<ChannelRow, "id" | "workspaceId">, authorId: string | null, event: SystemEvent) {
  const seq = await nextSeq(tx, row.id, changed.rev, false);
  const id = crypto.randomUUID();
  await tx.insert(channelMessage).values({ id, channelId: row.id, workspaceId: row.workspaceId, seq, authorId, kind: "system", data: { system: event }, rev: changed.rev });
  changed.message(id);
  changed.channel(row.id);
}

/** Adds people to a channel, who start with everything in it read. Returns those who weren't in it. */
async function addPeople(tx: Tx, changed: Changed, row: ChannelRow, userIds: string[], role: "admin" | "member" = "member"): Promise<string[]> {
  if (!userIds.length) return [];
  const [{ lastSeq }] = await tx.select({ lastSeq: channel.lastSeq }).from(channel).where(eq(channel.id, row.id));
  const added = await tx
    .insert(channelMember)
    .values(userIds.map((userId) => ({ channelId: row.id, userId, workspaceId: row.workspaceId, role, lastReadSeq: lastSeq, rev: changed.rev })))
    .onConflictDoNothing()
    .returning({ userId: channelMember.userId });
  for (const { userId } of added) changed.member(row.id, userId);
  if (added.length) {
    changed.roster(row.id);
    changed.channel(row.id);
  }
  return added.map((a) => a.userId);
}

/** Of `userIds`, those in the workspace (agents too), refusing guests unless `guests`. */
async function peopleOfWorkspace(workspaceId: string, userIds: unknown, guests: boolean): Promise<string[]> {
  if (!Array.isArray(userIds) || userIds.length > 500 || userIds.some((id) => typeof id !== "string")) throw new MessageError("invalid");
  const wanted = new Set(userIds as string[]);
  if (!wanted.size) return [];
  const people = await workspacePeople(workspaceId);
  const agents = await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(and(eq(workspaceAgent.workspaceId, workspaceId), inArray(workspaceAgent.userId, [...wanted])));
  const found = new Set([...people.filter((p) => guests || p.role !== "guest").map((p) => p.id), ...agents.map((a) => a.userId)]);
  const missing = [...wanted].filter((id) => !found.has(id));
  if (missing.length) throw new MessageError("invalid", "Someone isn't in the workspace");
  return [...wanted];
}

/**
 * The person's first visit to the workspace's messages: joins them to the channels new people join
 * and, in a workspace with no channel yet, opens its general channel with everyone in it. Later
 * visits do nothing (their `message_status` row marks the first).
 */
export async function ensureStarted(userId: string, workspaceId: string): Promise<void> {
  const [known] = await db
    .select({ userId: messageStatus.userId })
    .from(messageStatus)
    .where(and(eq(messageStatus.userId, userId), eq(messageStatus.workspaceId, workspaceId)));
  if (known) return;
  const role = await workspaceRole(userId, workspaceId);
  const [any] = await db.select({ id: channel.id }).from(channel).where(and(eq(channel.workspaceId, workspaceId), ne(channel.kind, "direct"))).limit(1);
  const general = !any && role !== "guest" ? await generalName(userId) : null;
  await write(workspaceId, async (tx, changed) => {
    const inserted = await tx.insert(messageStatus).values({ userId, workspaceId, rev: changed.rev }).onConflictDoNothing().returning({ userId: messageStatus.userId });
    if (!inserted.length) return;
    changed.status(userId);
    if (general) {
      // Another first visit may have made it in the meantime: the name's index keeps one.
      const [made] = await tx
        .insert(channel)
        .values({ workspaceId, kind: "public", name: general, joinNew: true, createdBy: userId, rev: changed.rev })
        .onConflictDoNothing()
        .returning();
      if (made) {
        const everyone = (await workspacePeople(workspaceId)).filter((p) => p.role !== "guest").map((p) => p.id);
        await addPeople(tx, changed, made, [userId], "admin");
        await addPeople(tx, changed, made, everyone);
        await systemMessage(tx, changed, made, userId, { event: "created" });
        return;
      }
    }
    if (role === "guest") return;
    const joinNew = await tx
      .select()
      .from(channel)
      .where(and(eq(channel.workspaceId, workspaceId), eq(channel.joinNew, true), isNull(channel.archivedAt)));
    for (const row of joinNew) await addPeople(tx, changed, row, [userId]);
  });
}

async function generalName(userId: string): Promise<string> {
  const locale = await recipientLocale(userId, undefined);
  const messages = await loadMessages(locale);
  const t = createTranslator({ locale, messages: { messages: messages.messages }, namespace: "messages" });
  return channelName(t("generalChannel")) || "general";
}

const text = (value: unknown, max: number): string => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new MessageError("invalid");
  const trimmed = value.trim();
  if (trimmed.length > max) throw new MessageError("tooLong");
  return trimmed;
};

const nameOf = (value: unknown): string => {
  const name = channelName(typeof value === "string" ? value : "");
  const error = channelNameError(name);
  if (error === "tooLong") throw new MessageError("tooLong");
  if (error) throw new MessageError("invalid", "A channel needs a name");
  return name;
};

/** A unique violation of the channel's name (Drizzle wraps the driver's error in `cause`). */
const isNameTaken = (error: unknown) => {
  const e = (error as { cause?: { code?: string; constraint_name?: string } })?.cause ?? (error as { code?: string; constraint_name?: string });
  return e?.code === "23505" && (!e.constraint_name || e.constraint_name === "channel_name_idx");
};

/** Makes a channel, with its maker as its admin and the people they chose in it. */
export async function createChannel(
  userId: string,
  workspaceId: string,
  input: { name?: unknown; kind?: unknown; topic?: unknown; description?: unknown; memberIds?: unknown; posting?: unknown },
): Promise<string> {
  const role = await workspaceRole(userId, workspaceId);
  if (role === "guest") throw new MessageError("notAllowed");
  const kind: ChannelKind = input.kind === "private" ? "private" : "public";
  const name = nameOf(input.name);
  const topic = text(input.topic, MESSAGE_LIMITS.topic);
  const description = text(input.description, MESSAGE_LIMITS.description);
  const posting: PostingPolicy = input.posting === "admins" ? "admins" : "everyone";
  const others = (await peopleOfWorkspace(workspaceId, input.memberIds ?? [], kind === "private")).filter((id) => id !== userId);
  try {
    return await write(workspaceId, async (tx, changed) => {
      const [row] = await tx.insert(channel).values({ workspaceId, kind, name, topic, description, posting, createdBy: userId, rev: changed.rev }).returning();
      changed.channel(row.id);
      await addPeople(tx, changed, row, [userId], "admin");
      await addPeople(tx, changed, row, others);
      await systemMessage(tx, changed, row, userId, { event: "created" });
      await recordAudit({ workspaceId, actorId: userId, action: "channel.created", target: { type: "channel", id: row.id, label: name ? `#${name}` : null }, details: { kind } }, tx);
      return row.id;
    });
  } catch (error) {
    if (isNameTaken(error)) throw new MessageError("nameTaken");
    throw error;
  }
}

/**
 * The direct conversation between the person and `userIds` (the person alone: their notes to
 * themselves), made the first time. Guests talk only with people they share a channel with.
 */
export async function openDirect(userId: string, workspaceId: string, userIds: unknown): Promise<string> {
  const role = await workspaceRole(userId, workspaceId);
  const others = (await peopleOfWorkspace(workspaceId, userIds, true)).filter((id) => id !== userId);
  if (others.length + 1 > MESSAGE_LIMITS.directPeople) throw new MessageError("tooMany");
  if (role === "guest" && others.length) {
    const shared = await db.execute<{ user_id: string }>(sql`select distinct other.user_id from ${channelMember} mine
      join ${channelMember} other on other.channel_id = mine.channel_id
      where mine.user_id = ${userId} and mine.workspace_id = ${workspaceId} and other.user_id in ${others}`);
    if (shared.length < others.length) throw new MessageError("notAllowed");
  }
  const key = directKey([userId, ...others]);
  const [existing] = await db
    .select({ id: channel.id })
    .from(channel)
    .where(and(eq(channel.workspaceId, workspaceId), eq(channel.kind, "direct"), eq(channel.directKey, key)));
  if (existing) {
    await setPreferences(userId, existing.id, { hidden: false });
    return existing.id;
  }
  return write(workspaceId, async (tx, changed) => {
    const [row] = await tx.insert(channel).values({ workspaceId, kind: "direct", directKey: key, createdBy: userId, rev: changed.rev }).onConflictDoNothing().returning();
    if (!row) {
      const [made] = await tx.select({ id: channel.id }).from(channel).where(and(eq(channel.workspaceId, workspaceId), eq(channel.directKey, key)));
      return made.id;
    }
    changed.channel(row.id);
    await addPeople(tx, changed, row, [userId, ...others]);
    return row.id;
  });
}

/** Changes a channel's name, topic, description, who may post or whether new people join it (its admins). */
export async function updateChannel(
  userId: string,
  channelId: string,
  input: { name?: unknown; topic?: unknown; description?: unknown; posting?: unknown; joinNew?: unknown; private?: unknown },
): Promise<void> {
  // The socket's call carries the channel's id beside the fields: only the fields count.
  const fields = Object.keys(input).filter((k) => k !== "channelId" && (input as Record<string, unknown>)[k] !== undefined);
  const topicOnly = fields.length > 0 && fields.every((k) => k === "topic");
  // Anyone in a channel may set its topic, as in a room; the rest is its admins'.
  const { channel: row, member } = await requireChannel(userId, channelId, topicOnly ? "read" : "admin");
  if (topicOnly && (!member || row.kind === "direct")) throw new MessageError("notAllowed");
  if (row.archivedAt) throw new MessageError("archived");
  const patch: Partial<typeof channel.$inferInsert> = {};
  const events: SystemEvent[] = [];
  if (input.name !== undefined) {
    const name = nameOf(input.name);
    if (name !== row.name) {
      patch.name = name;
      events.push({ event: "renamed", from: row.name ?? "", to: name });
    }
  }
  if (input.topic !== undefined) {
    const topic = text(input.topic, MESSAGE_LIMITS.topic);
    if (topic !== row.topic) {
      patch.topic = topic;
      events.push({ event: "topic", to: topic });
    }
  }
  if (input.description !== undefined) {
    const description = text(input.description, MESSAGE_LIMITS.description);
    if (description !== row.description) {
      patch.description = description;
      events.push({ event: "description", to: description });
    }
  }
  if (input.posting !== undefined) patch.posting = input.posting === "admins" ? "admins" : "everyone";
  if (input.joinNew !== undefined) patch.joinNew = input.joinNew === true;
  // A public channel may become private (who sees it narrows to its people); never the other way, which would show what was said in private.
  if (input.private === true && row.kind === "public") {
    patch.kind = "private";
    events.push({ event: "private", to: true });
  }
  if (!Object.keys(patch).length) return;
  try {
    await write(row.workspaceId, async (tx, changed) => {
      await tx
        .update(channel)
        .set({ ...patch, rev: changed.rev })
        .where(eq(channel.id, channelId));
      changed.channel(channelId);
      for (const event of events) await systemMessage(tx, changed, row, userId, event);
      if (patch.kind === "private") {
        // Those who saw it only because it was public no longer do.
        const people = await workspacePeople(row.workspaceId);
        const members = new Set((await tx.select({ userId: channelMember.userId }).from(channelMember).where(eq(channelMember.channelId, channelId))).map((m) => m.userId));
        for (const p of people) if (!members.has(p.id)) changed.left(channelId, p.id);
      }
      if (patch.name || patch.kind) {
        await recordAudit({ workspaceId: row.workspaceId, actorId: userId, action: "channel.updated", target: { type: "channel", id: channelId, label: `#${patch.name ?? row.name ?? ""}` }, details: { from: row.name, kind: patch.kind } }, tx);
      }
    });
  } catch (error) {
    if (isNameTaken(error)) throw new MessageError("nameTaken");
    throw error;
  }
}

/** Joins a public channel. */
export async function joinChannel(userId: string, channelId: string): Promise<void> {
  const { channel: row, member } = await requireChannel(userId, channelId);
  if (member) return;
  if (row.kind !== "public") throw new MessageError("notAllowed");
  if (row.archivedAt) throw new MessageError("archived");
  await write(row.workspaceId, async (tx, changed) => {
    const added = await addPeople(tx, changed, row, [userId]);
    if (added.length) await systemMessage(tx, changed, row, userId, { event: "joined" });
  });
}

/** Leaves a channel (not a direct conversation, which is hidden instead). */
export async function leaveChannel(userId: string, channelId: string): Promise<void> {
  const { channel: row, member } = await requireChannel(userId, channelId);
  if (!member) return;
  if (row.kind === "direct") throw new MessageError("notAllowed");
  await write(row.workspaceId, async (tx, changed) => {
    await tx.delete(channelMember).where(and(eq(channelMember.channelId, channelId), eq(channelMember.userId, userId)));
    changed.left(channelId, userId);
    changed.roster(channelId);
    changed.channel(channelId);
    await systemMessage(tx, changed, row, userId, { event: "left" });
  });
}

/** Adds people to a channel: anyone in it may, but only workspace members (not guests) to a public one. */
export async function addMembers(userId: string, channelId: string, userIds: unknown): Promise<void> {
  const { channel: row, member, role } = await requireChannel(userId, channelId);
  if (!member && role !== "owner") throw new MessageError("notMember");
  if (row.kind === "direct") throw new MessageError("notAllowed");
  if (row.archivedAt) throw new MessageError("archived");
  if (role === "guest") throw new MessageError("notAllowed");
  const wanted = await peopleOfWorkspace(row.workspaceId, userIds, true);
  await write(row.workspaceId, async (tx, changed) => {
    const added = await addPeople(tx, changed, row, wanted);
    if (added.length) await systemMessage(tx, changed, row, userId, { event: "added", users: added });
  });
}

/** Takes someone out of a channel (its admins). */
export async function removeMember(userId: string, channelId: string, targetId: unknown): Promise<void> {
  if (typeof targetId !== "string") throw new MessageError("invalid");
  if (targetId === userId) return leaveChannel(userId, channelId);
  const { channel: row } = await requireChannel(userId, channelId, "admin");
  if (row.joinNew && row.kind === "public") {
    // Everyone is in the general channel; taking someone out would only have them join again.
  }
  await write(row.workspaceId, async (tx, changed) => {
    const gone = await tx
      .delete(channelMember)
      .where(and(eq(channelMember.channelId, channelId), eq(channelMember.userId, targetId)))
      .returning({ userId: channelMember.userId });
    if (!gone.length) return;
    changed.left(channelId, targetId);
    changed.roster(channelId);
    changed.channel(channelId);
    await systemMessage(tx, changed, row, userId, { event: "removed", users: [targetId] });
  });
}

/** Makes someone in the channel its admin, or a member again (its admins; a channel keeps one admin at least). */
export async function setMemberRole(userId: string, channelId: string, targetId: unknown, role: unknown): Promise<void> {
  if (typeof targetId !== "string" || (role !== "admin" && role !== "member")) throw new MessageError("invalid");
  const { channel: row } = await requireChannel(userId, channelId, "admin");
  await write(row.workspaceId, async (tx, changed) => {
    if (role === "member") {
      const [{ admins }] = await tx
        .select({ admins: sql<number>`count(*)::int` })
        .from(channelMember)
        .where(and(eq(channelMember.channelId, channelId), eq(channelMember.role, "admin"), ne(channelMember.userId, targetId)));
      if (!admins) throw new MessageError("notAllowed", "A channel keeps one admin");
    }
    const updated = await tx
      .update(channelMember)
      .set({ role, rev: changed.rev })
      .where(and(eq(channelMember.channelId, channelId), eq(channelMember.userId, targetId)))
      .returning({ userId: channelMember.userId });
    if (!updated.length) throw new MessageError("notFound");
    changed.member(channelId, targetId);
    changed.roster(channelId);
  });
}

/** Archives a channel (read-only, off everyone's list unless they look for it) or brings it back (its admins). */
export async function setArchived(userId: string, channelId: string, archived: boolean): Promise<void> {
  const { channel: row } = await requireChannel(userId, channelId, "admin");
  if (Boolean(row.archivedAt) === archived) return;
  await write(row.workspaceId, async (tx, changed) => {
    await tx
      .update(channel)
      .set({ archivedAt: archived ? new Date() : null, archivedBy: archived ? userId : null, joinNew: archived ? false : row.joinNew, rev: changed.rev })
      .where(eq(channel.id, channelId));
    changed.channel(channelId);
    await systemMessage(tx, changed, row, userId, { event: archived ? "archived" : "unarchived" });
    await recordAudit({ workspaceId: row.workspaceId, actorId: userId, action: archived ? "channel.archived" : "channel.unarchived", target: { type: "channel", id: channelId, label: `#${row.name ?? ""}` } }, tx);
  });
}

const NOTIFY: ChannelNotify[] = ["default", "all", "mentions", "none"];

/** The person's own settings of a channel they are in. */
export async function setPreferences(
  userId: string,
  channelId: string,
  input: { notify?: unknown; muted?: unknown; starred?: unknown; hidden?: unknown; sectionId?: unknown },
): Promise<void> {
  const { channel: row, member } = await requireChannel(userId, channelId);
  if (!member) throw new MessageError("notMember");
  const patch: Partial<typeof channelMember.$inferInsert> = {};
  if (input.notify !== undefined) {
    if (!NOTIFY.includes(input.notify as ChannelNotify)) throw new MessageError("invalid");
    patch.notify = input.notify as ChannelNotify;
  }
  if (typeof input.muted === "boolean") patch.muted = input.muted;
  if (typeof input.starred === "boolean") patch.starred = input.starred;
  if (typeof input.hidden === "boolean") patch.hidden = input.hidden;
  if (input.sectionId !== undefined) {
    if (input.sectionId === null) patch.sectionId = null;
    else {
      if (typeof input.sectionId !== "string") throw new MessageError("invalid");
      const [section] = await db
        .select({ id: channelSection.id })
        .from(channelSection)
        .where(and(eq(channelSection.id, input.sectionId), eq(channelSection.userId, userId), eq(channelSection.workspaceId, row.workspaceId)));
      if (!section) throw new MessageError("notFound");
      patch.sectionId = section.id;
    }
  }
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length || keys.every((k) => member[k as keyof typeof member] === patch[k])) return;
  await write(row.workspaceId, async (tx, changed) => {
    await tx
      .update(channelMember)
      .set({ ...patch, rev: changed.rev })
      .where(and(eq(channelMember.channelId, channelId), eq(channelMember.userId, userId)));
    changed.member(channelId, userId);
  });
}

/** Makes, renames, folds, orders or deletes one of the person's sections of their channel list. */
export async function changeSection(
  userId: string,
  workspaceId: string,
  input: { action?: unknown; id?: unknown; name?: unknown; collapsed?: unknown; order?: unknown },
): Promise<string | null> {
  await workspaceRole(userId, workspaceId);
  const mine = (id: unknown) => and(eq(channelSection.id, String(id)), eq(channelSection.userId, userId), eq(channelSection.workspaceId, workspaceId));
  return write(workspaceId, async (tx, changed) => {
    switch (input.action) {
      case "create": {
        const name = text(input.name, MESSAGE_LIMITS.name);
        if (!name) throw new MessageError("invalid");
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(channelSection)
          .where(and(eq(channelSection.userId, userId), eq(channelSection.workspaceId, workspaceId)));
        if (count >= MESSAGE_LIMITS.sections) throw new MessageError("tooMany");
        const [row] = await tx.insert(channelSection).values({ userId, workspaceId, name, position: count, rev: changed.rev }).returning({ id: channelSection.id });
        changed.section(userId, row.id);
        return row.id;
      }
      case "update": {
        const patch: Partial<typeof channelSection.$inferInsert> = { rev: changed.rev };
        if (input.name !== undefined) {
          const name = text(input.name, MESSAGE_LIMITS.name);
          if (!name) throw new MessageError("invalid");
          patch.name = name;
        }
        if (typeof input.collapsed === "boolean") patch.collapsed = input.collapsed;
        const updated = await tx.update(channelSection).set(patch).where(mine(input.id)).returning({ id: channelSection.id });
        if (!updated.length) throw new MessageError("notFound");
        changed.section(userId, updated[0].id);
        return updated[0].id;
      }
      case "order": {
        if (!Array.isArray(input.order) || input.order.some((id) => typeof id !== "string")) throw new MessageError("invalid");
        const ids = input.order as string[];
        for (const [position, id] of ids.entries()) {
          const updated = await tx.update(channelSection).set({ position, rev: changed.rev }).where(mine(id)).returning({ id: channelSection.id });
          if (updated.length) changed.section(userId, id);
        }
        return null;
      }
      case "delete": {
        const gone = await tx.delete(channelSection).where(mine(input.id)).returning({ id: channelSection.id });
        if (!gone.length) return null;
        const moved = await tx
          .update(channelMember)
          .set({ sectionId: null, rev: changed.rev })
          .where(and(eq(channelMember.userId, userId), eq(channelMember.sectionId, gone[0].id)))
          .returning({ channelId: channelMember.channelId });
        for (const m of moved) changed.member(m.channelId, userId);
        changed.sectionGone(userId, gone[0].id);
        return null;
      }
      default:
        throw new MessageError("invalid");
    }
  });
}

/** Public channels the person isn't in (for "Browse channels"), and archived ones they may see, by name. */
export async function browseChannels(userId: string, workspaceId: string, query: unknown) {
  const role = await workspaceRole(userId, workspaceId);
  if (role === "guest") return [];
  const words = typeof query === "string" ? query.trim().slice(0, 80) : "";
  const { channelViews } = await import("./views");
  const mine = db.select({ id: channelMember.channelId }).from(channelMember).where(eq(channelMember.userId, userId));
  return channelViews(
    and(
      eq(channel.workspaceId, workspaceId),
      ne(channel.kind, "direct"),
      channelVisibleTo(userId),
      or(notInArray(channel.id, mine), sql`${channel.archivedAt} is not null`),
      words ? or(ilike(channel.name, `%${words.replace(/[\\%_]/g, "\\$&")}%`), ilike(channel.description, `%${words.replace(/[\\%_]/g, "\\$&")}%`)) : undefined,
    ),
  );
}

/** A channel's people with their roles, for its details (anyone who may see it). */
export async function channelPeople(userId: string, channelId: string) {
  await requireChannel(userId, channelId);
  return db
    .select({ userId: channelMember.userId, role: channelMember.role, joinedAt: channelMember.joinedAt })
    .from(channelMember)
    .where(eq(channelMember.channelId, channelId))
    .orderBy(asc(channelMember.joinedAt));
}

const day = (value: unknown): Date | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** A person's own status in the workspace (emoji, words, until when), quiet hours and previews. */
export async function setStatus(
  userId: string,
  workspaceId: string,
  input: { emoji?: unknown; text?: unknown; statusUntil?: unknown; quietUntil?: unknown; previews?: unknown },
): Promise<void> {
  await workspaceRole(userId, workspaceId);
  const set: Partial<typeof messageStatus.$inferInsert> = {};
  if (input.emoji === null || input.emoji === "") set.emoji = null;
  else if (typeof input.emoji === "string") {
    if (input.emoji.length > MESSAGE_LIMITS.emoji) throw new MessageError("invalid");
    set.emoji = input.emoji;
  }
  if (typeof input.text === "string") set.text = input.text.trim().slice(0, MESSAGE_LIMITS.status);
  const until = day(input.statusUntil);
  if (until !== undefined) set.statusUntil = until;
  const quiet = day(input.quietUntil);
  if (quiet !== undefined) set.quietUntil = quiet;
  if (typeof input.previews === "boolean") set.previews = input.previews;
  if (!Object.keys(set).length) return;
  await write(workspaceId, async (tx, changed) => {
    await tx
      .insert(messageStatus)
      .values({ userId, workspaceId, ...set, rev: changed.rev })
      .onConflictDoUpdate({ target: [messageStatus.userId, messageStatus.workspaceId], set: { ...set, rev: changed.rev } });
    changed.status(userId);
  });
}
