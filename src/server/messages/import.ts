/**
 * Imports a Slack workspace export (lib/import/slack.ts reads it) into the workspace's messages:
 * its public and private channels, as new channels (a name already taken gets a number), with
 * every message at its original time, threads, reactions and, when asked, the files downloaded.
 * People are matched to members by email: a match writes as them, the others' messages show the
 * name they had (`data.importedFrom`). Only workspace owners import.
 *
 * Everything is written through core.ts `write`, a channel at a time in pieces of CHUNK messages
 * (each write holds the workspace's clock, which live messages wait on), so clients see each
 * channel and its new `lastSeq` live and `sync` catches up the rest. Messages are not announced
 * one by one, nobody is notified and no mention or thread follow is recorded: the history comes
 * in read. `seq` follows `ts`, so seq and creation times keep one order; replies come after the
 * message they answer. Ids are derived from the workspace and Slack's ids, so importing the same
 * export again finds its channels and leaves them be.
 */
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelMember, channelMessage, file, messageFile, messageReaction } from "@/db/schema";
import { normalizePath, IMPORT_LIMITS } from "@/lib/import/markdown";
import { ImportError } from "@/lib/import/result";
import {
  slackBody,
  slackEmoji,
  slackPlainText,
  type SlackChannel,
  type SlackExport,
  type SlackFile,
  type SlackImportResult,
  type SlackImportWarning,
  type SlackMessage,
  type SlackNames,
} from "@/lib/import/slack";
import { plainText } from "@/lib/message-text";
import { channelName, isEmoji, MESSAGE_LIMITS, type MessageData } from "@/lib/messages";
import { requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { connectionFetch } from "@/server/connections/fetch";
import { entryName } from "@/server/import/archive";
import { storeFile } from "@/server/files";
import { workspacePeople } from "@/server/workspaces";
import { write } from "./core";

export const SLACK_LIMITS = {
  /** Files in the ZIP (one per channel and day: far more than other imports take). */
  files: 100_000,
  /** Messages written in one write. */
  chunk: 1000,
  /** Files downloaded in one import; the rest are linked. */
  downloads: 2000,
  /** How long one download may take. */
  downloadMs: 60_000,
};

/** At most this many people of the export are named in the warning about those who matched no member. */
const NAMED_UNMATCHED = 10;
/** At most this many recent repliers are kept on a thread's first message (as posts.ts does). */
const REPLIERS = 5;

/**
 * The JSON files of an export's ZIP by path. Bounded before unpacking, as server/import/archive.ts
 * is (entry sizes from the ZIP's directory, the larger of both), but with room for many small files.
 */
export function unpackSlackExport(data: Uint8Array): Map<string, Uint8Array> {
  let files = 0;
  let bytes = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (entry) => {
        const path = normalizePath(entryName(entry.name));
        if (!path || !path.toLowerCase().endsWith(".json") || path.length > IMPORT_LIMITS.pathChars) return false;
        files++;
        bytes += Math.max(entry.size, entry.originalSize);
        if (files > SLACK_LIMITS.files) throw new ImportError(`An import can hold at most ${SLACK_LIMITS.files} files`, "tooManyFiles", { limit: SLACK_LIMITS.files });
        if (bytes > IMPORT_LIMITS.unpackedBytes) throw new ImportError("The unpacked files are too large to import", "tooLarge", { limit: IMPORT_LIMITS.unpackedBytes });
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("The ZIP file can't be read", "badZip");
  }
  const out = new Map<string, Uint8Array>();
  for (const [name, content] of Object.entries(entries)) out.set(normalizePath(entryName(name))!, content);
  return out;
}

/** A UUID made from `parts`: the same export gives the same ids. */
function stableId(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\n")).digest("hex");
  const variant = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The first free channel name from `wanted`: itself, then with -2, -3 … */
function freeName(wanted: string, taken: Set<string>): string {
  const base = channelName(wanted) || "channel";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = `${base.slice(0, MESSAGE_LIMITS.name - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

type Download = { fileId: string; size: number };

/**
 * Downloads one of a message's files into the workspace's storage, as `userId` uploaded it; null
 * when it can't be (no address, refused, a sign-in page instead of the file, too large, the quota).
 * Through connections/fetch.ts as an address anyone gives: no private network, only the hosts an
 * administrator allowed for that.
 */
async function download(workspaceId: string, userId: string, slackFile: SlackFile): Promise<Download | null> {
  if (!slackFile.download) return null;
  try {
    const response = await connectionFetch(slackFile.download, { signal: AbortSignal.timeout(SLACK_LIMITS.downloadMs) }, { untrusted: true });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || type.toLowerCase().startsWith("text/html")) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const declared = Number(response.headers.get("content-length") ?? NaN);
    const stored = await storeFile(
      { workspaceId, pageId: null, uploadedBy: userId },
      { name: slackFile.name, contentType: slackFile.contentType ?? type, body: response.body, declaredSize: Number.isFinite(declared) ? declared : null },
    );
    return { fileId: stored.id, size: stored.size };
  } catch {
    return null;
  }
}

type Person = { id: string; role: string; name: string };

/**
 * Writes the export's channels into the workspace as `userId`, a workspace owner. `download`:
 * fetch the messages' files (else, and when a download fails, each is a link to its page on Slack).
 */
export async function importSlackExport(userId: string, workspaceId: string, data: SlackExport, options: { download?: boolean } = {}): Promise<SlackImportResult> {
  await requireMembership(userId, workspaceId, "owner");
  const warnings: SlackImportWarning[] = [];

  // People: members by email; bots and the rest show their Slack name.
  const members = await workspacePeople(workspaceId);
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), { id: m.id, role: m.role, name: m.name }] as const));
  const matched = new Map<string, Person>();
  const unmatched: string[] = [];
  for (const u of data.users.values()) {
    const person = !u.bot && u.email ? byEmail.get(u.email) : undefined;
    if (person) matched.set(u.id, person);
  }
  const used = new Set<string>();
  for (const c of data.channels) for (const m of c.messages) if (m.user) used.add(m.user);
  for (const id of used) {
    const u = data.users.get(id);
    if (!matched.has(id) && u && !u.bot) unmatched.push(u.name);
  }
  if (unmatched.length) warnings.push({ code: "unmatchedPeople", count: unmatched.length, names: unmatched.slice(0, NAMED_UNMATCHED) });

  const nameOf = (slackUserId: string, fallback?: string | null): string => matched.get(slackUserId)?.name ?? data.users.get(slackUserId)?.name ?? fallback ?? slackUserId;

  // Channels: those imported before stay; the others get a free name, chosen before any is written
  // so a message naming another channel names it as it will be called.
  const ids = new Map(data.channels.map((c) => [c.id, stableId("slack-channel", workspaceId, c.id)]));
  const existing = await db
    .select({ id: channel.id, name: channel.name })
    .from(channel)
    .where(and(eq(channel.workspaceId, workspaceId), ne(channel.kind, "direct")));
  const taken = new Set(existing.flatMap((c) => (c.name ? [c.name] : [])));
  const already = new Map(existing.filter((c) => [...ids.values()].includes(c.id)).map((c) => [c.id, c.name ?? ""]));
  const names = new Map<string, string>();
  for (const c of data.channels) {
    const id = ids.get(c.id)!;
    const before = already.get(id);
    if (before !== undefined) {
      names.set(c.id, before);
      warnings.push({ code: "alreadyImported", name: before });
      continue;
    }
    const name = freeName(c.name, taken);
    taken.add(name);
    names.set(c.id, name);
    if (name !== c.name) warnings.push({ code: "renamed", from: c.name, to: name });
  }
  const textNames: SlackNames = {
    user: (id) => ({ userId: matched.get(id)?.id ?? null, name: nameOf(id) }),
    channel: (id) => names.get(id) ?? null,
  };

  const result: SlackImportResult = { channels: [], created: { channels: 0, messages: 0, reactions: 0, files: 0 }, people: { matched: matched.size, unmatched: unmatched.length }, warnings };
  const budget = { downloads: options.download ? SLACK_LIMITS.downloads : 0, links: 0, reactionsLeftOut: 0 };
  for (const c of data.channels) {
    const id = ids.get(c.id)!;
    if (already.has(id)) continue;
    const count = await importChannel(userId, workspaceId, c, { id, name: names.get(c.id)!, matched, textNames, nameOf, budget, result });
    result.channels.push({ id, name: names.get(c.id)!, kind: c.kind, messages: count });
  }
  if (budget.reactionsLeftOut) warnings.push({ code: "reactionsLeftOut", count: budget.reactionsLeftOut });
  if (budget.links) warnings.push({ code: "filesAsLinks", count: budget.links });
  if (data.directConversations) warnings.push({ code: "directLeftOut", count: data.directConversations });
  if (data.repliesWithoutThread) warnings.push({ code: "repliesWithoutThread", count: data.repliesWithoutThread });
  return result;
}

type ChannelContext = {
  id: string;
  name: string;
  matched: Map<string, Person>;
  textNames: SlackNames;
  nameOf: (slackUserId: string, fallback?: string | null) => string;
  budget: { downloads: number; links: number; reactionsLeftOut: number };
  result: SlackImportResult;
};

/** One message as the row it becomes, its reactions and the files it should carry. */
type Planned = {
  row: typeof channelMessage.$inferInsert;
  reactions: { userId: string; emoji: string; createdAt: Date }[];
  files: SlackFile[];
};

async function importChannel(userId: string, workspaceId: string, c: SlackChannel, ctx: ChannelContext): Promise<number> {
  const { id, matched } = ctx;
  const authorOf = (m: SlackMessage) => (m.user ? (matched.get(m.user)?.id ?? null) : null);

  // Seq by ts; threads' counts from their replies, known before anything is written.
  const seqOf = new Map<string, number>();
  c.messages.forEach((m, i) => seqOf.set(m.ts, i + 1));
  const messageId = (m: SlackMessage) => stableId("slack-message", workspaceId, c.id, m.ts);
  const threads = new Map<string, { count: number; lastSeq: number; lastAt: Date; repliers: string[] }>();
  for (const m of c.messages) {
    if (!m.threadTs) continue;
    const thread = threads.get(m.threadTs) ?? { count: 0, lastSeq: 0, lastAt: new Date(0), repliers: [] };
    thread.count++;
    thread.lastSeq = seqOf.get(m.ts)!;
    thread.lastAt = new Date(m.time);
    const author = authorOf(m);
    if (author) thread.repliers = [author, ...thread.repliers.filter((r) => r !== author)].slice(0, REPLIERS);
    threads.set(m.threadTs, thread);
  }

  const planned: Planned[] = c.messages.map((m) => {
    const author = authorOf(m);
    const seen = new Set<string>();
    const reactions: Planned["reactions"] = [];
    for (const r of m.reactions) {
      const emoji = slackEmoji(r.name);
      for (const slackUser of r.users) {
        const reactor = matched.get(slackUser)?.id;
        if (!emoji || !isEmoji(emoji) || !reactor) {
          ctx.budget.reactionsLeftOut++;
          continue;
        }
        if (seen.has(`${reactor}\n${emoji}`)) continue;
        seen.add(`${reactor}\n${emoji}`);
        reactions.push({ userId: reactor, emoji, createdAt: new Date(m.time) });
      }
    }
    const thread = threads.get(m.ts);
    const name = m.user ? ctx.nameOf(m.user, m.name) : (m.name ?? "?");
    const data: MessageData | null = author || m.deleted ? null : { importedFrom: { source: "slack", name } };
    const body = m.deleted ? "" : slackBody(m.text, ctx.textNames).slice(0, MESSAGE_LIMITS.body);
    return {
      row: {
        id: messageId(m),
        channelId: id,
        workspaceId,
        seq: seqOf.get(m.ts)!,
        threadId: m.threadTs ? stableId("slack-message", workspaceId, c.id, m.threadTs) : null,
        authorId: author,
        body,
        plain: plainText(body),
        data,
        alsoInChannel: m.broadcast,
        replyCount: thread?.count ?? 0,
        lastReplySeq: thread?.lastSeq ?? 0,
        lastReplyAt: thread?.lastAt ?? null,
        repliers: thread?.repliers ?? [],
        editedAt: m.edited ? new Date(m.edited) : null,
        deletedAt: m.deleted ? new Date(m.time) : null,
        createdAt: new Date(m.time),
      },
      reactions,
      files: m.files,
    };
  });
  const lastSeq = planned.length;
  // When the latest message shown in the channel (not a reply only in its thread) up to each seq came.
  const shownAt: (number | null)[] = [];
  for (const m of c.messages) shownAt.push(!m.threadTs || m.broadcast ? m.time : (shownAt.at(-1) ?? null));

  // Who is in it: the members who matched (guests only in a private channel), its maker and the
  // importing owner as its admins, so even a channel no one matched has someone who sees it.
  const creator = c.creator ? matched.get(c.creator) : undefined;
  const people = new Map<string, "admin" | "member">();
  for (const slackUser of c.members) {
    const person = matched.get(slackUser);
    if (person && (person.role !== "guest" || c.kind === "private")) people.set(person.id, "member");
  }
  if (creator && (creator.role !== "guest" || c.kind === "private")) people.set(creator.id, "admin");
  people.set(userId, "admin");

  const now = new Date();
  const createdAt = new Date(Math.min(c.created ?? Infinity, c.messages[0]?.time ?? Infinity, now.getTime()));
  await write(workspaceId, async (tx, changed) => {
    await tx.insert(channel).values({
      id,
      workspaceId,
      kind: c.kind,
      name: ctx.name,
      topic: slackPlainText(c.topic, ctx.textNames).slice(0, MESSAGE_LIMITS.topic),
      description: slackPlainText(c.purpose, ctx.textNames).slice(0, MESSAGE_LIMITS.description),
      createdBy: creator?.id ?? userId,
      createdAt,
      archivedAt: c.archived ? now : null,
      archivedBy: c.archived ? userId : null,
      rev: changed.rev,
    });
    // Everyone starts with the whole history read: it comes in as it was, not as news.
    await tx.insert(channelMember).values(
      [...people].map(([uid, role]) => ({ channelId: id, userId: uid, workspaceId, role, lastReadSeq: lastSeq, rev: changed.rev })),
    );
    changed.channel(id);
    for (const uid of people.keys()) changed.member(id, uid);
    await recordAudit(
      { workspaceId, actorId: userId, action: "channel.imported", target: { type: "channel", id, label: `#${ctx.name}` }, details: { kind: c.kind, source: "slack", messages: lastSeq } },
      tx,
    );
  });
  ctx.result.created.channels++;

  try {
    for (let start = 0; start < planned.length; start += SLACK_LIMITS.chunk) {
      const piece = planned.slice(start, start + SLACK_LIMITS.chunk);
      // Files first (a download can take a while; no write waits on it), linked when they can't be had.
      const attached: { messageId: string; download: Download; uploader: string }[] = [];
      for (const p of piece) {
        const links: string[] = [];
        for (const f of p.files) {
          const got = ctx.budget.downloads > 0 ? await download(workspaceId, userId, f) : null;
          if (got) {
            ctx.budget.downloads--;
            attached.push({ messageId: p.row.id, download: got, uploader: p.row.authorId ?? userId });
            continue;
          }
          const href = f.permalink ?? null;
          links.push(href ? `[${f.name.replace(/[[\]\\]/g, "")}](${href.replace(/[()\s]/g, encodeURIComponent)})` : f.name);
          ctx.budget.links++;
        }
        if (links.length) {
          const body = [p.row.body, ...links].filter(Boolean).join("\n").slice(0, MESSAGE_LIMITS.body);
          p.row.body = body;
          p.row.plain = plainText(body);
        }
      }
      const end = start + piece.length;
      const lastAt = shownAt[end - 1];
      const written = await write(workspaceId, async (tx, changed) => {
        await tx.insert(channelMessage).values(piece.map((p) => ({ ...p.row, rev: changed.rev })));
        const reactions = piece.flatMap((p) => p.reactions.map((r) => ({ messageId: p.row.id, ...r })));
        for (let i = 0; i < reactions.length; i += SLACK_LIMITS.chunk) {
          await tx.insert(messageReaction).values(reactions.slice(i, i + SLACK_LIMITS.chunk)).onConflictDoNothing();
        }
        if (attached.length) {
          await tx.insert(messageFile).values(attached.map((a) => ({ fileId: a.download.fileId, channelId: id, messageId: a.messageId, userId: a.uploader })));
          await tx
            .update(file)
            .set({ referencedAt: new Date() })
            .where(
              inArray(
                file.id,
                attached.map((a) => a.download.fileId),
              ),
            );
        }
        await tx
          .update(channel)
          .set({ lastSeq: end, rev: changed.rev, ...(lastAt !== null ? { lastMessageAt: new Date(lastAt) } : {}) })
          .where(eq(channel.id, id));
        changed.channel(id);
        return reactions.length;
      });
      ctx.result.created.messages += piece.length;
      ctx.result.created.reactions += written;
      ctx.result.created.files += attached.length;
    }
  } catch (error) {
    // Half a channel would pass for all of it (and an import again would leave it be): it goes.
    await write(workspaceId, async (tx, changed) => {
      await tx.delete(channel).where(eq(channel.id, id));
      // Its people hear it is gone (announce.ts: left, and no longer to be seen); others drop it on their next sync.
      for (const uid of people.keys()) changed.left(id, uid);
    }).catch((cleanup) => console.error("[messages] could not remove a channel whose import failed", cleanup));
    ctx.result.created.channels--;
    throw error;
  }
  return lastSeq;
}
