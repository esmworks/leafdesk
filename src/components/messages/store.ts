"use client";

import { useMemo, useSyncExternalStore } from "react";
import { snippet } from "@/lib/message-text";
import { MESSAGES_PATH, PING_EVERY_MS, type Bootstrap, type Changes, type ChannelView, type DraftView, type MembershipView, type MessageView, type PersonView, type Presence, type SavedView, type ScheduledView, type SectionView, type ServerFrame, type StatusView, type ThreadView } from "@/lib/message-wire";
import { TYPING_EVERY_MS, TYPING_SHOWN_MS } from "@/lib/messages";

/**
 * The browser's side of team messages: one websocket per tab to the workspace's Messages server
 * (server/messages/socket.ts) and everything it was told, shared by the rail's count, the sidebar's
 * list and the Messages page. Loaded after a workspace page shows (sidebar.tsx imports it lazily),
 * so the first load doesn't carry it.
 *
 * It keeps the `rev` of its last `bootstrap` or `sync`, never of a live change: after a lost
 * connection `sync` brings everything since then from the rows themselves, live changes missed
 * included, and changes are idempotent, so applying one twice is harmless. Sending is optimistic:
 * a message shows at once under the id the browser made for it, which the server keeps, so a send
 * retried after a lost connection is stored once.
 */

export type Pending = { id: string; channelId: string; threadId: string | null; body: string; fileIds: string[]; alsoInChannel: boolean; failed: boolean; createdAt: string };

/** A channel's main list as far as it is loaded: message ids by `seq`, and whether more lie before or after. */
export type Timeline = { ids: string[]; hasBefore: boolean; hasAfter: boolean };

export type Status = "connecting" | "open" | "offline" | "closed";

export type MessagesState = {
  workspaceId: string | null;
  status: Status;
  /** Why the server ended the connection for good (signed out, held back, removed). */
  closedReason: "signedOut" | "policy" | "removed" | null;
  ready: boolean;
  me: string;
  people: Map<string, PersonView>;
  presence: Record<string, Presence>;
  channels: Map<string, ChannelView>;
  memberships: Map<string, MembershipView>;
  threads: Map<string, ThreadView>;
  drafts: Map<string, DraftView>;
  saved: Map<string, SavedView>;
  sections: Map<string, SectionView>;
  statuses: Map<string, StatusView>;
  scheduled: Map<string, ScheduledView>;
  messages: Map<string, MessageView>;
  timelines: Map<string, Timeline>;
  replies: Map<string, string[]>;
  pending: Map<string, Pending>;
  /** `${channelId}\n${threadId}` → who types there, until when. */
  typing: Map<string, Map<string, number>>;
  viewers: Map<string, string[]>;
  /** How far others read, in small channels: channelId → userId → seq. */
  reads: Map<string, Map<string, number>>;
  /** A channel's people changed since it was listed: bumps when `roster` names it. */
  rosterVersion: Map<string, number>;
  /** Unread messages that came after a membership was last counted by the server, per channel. */
  liveUnread: Map<string, Set<string>>;
  /** The channel's last `seq` when the server last counted its unread for the person: later ones are `liveUnread`. */
  countedTo: Map<string, number>;
};

const empty = (): MessagesState => ({
  workspaceId: null,
  status: "connecting",
  closedReason: null,
  ready: false,
  me: "",
  people: new Map(),
  presence: {},
  channels: new Map(),
  memberships: new Map(),
  threads: new Map(),
  drafts: new Map(),
  saved: new Map(),
  sections: new Map(),
  statuses: new Map(),
  scheduled: new Map(),
  messages: new Map(),
  timelines: new Map(),
  replies: new Map(),
  pending: new Map(),
  typing: new Map(),
  viewers: new Map(),
  reads: new Map(),
  rosterVersion: new Map(),
  liveUnread: new Map(),
  countedTo: new Map(),
});

let state = empty();
const listeners = new Set<() => void>();

