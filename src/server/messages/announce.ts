/**
 * After a write commits (core.ts `write`): tells each person with a connection open in the
 * workspace what of it concerns them, as one `changes` frame, then hands new messages to
 * notify.ts. Only people connected now are told; the others learn of it from `sync` or
 * `bootstrap` when they come back, which read the same rows.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelMember, channelMessage, channelSection, messageDraft, messageStatus, messageThread, savedMessage, scheduledMessage } from "@/db/schema";
import type { Changes } from "@/lib/message-wire";
import { setAnnouncer, type Touched } from "./core";
import { connectedPeople, connectionsIn, sendToPeople } from "./hub";
import { channelViews, draftViews, membershipViews, messageViews, savedViews, scheduledViews, sectionViews, statusViews, threadViews } from "./views";

/** Read marks go to channels this small or less: in a large one they are noise and many frames. */
const READ_MARKS_UP_TO = 30;

async function announce(t: Touched) {
  const people = connectedPeople(t.workspaceId);
  if (people.size) await tell(t, people);
  if (t.sent.length) {
    const { notifyMessages } = await import("./notify");
    notifyMessages(t.workspaceId, t.sent);
  }
}

async function tell(t: Touched, people: Map<string, { guest: boolean }>) {
  const ids = [...people.keys()];
  const out = new Map<string, Changes>(ids.map((id) => [id, { rev: t.rev }]));
  const put = <K extends keyof Changes>(userId: string, key: K, values: NonNullable<Changes[K]>) => {
    const changes = out.get(userId);
    if (!changes || (Array.isArray(values) && !values.length)) return;
    const before = (changes[key] ?? []) as unknown[];
    (changes as Record<string, unknown>)[key] = [...before, ...(values as unknown[])];
  };

  // Channels touched, those of touched messages, rosters and read marks: who of the connected sees each.
  const messages = t.messages.size ? await messageViews(inArray(channelMessage.id, [...t.messages])) : [];
  const channelIds = new Set([...t.channels, ...t.roster, ...messages.map((m) => m.channelId), ...t.reads.map((r) => r.channelId)]);
  for (const set of t.left.values()) for (const id of set) channelIds.add(id);
  const channels = channelIds.size ? await channelViews(inArray(channel.id, [...channelIds])) : [];
  const membersOf = new Map<string, Set<string>>();
  if (channelIds.size) {
    const rows = await db
      .select({ channelId: channelMember.channelId, userId: channelMember.userId })
      .from(channelMember)
      .where(and(inArray(channelMember.channelId, [...channelIds]), inArray(channelMember.userId, ids)));
    for (const r of rows) membersOf.set(r.channelId, (membersOf.get(r.channelId) ?? new Set()).add(r.userId));
  }
  const kindOf = new Map(channels.map((c) => [c.id, c]));
  const sees = (userId: string, channelId: string) => {
    const c = kindOf.get(channelId);
    if (!c) return false;
    return membersOf.get(channelId)?.has(userId) || (c.kind === "public" && !people.get(userId)?.guest);
  };
  // Messages of a public channel go to its people and to those who have it open; the others hear of its new `lastSeq`.
  const viewing = new Map<string, Set<string>>();
  for (const c of connectionsIn(t.workspaceId)) if (c.viewing) viewing.set(c.viewing, (viewing.get(c.viewing) ?? new Set()).add(c.userId));
  const keepsMessages = (userId: string, channelId: string) => sees(userId, channelId) && (membersOf.get(channelId)?.has(userId) || viewing.get(channelId)?.has(userId));

  for (const userId of ids) {
    put(
      userId,
      "channels",
      channels.filter((c) => (t.channels.has(c.id) || messages.some((m) => m.channelId === c.id)) && sees(userId, c.id)),
    );
    put(
      userId,
      "messages",
      messages.filter((m) => keepsMessages(userId, m.channelId)),
    );
    put(
      userId,
      "roster",
      [...t.roster].filter((id) => sees(userId, id)),
    );
    put(
      userId,
      "reads",
      t.reads.filter((r) => r.userId !== userId && membersOf.get(r.channelId)?.has(userId) && (kindOf.get(r.channelId)?.memberCount ?? Infinity) <= READ_MARKS_UP_TO),
    );
    const left = [...(t.left.get(userId) ?? [])];
    put(
      userId,
      "goneChannels",
      left.filter((id) => !sees(userId, id)),
    );
    put(
      userId,
      "leftChannels",
      left.filter((id) => sees(userId, id)),
    );
  }

  // The person's own rows, read for them alone.
  await Promise.all(
    ids.map(async (userId) => {
      const mine = (map: Map<string, Set<string>>) => [...(map.get(userId) ?? [])];
      const members = mine(t.members);
      const threads = mine(t.threads);
      const saved = mine(t.saved);
      const sections = mine(t.sections);
      const scheduled = mine(t.scheduled);
      const drafts = [...t.drafts].map((key) => key.split("\n")).filter(([id]) => id === userId);
      const [m, th, sa, se, sc, dr] = await Promise.all([
        members.length ? membershipViews(userId, inArray(channelMember.channelId, members)) : [],
        threads.length ? threadViews(userId, inArray(messageThread.threadId, threads)) : [],
        saved.length ? savedViews(userId, inArray(savedMessage.messageId, saved)) : [],
        sections.length ? sectionViews(userId, inArray(channelSection.id, sections)) : [],
        scheduled.length ? scheduledViews(userId, inArray(scheduledMessage.id, scheduled)) : [],
        drafts.length ? draftViews(userId, inArray(messageDraft.channelId, drafts.map(([, channelId]) => channelId))) : [],
      ]);
      put(userId, "memberships", m);
      put(userId, "threads", th);
      put(userId, "saved", sa);
      put(userId, "sections", se);
      put(userId, "scheduled", sc);
      put(
        userId,
        "drafts",
        dr.filter((d) => drafts.some(([, c, th2]) => c === d.channelId && th2 === d.threadId)),
      );
      put(userId, "goneDrafts", t.goneDrafts.get(userId) ?? []);
      put(userId, "goneSaved", t.goneSaved.get(userId) ?? []);
      put(userId, "goneSections", t.goneSections.get(userId) ?? []);
      put(userId, "goneScheduled", t.goneScheduled.get(userId) ?? []);
    }),
  );

  if (t.statuses.size) {
    const statuses = await statusViews(and(eq(messageStatus.workspaceId, t.workspaceId), inArray(messageStatus.userId, [...t.statuses]))!);
    for (const userId of ids) put(userId, "statuses", statuses);
  }

  sendToPeople(t.workspaceId, ids, (userId) => {
    const changes = out.get(userId);
    return changes && Object.keys(changes).length > 1 ? { t: "changes", d: changes } : null;
  });
}

setAnnouncer(announce);
