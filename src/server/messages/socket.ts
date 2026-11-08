/**
 * The Messages websocket (lib/message-wire.ts MESSAGES_PATH; server.ts routes the upgrade here):
 * signed in with the session cookie, read from the database each time, for one workspace (`?w=`)
 * whose sign-in policies the session passes, checked again every few minutes. A browser calls
 * operations by name (`call` frames, answered by `result` frames with the same id) and is sent what
 * changes for it (announce.ts), who types, who is here and who has its channel open (hub.ts).
 *
 * Every call runs as the connection's person through the same functions as everything else, with
 * that person's access worked out when it runs. Ids a call names must belong to the connection's
 * workspace, so another workspace's policies can't be walked around through this one's connection.
 */
import type { Hooks, Peer } from "crossws";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelMember, channelMessage } from "@/db/schema";
import { auth } from "@/lib/auth";
import { isStrongSession } from "@/lib/auth-security";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import type { ClientFrame, ServerFrame } from "@/lib/message-wire";
import { PING_EVERY_MS } from "@/lib/message-wire";
import { TYPING_EVERY_MS } from "@/lib/messages";
import { policyHoldFor, type SessionFacts } from "@/server/access";
import "./announce";
import {
  addMembers,
  browseChannels,
  changeSection,
  channelPeople,
  createChannel,
  joinChannel,
  leaveChannel,
  openDirect,
  removeMember,
  setArchived,
  setMemberRole,
  setPreferences,
  setStatus,
  updateChannel,
} from "./channels";
import { catchUp } from "./catch-up";
import { callError, MessageError, requireChannel, workspaceRole } from "./core";
import { addConnection, announceTyping, removeConnection, setActive, setViewing, type Connection } from "./hub";
import {
  channelHistory,
  deleteMessage,
  editMessage,
  followThread,
  forwardMessage,
  markAllRead,
  markRead,
  markUnread,
  mentionsOf,
  messageHistory,
  messagesById,
  pin,
  pinnedMessages,
  react,
  reactionsTo,
  readThread,
  saveDraft,
  saveForLater,
  sendMessage,
  threadMessages,
} from "./posts";
import { cancelScheduled, scheduleMessage } from "./scheduled";
import { searchMessages } from "./search";
import { bootstrap, peopleFor, sync } from "./sync";
import { messageToTask } from "./to-task";

/** Policies and membership are asked again this often while a connection stays open. */
const RECHECK_MS = 5 * 60_000;
/** A connection that says nothing (not even a ping) for this long is gone. */
const IDLE_MS = PING_EVERY_MS * 2 + 10_000;
/** The largest frame a browser sends: a message of the longest body, escaped, with room to spare. */
export const MAX_MESSAGE_FRAME_BYTES = 512 * 1024;

type Who = { userId: string; sessionId: string; workspaceId: string; facts: SessionFacts };

/** Who an upgrade request signed in as, for which workspace; null when no one or not allowed there. */
export async function authenticateMessages(request: Request): Promise<Who | null> {
  const workspaceId = new URL(request.url, "http://localhost").searchParams.get("w");
  if (!workspaceId) return null;
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } }).catch(() => null);
  if (!session) return null;
  const ip = request.headers.get(CLIENT_IP_HEADER);
  const facts: SessionFacts = {
    strong: isStrongSession(session),
    ssoProviderId: (session.session as { ssoProviderId?: string | null }).ssoProviderId ?? null,
    ip: ip && ip !== "unknown" ? ip : null,
  };
  return { userId: session.user.id, sessionId: session.session.id, workspaceId, facts };
}

/** Why the person may not use this connection now, or null. */
async function heldBack(who: Who): Promise<"removed" | "policy" | null> {
  try {
    await workspaceRole(who.userId, who.workspaceId);
  } catch {
    return "removed";
  }
  return (await policyHoldFor(who.userId, who.workspaceId, who.facts)) ? "policy" : null;
}