function set(next: Partial<MessagesState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A part of the messages state; the component draws again only when that part is another object. */
export function useMessages<T>(select: (s: MessagesState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(state),
    () => select(state),
  );
}

export const messagesState = () => state;

/** What a message row reads: parts that change seldom, so rows don't draw again as someone types. */
export type View = Pick<MessagesState, "me" | "people" | "presence" | "channels" | "threads" | "saved" | "statuses">;

export function useView(): View {
  const me = useMessages((x) => x.me);
  const people = useMessages((x) => x.people);
  const presence = useMessages((x) => x.presence);
  const channels = useMessages((x) => x.channels);
  const threads = useMessages((x) => x.threads);
  const saved = useMessages((x) => x.saved);
  const statuses = useMessages((x) => x.statuses);
  return useMemo(() => ({ me, people, presence, channels, threads, saved, statuses }), [me, people, presence, channels, threads, saved, statuses]);
}

export const draftKey = (channelId: string, threadId: string | null | undefined) => `${channelId}\n${threadId ?? ""}`;
const typingKey = draftKey;

/** Whether a message shows in its channel's main list. */
export const inMainList = (m: Pick<MessageView, "threadId" | "alsoInChannel">) => !m.threadId || m.alsoInChannel;

// ----------------------------------------------------------------------------------- applying

const bySeq = (messages: Map<string, MessageView>) => (a: string, b: string) => (messages.get(a)?.seq ?? 0) - (messages.get(b)?.seq ?? 0);

function putSorted(ids: string[], id: string, messages: Map<string, MessageView>): string[] {
  if (ids.includes(id)) return ids;
  const seq = messages.get(id)?.seq ?? 0;
  let at = ids.length;
  while (at > 0 && (messages.get(ids[at - 1])?.seq ?? 0) > seq) at--;
  return [...ids.slice(0, at), id, ...ids.slice(at)];
}

function apply(d: Changes, from: "live" | "sync") {
  const next: Partial<MessagesState> = {};
  const copy = <K extends keyof MessagesState>(key: K): MessagesState[K] => {
    if (!(key in next)) (next as Record<string, unknown>)[key] = new Map(state[key] as Map<unknown, unknown>);
    return next[key] as MessagesState[K];
  };

  if (d.channels?.length) {
    const channels = copy("channels");
    for (const c of d.channels) {
      const known = channels.get(c.id);
      if (!known || known.rev <= c.rev) channels.set(c.id, c);
    }
  }
  if (d.goneChannels?.length) {
    const channels = copy("channels");
    const memberships = copy("memberships");
    const timelines = copy("timelines");
    for (const id of d.goneChannels) {
      channels.delete(id);
      memberships.delete(id);
      timelines.delete(id);
    }
  }
  if (d.memberships?.length) {
    const memberships = copy("memberships");
    const live = copy("liveUnread");
    const counted = copy("countedTo");
    const channels = (next.channels ?? state.channels) as Map<string, ChannelView>;
    for (const m of d.memberships) {
      const known = memberships.get(m.channelId);
      if (known && known.rev > m.rev) continue;
      memberships.set(m.channelId, m);
      // The server counted this channel's unread just now, up to the channel's last message as it came along.
      live.delete(m.channelId);
      counted.set(m.channelId, Math.max(channels.get(m.channelId)?.lastSeq ?? 0, m.lastReadSeq));
    }
  }
  if (d.leftChannels?.length) {
    const memberships = copy("memberships");
    for (const id of d.leftChannels) memberships.delete(id);
  }
  if (d.messages?.length) {
    const messages = copy("messages");
    const timelines = copy("timelines");
    const replies = copy("replies");
    const pending = copy("pending");
    const live = copy("liveUnread");
    const memberships = (next.memberships ?? state.memberships) as Map<string, MembershipView>;
    const counted = (next.countedTo ?? state.countedTo) as Map<string, number>;
    for (const m of d.messages) {
      const known = messages.get(m.id);
      if (known && known.rev > m.rev) continue;
      messages.set(m.id, m);
      pending.delete(m.id);
      if (inMainList(m)) {
        const line = timelines.get(m.channelId);
        if (line && !line.hasAfter) timelines.set(m.channelId, { ...line, ids: putSorted(line.ids, m.id, messages) });
        // Counted as unread when it came after the server's last count and isn't the person's own.
        const member = memberships.get(m.channelId);
        if (member && m.authorId !== state.me && m.kind === "message" && !m.deletedAt && m.seq > Math.max(member.lastReadSeq, counted.get(m.channelId) ?? 0)) {
          const set = new Set(live.get(m.channelId));
          set.add(m.id);
          live.set(m.channelId, set);
        } else if (m.deletedAt && live.get(m.channelId)?.has(m.id)) {
          const set = new Set(live.get(m.channelId));
          set.delete(m.id);
          live.set(m.channelId, set);
        }
      }
      if (m.threadId) {
        const list = replies.get(m.threadId);
        if (list) replies.set(m.threadId, putSorted(list, m.id, messages));
      }
    }
  }
  if (d.threads?.length) {
    const threads = copy("threads");
    for (const t of d.threads) {
      const known = threads.get(t.threadId);
      if (!known || known.rev <= t.rev) threads.set(t.threadId, t);
    }
  }
  if (d.drafts?.length) {
    const drafts = copy("drafts");
    for (const x of d.drafts) drafts.set(draftKey(x.channelId, x.threadId), x);
  }
  if (d.goneDrafts?.length) {
    const drafts = copy("drafts");
    for (const x of d.goneDrafts) drafts.delete(draftKey(x.channelId, x.threadId));
  }
  if (d.saved?.length) {
    const saved = copy("saved");
    for (const x of d.saved) saved.set(x.messageId, x);
  }
  if (d.goneSaved?.length) {
    const saved = copy("saved");
    for (const id of d.goneSaved) saved.delete(id);
  }
  if (d.sections?.length) {
    const sections = copy("sections");
    for (const x of d.sections) sections.set(x.id, x);
  }
  if (d.goneSections?.length) {
    const sections = copy("sections");
    for (const id of d.goneSections) sections.delete(id);
  }
  if (d.statuses?.length) {
    const statuses = copy("statuses");
    for (const x of d.statuses) statuses.set(x.userId, x);
  }
  if (d.scheduled?.length) {
    const scheduled = copy("scheduled");
    for (const x of d.scheduled) scheduled.set(x.id, x);
  }
  if (d.goneScheduled?.length) {
    const scheduled = copy("scheduled");
    for (const id of d.goneScheduled) scheduled.delete(id);
  }
  if (d.roster?.length) {
    const roster = copy("rosterVersion");
    for (const id of d.roster) roster.set(id, (roster.get(id) ?? 0) + 1);
  }
  if (d.reads?.length) {
    const reads = copy("reads");
    for (const r of d.reads) {
      const of = new Map(reads.get(r.channelId));
      of.set(r.userId, Math.max(of.get(r.userId) ?? 0, r.seq));
      reads.set(r.channelId, of);
    }
  }
  void from;
  if (Object.keys(next).length) set(next);
}

/** Drops what a sync says is gone: what it keeps whole and no longer lists. */
function dropMissing(keep: { channels: string[]; memberships: string[]; drafts: string[]; saved: string[]; sections: string[]; scheduled: string[] }) {
  const only = <V>(map: Map<string, V>, ids: string[]) => {
    const wanted = new Set(ids);
    return new Map([...map].filter(([id]) => wanted.has(id)));
  };
  set({
    channels: only(state.channels, keep.channels),
    memberships: only(state.memberships, keep.memberships),
    drafts: only(state.drafts, keep.drafts),
    saved: only(state.saved, keep.saved),
    sections: only(state.sections, keep.sections),
    scheduled: only(state.scheduled, keep.scheduled),
  });
}

// ----------------------------------------------------------------------------------- connection

type Waiting = { resolve: (data: unknown) => void; reject: (error: MessagesError) => void; timer: ReturnType<typeof setTimeout> };

export class MessagesError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const CALL_TIMEOUT_MS = 30_000;
const PONG_WAIT_MS = 10_000;
const RETRY_MAX_MS = 30_000;
/** The tab counts as in use this long after the last key or pointer move. */
const IDLE_AFTER_MS = 5 * 60_000;

let socket: WebSocket | null = null;
let workspace: string | null = null;
let users = 0;
let nextId = 1;
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let pongTimer: ReturnType<typeof setTimeout> | undefined;
/** The rev of the last bootstrap or sync. */
let rev = 0;
let helloed = false;
const waiting = new Map<number, Waiting>();
/** Calls made while the connection is down, sent once it is open again. */
let queued: { id: number; op: string; args: unknown }[] = [];
let lastInput = Date.now();
let wasActive: boolean | null = null;
let viewing: string | null = null;

function send(frame: unknown) {
  if (socket?.readyState === WebSocket.OPEN && helloed) socket.send(JSON.stringify(frame));
}

/** Calls an operation of the Messages server; waits for the connection while it is down. */
export function call<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      queued = queued.filter((q) => q.id !== id);
      reject(new MessagesError("offline", "No answer"));
    }, CALL_TIMEOUT_MS);
    waiting.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
    if (socket?.readyState === WebSocket.OPEN && helloed) send({ t: "call", id, op, args });
    else queued.push({ id, op, args });
  });
}