/** A token bucket: `size` calls at once, `perSecond` more each second. */
class Bucket {
  private tokens: number;
  private at = Date.now();
  constructor(
    private size: number,
    private perSecond: number,
  ) {
    this.tokens = size;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.size, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

type Link = {
  connection: Connection;
  who: Who;
  calls: Bucket;
  sends: Bucket;
  typedAt: Map<string, number>;
  idle: NodeJS.Timeout;
  recheck: NodeJS.Timeout;
  closed: boolean;
};

type Args = Record<string, unknown>;
type Op = (link: Link, a: Args) => Promise<unknown> | unknown;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The workspace of the channel or message an id names, or null when there is none. */
async function workspaceOf(kind: "channel" | "message", id: string): Promise<string | null> {
  if (!id) return null;
  const [row] =
    kind === "channel"
      ? await db.select({ workspaceId: channel.workspaceId }).from(channel).where(eq(channel.id, id)).limit(1)
      : await db.select({ workspaceId: channelMessage.workspaceId }).from(channelMessage).where(eq(channelMessage.id, id)).limit(1);
  return row?.workspaceId ?? null;
}

/** Refuses a call naming a channel or message of another workspace, the same way as a missing one. */
async function withinWorkspace(link: Link, a: Args) {
  const checks: Promise<string | null>[] = [];
  if (typeof a.channelId === "string") checks.push(workspaceOf("channel", a.channelId));
  for (const key of ["messageId", "threadId"] as const) if (typeof a[key] === "string" && a[key]) checks.push(workspaceOf("message", a[key] as string));
  for (const found of await Promise.all(checks)) if (found !== link.who.workspaceId) throw new MessageError("notFound");
}

const OPS: Record<string, Op> = {
  bootstrap: (l) => bootstrap(l.who.userId, l.who.workspaceId),
  sync: (l, a) => sync(l.who.userId, l.who.workspaceId, a.since),
  history: (l, a) => channelHistory(l.who.userId, a),
  thread: (l, a) => threadMessages(l.who.userId, a.threadId),
  byId: async (l, a) => {
    const views = await messagesById(l.who.userId, a.ids);
    const channelIds = [...new Set(views.map((m) => m.channelId))];
    if (!channelIds.length) return views;
    const here = new Set(
      (await db.select({ id: channel.id }).from(channel).where(and(eq(channel.workspaceId, l.who.workspaceId), inArray(channel.id, channelIds)))).map((c) => c.id),
    );
    return views.filter((m) => here.has(m.channelId));
  },
  send: (l, a) => {
    if (!l.sends.take()) throw new MessageError("rateLimited");
    return sendMessage(l.who.userId, { id: a.id, channelId: a.channelId, threadId: a.threadId, body: a.body, fileIds: a.fileIds, alsoInChannel: a.alsoInChannel });
  },
  forward: (l, a) => {
    if (!l.sends.take()) throw new MessageError("rateLimited");
    return forwardMessage(l.who.userId, { messageId: a.messageId, channelId: a.channelId, body: a.body, id: a.id });
  },
  edit: (l, a) => editMessage(l.who.userId, a.messageId, { body: a.body }),
  delete: (l, a) => deleteMessage(l.who.userId, a.messageId),
  versions: (l, a) => messageHistory(l.who.userId, a.messageId),
  react: (l, a) => react(l.who.userId, a.messageId, a.emoji, a.on),
  pin: (l, a) => pin(l.who.userId, a.messageId, a.on === true),
  pinned: (l, a) => pinnedMessages(l.who.userId, a.channelId),
  read: (l, a) => markRead(l.who.userId, a.channelId, a.seq),
  unread: (l, a) => markUnread(l.who.userId, a.channelId, a.seq),
  readAll: (l) => markAllRead(l.who.userId, l.who.workspaceId),
  readThread: (l, a) => readThread(l.who.userId, a.threadId, a.seq),
  follow: (l, a) => followThread(l.who.userId, a.threadId, a.following),
  typing: async (l, a) => {
    const channelId = str(a.channelId);
    const threadId = typeof a.threadId === "string" && a.threadId ? a.threadId : null;
    const key = `${channelId}\n${threadId ?? ""}`;
    const last = l.typedAt.get(key) ?? 0;
    // Browsers say it every TYPING_EVERY_MS while one types; more often is dropped, not refused.
    if (Date.now() - last < TYPING_EVERY_MS - 500) return null;
    l.typedAt.set(key, Date.now());
    const { member } = await requireChannel(l.who.userId, channelId, "write");
    if (!member) return null;
    const people = await db.select({ userId: channelMember.userId }).from(channelMember).where(eq(channelMember.channelId, channelId));
    announceTyping(
      l.who.workspaceId,
      people.map((p) => p.userId),
      { t: "typing", channelId, threadId, userId: l.who.userId },
    );
    return null;
  },
  view: async (l, a) => {
    const channelId = typeof a.channelId === "string" && a.channelId ? a.channelId : null;
    if (channelId) await requireChannel(l.who.userId, channelId);
    setViewing(l.connection, channelId);
    return null;
  },
  active: (l, a) => {
    setActive(l.connection, a.active === true);
    return null;
  },
  create: (l, a) => createChannel(l.who.userId, l.who.workspaceId, a),
  direct: (l, a) => openDirect(l.who.userId, l.who.workspaceId, a.userIds),
  update: (l, a) => updateChannel(l.who.userId, str(a.channelId), a),
  join: (l, a) => joinChannel(l.who.userId, str(a.channelId)),
  leave: (l, a) => leaveChannel(l.who.userId, str(a.channelId)),
  add: (l, a) => addMembers(l.who.userId, str(a.channelId), a.userIds),
  remove: (l, a) => removeMember(l.who.userId, str(a.channelId), a.userId),
  role: (l, a) => setMemberRole(l.who.userId, str(a.channelId), a.userId, a.role),
  archive: (l, a) => setArchived(l.who.userId, str(a.channelId), a.archived === true),
  prefs: (l, a) => setPreferences(l.who.userId, str(a.channelId), a),
  section: (l, a) => changeSection(l.who.userId, l.who.workspaceId, a),
  browse: (l, a) => browseChannels(l.who.userId, l.who.workspaceId, a.query),
  members: (l, a) => channelPeople(l.who.userId, str(a.channelId)),
  search: (l, a) => searchMessages(l.who.userId, l.who.workspaceId, a),
  save: (l, a) => saveForLater(l.who.userId, a.messageId, a),
  draft: (l, a) => saveDraft(l.who.userId, a),
  schedule: (l, a) => scheduleMessage(l.who.userId, a),
  cancel: (l, a) => cancelScheduled(l.who.userId, l.who.workspaceId, a.id),
  mentions: (l, a) => mentionsOf(l.who.userId, l.who.workspaceId, a.before),
  reactions: (l) => reactionsTo(l.who.userId, l.who.workspaceId),
  status: (l, a) => setStatus(l.who.userId, l.who.workspaceId, a),
  task: (l, a) => messageToTask(l.who.userId, a.messageId),
  catchUp: (l, a) => catchUp(l.who.userId, a),
};

/** The operations a browser may call, for tests and the client's types. */
export const MESSAGE_OPS = Object.keys(OPS);

async function answer(link: Link, frame: Extract<ClientFrame, { t: "call" }>) {
  const reply = (out: ServerFrame) => !link.closed && link.connection.send(out);
  const op = Object.hasOwn(OPS, frame.op) ? OPS[frame.op] : undefined;
  if (!op) return reply({ t: "result", id: frame.id, ok: false, error: { code: "invalid", message: `No operation ${frame.op}` } });
  if (!link.calls.take()) return reply({ t: "result", id: frame.id, ok: false, error: { code: "rateLimited", message: "Too many calls" } });
  try {
    const args = (frame.args && typeof frame.args === "object" && !Array.isArray(frame.args) ? frame.args : {}) as Args;
    await withinWorkspace(link, args);
    const data = await op(link, args);
    reply({ t: "result", id: frame.id, ok: true, data: data ?? null });
  } catch (error) {
    reply({ t: "result", id: frame.id, ok: false, error: callError(error) });
  }
}

function parse(text: string): ClientFrame | null {
  try {
    const frame = JSON.parse(text) as ClientFrame;
    if (frame?.t === "ping") return frame;
    if (frame?.t === "call" && Number.isInteger(frame.id) && typeof frame.op === "string") return frame;
  } catch {}
  return null;
}

/** The Messages websocket hooks, for server.ts's crossws server on MESSAGES_PATH. */
export function messagesHooks(): Partial<Hooks> {
  const links = new WeakMap<Peer, Link>();

  const end = (link: Link) => {
    if (link.closed) return;
    link.closed = true;
    clearTimeout(link.idle);
    clearInterval(link.recheck);
    removeConnection(link.connection);
  };

  return {
    async upgrade(request) {
      const who = await authenticateMessages(request);
      if (!who) throw new Response("Unauthorized", { status: 401 });
      const held = await heldBack(who);
      if (held) throw new Response(held === "policy" ? "Held back by the workspace's sign-in policies" : "Not found", { status: held === "policy" ? 403 : 404 });
      return { context: { messages: who } };
    },
    async open(peer) {
      const who = peer.context.messages as Who | undefined;
      if (!who) return peer.close(4401, "Unauthorized");
      let guest = false;
      let knows: Set<string> | null = null;
      try {
        guest = (await workspaceRole(who.userId, who.workspaceId)) === "guest";
        if (guest) knows = new Set((await peopleFor(who.userId, who.workspaceId, true)).map((p) => p.id));
      } catch {
        return peer.close(4403, "Removed");
      }
      const connection: Connection = {
        id: crypto.randomUUID(),
        userId: who.userId,
        sessionId: who.sessionId,
        workspaceId: who.workspaceId,
        guest,
        knows,
        active: false,
        viewing: null,
        send: (frame) => {
          try {
            peer.send(JSON.stringify(frame));
          } catch {}
        },
        close: (code, reason) => peer.close(code, reason),
      };
      const link: Link = {
        connection,
        who,
        calls: new Bucket(120, 20),
        sends: new Bucket(20, 1),
        typedAt: new Map(),
        idle: setTimeout(() => peer.close(4408, "Idle"), IDLE_MS),
        recheck: setInterval(() => {
          heldBack(who).then(
            (held) => {
              if (!held || link.closed) return;
              connection.send({ t: "closed", reason: held });
              peer.close(held === "policy" ? 4403 : 4404, held);
            },
            () => {},
          );
        }, RECHECK_MS),
        closed: false,
      };
      link.idle.unref?.();
      link.recheck.unref?.();
      links.set(peer, link);
      addConnection(connection);
      connection.send({ t: "hello", connectionId: connection.id, userId: who.userId });
    },
    message(peer, message) {
      const link = links.get(peer);
      if (!link || link.closed) return;
      link.idle.refresh();
      const frame = parse(message.text());
      if (!frame) return;
      if (frame.t === "ping") return link.connection.send({ t: "pong" });
      void answer(link, frame);
    },
    close(peer) {
      const link = links.get(peer);
      if (link) end(link);
      links.delete(peer);
    },
    error(peer, error) {
      console.error("messages websocket error", peer.id, error);
    },
  };
}