function onFrame(frame: ServerFrame) {
  switch (frame.t) {
    case "hello":
      helloed = true;
      attempts = 0;
      void start();
      return;
    case "result": {
      const w = waiting.get(frame.id);
      if (!w) return;
      waiting.delete(frame.id);
      clearTimeout(w.timer);
      if (frame.ok) w.resolve(frame.data);
      else w.reject(new MessagesError(frame.error.code, frame.error.message));
      return;
    }
    case "changes":
      apply(frame.d, "live");
      return;
    case "typing": {
      if (frame.userId === state.me) return;
      const key = typingKey(frame.channelId, frame.threadId);
      const typing = new Map(state.typing);
      const here = new Map(typing.get(key));
      here.set(frame.userId, Date.now() + TYPING_SHOWN_MS);
      typing.set(key, here);
      set({ typing });
      setTimeout(dropOldTyping, TYPING_SHOWN_MS + 50);
      return;
    }
    case "presence":
      set({ presence: { ...state.presence, [frame.userId]: frame.state } });
      return;
    case "viewers":
      set({ viewers: new Map(state.viewers).set(frame.channelId, frame.userIds) });
      return;
    case "pong":
      clearTimeout(pongTimer);
      return;
    case "closed":
      set({ status: "closed", closedReason: frame.reason });
      return;
  }
}

function dropOldTyping() {
  const now = Date.now();
  let changed = false;
  const typing = new Map<string, Map<string, number>>();
  for (const [key, who] of state.typing) {
    const still = new Map([...who].filter(([, until]) => until > now));
    if (still.size !== who.size) changed = true;
    if (still.size) typing.set(key, still);
  }
  if (changed) set({ typing });
}

/** After hello: catches up (or loads afresh), then sends what waited. */
async function start() {
  const ws = workspace;
  try {
    if (rev > 0 && state.ready) {
      const answer = await call<{ reset: true; rev: number } | (Changes & { reset?: false; keep: Parameters<typeof dropMissing>[0] })>("sync", { since: rev });
      if (ws !== workspace) return;
      if (answer.reset) await load();
      else {
        apply(answer, "sync");
        dropMissing(answer.keep);
        rev = answer.rev;
      }
    } else await load();
  } catch {
    // Tried again on the next connection.
  }
  if (ws !== workspace) return;
  set({ status: "open" });
  const waitingCalls = queued;
  queued = [];
  for (const q of waitingCalls) send({ t: "call", ...q });
  wasActive = null;
  reportActive();
  if (viewing) void call("view", { channelId: viewing }).catch(() => {});
  // A send that failed while away is tried again.
  for (const p of state.pending.values()) if (!p.failed) void deliver(p);
}

async function load() {
  const data = await call<Bootstrap>("bootstrap");
  const keepPending = state.pending;
  const fresh = empty();
  fresh.workspaceId = workspace;
  fresh.status = state.status;
  fresh.me = data.me;
  fresh.people = new Map(data.people.map((p) => [p.id, p]));
  fresh.presence = data.presence;
  fresh.pending = keepPending;
  // Timelines start again from the newest messages.
  state = fresh;
  apply({ ...data, rev: data.rev }, "sync");
  rev = data.rev;
  set({ ready: true });
}

function connect() {
  if (!workspace || typeof window === "undefined") return;
  clearTimeout(retryTimer);
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${window.location.host}${MESSAGES_PATH}?w=${encodeURIComponent(workspace)}`);
  socket = ws;
  helloed = false;
  set({ status: state.ready ? "offline" : "connecting" });
  ws.onmessage = (e) => {
    if (socket !== ws) return;
    try {
      onFrame(JSON.parse(String(e.data)) as ServerFrame);
    } catch {}
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    socket = null;
    helloed = false;
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    // Signed out, held back or removed: no point trying again until the page loads.
    if (e.code === 4401 || e.code === 4403 || e.code === 4404 || state.status === "closed") {
      set({ status: "closed", closedReason: state.closedReason ?? (e.code === 4401 ? "signedOut" : e.code === 4403 ? "policy" : "removed") });
      return;
    }
    set({ status: "offline" });
    scheduleRetry();
  };
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: "ping" }));
    clearTimeout(pongTimer);
    pongTimer = setTimeout(() => ws.close(4000, "No pong"), PONG_WAIT_MS);
  }, PING_EVERY_MS);
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (!workspace || !users) return;
  // 0.5 s, 1 s, 2 s … up to 30 s, each with a random part so a server back after a restart isn't hit by every tab at once.
  const base = Math.min(RETRY_MAX_MS, 500 * 2 ** attempts);
  attempts++;
  retryTimer = setTimeout(connect, base / 2 + Math.random() * base);
}

function reconnectNow() {
  if (!workspace || state.status === "closed" || socket) return;
  attempts = 0;
  connect();
}

function isActiveNow() {
  return document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastInput < IDLE_AFTER_MS;
}

function reportActive() {
  const active = isActiveNow();
  if (active === wasActive) return;
  wasActive = active;
  void call("active", { active }).catch(() => {});
}

function onInput() {
  const before = Date.now() - lastInput >= IDLE_AFTER_MS;
  lastInput = Date.now();
  if (before) reportActive();
}

let activeTimer: ReturnType<typeof setInterval> | undefined;

function listen(on: boolean) {
  const method = on ? "addEventListener" : "removeEventListener";
  window[method]("online", reconnectNow);
  window[method]("focus", reportActive);
  window[method]("blur", reportActive);
  window[method]("keydown", onInput, { passive: true } as AddEventListenerOptions);
  window[method]("pointermove", onInput, { passive: true } as AddEventListenerOptions);
  document[method]("visibilitychange", onVisible);
  clearInterval(activeTimer);
  if (on) activeTimer = setInterval(reportActive, 30_000);
}

function onVisible() {
  reportActive();
  if (document.visibilityState === "visible") reconnectNow();
}

/**
 * Keeps the connection to `workspaceId` open while something uses it; returns what lets it go.
 * Another workspace's use closes the one before.
 */
export function holdConnection(workspaceId: string): () => void {
  if (workspace !== workspaceId) {
    stop();
    workspace = workspaceId;
    state = { ...empty(), workspaceId };
    rev = 0;
    for (const l of listeners) l();
    listen(true);
    connect();
  }
  users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users--;
    // A page change releases and takes it again at once: wait a moment before closing.
    setTimeout(() => {
      if (!users && workspace === workspaceId) stop();
    }, 5000);
  };
}

function stop() {
  if (!workspace) return;
  listen(false);
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
  const s = socket;
  socket = null;
  s?.close(1000, "Done");
  for (const w of waiting.values()) {
    clearTimeout(w.timer);
    w.reject(new MessagesError("offline", "Closed"));
  }
  waiting.clear();
  queued = [];
  workspace = null;
}

// ----------------------------------------------------------------------------------- reading

/** The person's unread across the workspace: mentions and direct messages (a count), and other unread channels (a dot). */
export function unreadSummary(s: MessagesState): { count: number; dot: boolean } {
  let count = 0;
  let dot = false;
  for (const [channelId, m] of s.memberships) {
    const c = s.channels.get(channelId);
    if (!c || c.archivedAt) continue;
    const unread = unreadOf(s, channelId);
    if (c.kind === "direct") count += m.muted ? 0 : unread;
    else count += m.mentions;
    if (unread > 0 && !m.muted && c.kind !== "direct") dot = true;
  }
  for (const t of s.threads.values()) count += t.mentions;
  return { count, dot };
}

/** Unread messages of a channel's main list for the person. */
export function unreadOf(s: MessagesState, channelId: string): number {
  const m = s.memberships.get(channelId);
  if (!m) return 0;
  return Math.min(99, m.unread + (s.liveUnread.get(channelId)?.size ?? 0));
}

/** Watches the person's unread for the rail: opens the connection while watched. */
export function watchUnread(workspaceId: string, onChange: (summary: { count: number; dot: boolean }) => void): () => void {
  const release = holdConnection(workspaceId);
  let last = "";
  const report = () => {
    if (state.workspaceId !== workspaceId) return;
    const summary = unreadSummary(state);
    const key = `${summary.count}/${summary.dot}`;
    if (key !== last) {
      last = key;
      onChange(summary);
    }
  };
  const unsubscribe = subscribe(report);
  report();
  return () => {
    unsubscribe();
    release();
  };
}

/** What a channel is called for the person: `name` for a channel, the other people's names for a direct conversation. */
export function channelTitle(s: Pick<MessagesState, "people" | "me">, c: ChannelView, words: { you: string; someone: string }): string {
  if (c.kind !== "direct") return c.name ?? "";
  const others = c.people.filter((id) => id !== s.me);
  if (!others.length) return `${s.people.get(s.me)?.name || words.someone} (${words.you})`;
  return others.map((id) => s.people.get(id)?.name || words.someone).join(", ");
}

export const personName = (s: Pick<MessagesState, "people">, id: string | null, someone: string) => (id && s.people.get(id)?.name) || someone;

// ----------------------------------------------------------------------------------- doing

/** Loads a channel's messages: the newest, those before or after what is loaded, or around a message or the first unread. */
export async function loadHistory(channelId: string, at: { before?: boolean; after?: boolean; around?: string } = {}) {
  const line = state.timelines.get(channelId);
  const args: Record<string, unknown> = { channelId, limit: 50 };
  if (at.before && line?.ids.length) args.before = state.messages.get(line.ids[0])?.seq;
  else if (at.after && line?.ids.length) args.after = state.messages.get(line.ids.at(-1)!)?.seq;
  else if (at.around) args.around = at.around;
  const result = await call<{ messages: MessageView[]; hasBefore: boolean; hasAfter: boolean }>("history", args);
  const messages = new Map(state.messages);
  for (const m of result.messages) {
    const known = messages.get(m.id);
    if (!known || known.rev <= m.rev) messages.set(m.id, m);
  }
  const loaded = result.messages.map((m) => m.id);
  const current = state.timelines.get(channelId);
  let next: Timeline;
  if (!current || at.around || (!at.before && !at.after)) next = { ids: loaded, hasBefore: result.hasBefore, hasAfter: result.hasAfter };
  else if (at.before) next = { ids: [...new Set([...loaded, ...current.ids])], hasBefore: result.hasBefore, hasAfter: current.hasAfter };
  else next = { ids: [...new Set([...current.ids, ...loaded])], hasBefore: current.hasBefore, hasAfter: result.hasAfter };
  next.ids.sort(bySeq(messages));
  set({ messages, timelines: new Map(state.timelines).set(channelId, next) });
}

export async function loadThread(threadId: string) {
  const { root, replies } = await call<{ root: MessageView; replies: MessageView[] }>("thread", { threadId });
  const messages = new Map(state.messages);
  for (const m of [root, ...replies]) messages.set(m.id, m);
  set({ messages, replies: new Map(state.replies).set(threadId, replies.map((r) => r.id)) });
}

/** Loads messages the person has only by id (saved, mentions, search). */
export async function loadMessages(ids: string[]) {
  const wanted = ids.filter((id) => !state.messages.has(id));
  if (!wanted.length) return;
  const found = await call<MessageView[]>("byId", { ids: wanted.slice(0, 200) });
  const messages = new Map(state.messages);
  for (const m of found) messages.set(m.id, m);
  set({ messages });
}

export const putMessages = (list: MessageView[]) => {
  if (!list.length) return;
  const messages = new Map(state.messages);
  for (const m of list) {
    const known = messages.get(m.id);
    if (!known || known.rev <= m.rev) messages.set(m.id, m);
  }
  set({ messages });
};

async function deliver(p: Pending) {
  try {
    const result = await call<{ message: MessageView; notInChannel: string[] }>("send", { id: p.id, channelId: p.channelId, threadId: p.threadId, body: p.body, fileIds: p.fileIds, alsoInChannel: p.alsoInChannel });
    apply({ rev: 0, messages: [result.message] }, "live");
    return result;
  } catch (error) {
    // A lost connection sends it again when it comes back; a refusal marks it failed.
    if (error instanceof MessagesError && error.code === "offline") return null;
    set({ pending: new Map(state.pending).set(p.id, { ...p, failed: true }) });
    throw error;
  }
}

/** Sends a message: it shows at once, and stays marked until the server has it. */
export function sendMessage(input: { channelId: string; threadId?: string | null; body: string; fileIds?: string[]; alsoInChannel?: boolean }) {
  const p: Pending = {
    id: crypto.randomUUID(),
    channelId: input.channelId,
    threadId: input.threadId ?? null,
    body: input.body,
    fileIds: input.fileIds ?? [],
    alsoInChannel: input.alsoInChannel ?? false,
    failed: false,
    createdAt: new Date().toISOString(),
  };
  set({ pending: new Map(state.pending).set(p.id, p) });
  return deliver(p);
}

export function retrySend(id: string) {
  const p = state.pending.get(id);
  if (!p) return;
  const again = { ...p, failed: false };
  set({ pending: new Map(state.pending).set(id, again) });
  return deliver(again);
}

export function dropPending(id: string) {
  const pending = new Map(state.pending);
  pending.delete(id);
  set({ pending });
}

/** Changes a message in place before the server answers; the answer's change replaces it. */
export function patchMessage(id: string, patch: Partial<MessageView>) {
  const m = state.messages.get(id);
  if (!m) return;
  set({ messages: new Map(state.messages).set(id, { ...m, ...patch }) });
}

/** Marks a channel read up to `seq`, at once here and then on the server. */
export function markRead(channelId: string, seq: number) {
  const m = state.memberships.get(channelId);
  if (!m || (m.lastReadSeq >= seq && !m.unread && !m.mentions && !state.liveUnread.get(channelId)?.size)) return;
  const live = new Map(state.liveUnread);
  live.delete(channelId);
  set({ memberships: new Map(state.memberships).set(channelId, { ...m, lastReadSeq: Math.max(seq, m.lastReadSeq), unread: 0, mentions: 0 }), liveUnread: live });
  void call("read", { channelId, seq }).catch(() => {});
}

export function markThreadRead(threadId: string, seq: number) {
  const t = state.threads.get(threadId);
  if (t && t.lastReadSeq >= seq && !t.mentions) return;
  if (t) set({ threads: new Map(state.threads).set(threadId, { ...t, lastReadSeq: Math.max(seq, t.lastReadSeq), mentions: 0 }) });
  void call("readThread", { threadId, seq }).catch(() => {});
}

/** The channel the tab shows: the server sends its messages (a public channel one isn't in) and tells others. */
export function setViewing(channelId: string | null) {
  if (viewing === channelId) return;
  viewing = channelId;
  if (state.status === "open") void call("view", { channelId }).catch(() => {});
}

let typedAt = 0;
let typedWhere = "";
/** Tells the channel the person types, at most every few seconds. */
export function typing(channelId: string, threadId: string | null) {
  const where = typingKey(channelId, threadId);
  if (where === typedWhere && Date.now() - typedAt < TYPING_EVERY_MS) return;
  typedAt = Date.now();
  typedWhere = where;
  if (state.status === "open") void call("typing", { channelId, threadId }).catch(() => {});
}

/** The text of a message as one line, for lists and notifications. */
export const messageLine = (m: Pick<MessageView, "body">, max = 120) => snippet(m.body, max);
