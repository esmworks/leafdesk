/**
 * The open Messages connections of this process, in memory (`globalThis.__leafdeskMessageHub`:
 * server.ts's socket and Next's route handlers are separate module graphs). It sends each person
 * what concerns them, knows who is here (presence), who is typing where and who has which channel
 * open. Nothing here is kept: a restart forgets it and the browsers tell it again as they reconnect.
 * One process serves a workspace, as for the collaboration server.
 */
import type { Presence, ServerFrame } from "@/lib/message-wire";
import { TYPING_SHOWN_MS } from "@/lib/messages";

export type Connection = {
  id: string;
  userId: string;
  sessionId: string;
  workspaceId: string;
  /** Their role in the workspace when they connected (a guest sees only the channels they are in). */
  guest: boolean;
  /** For a guest, the people they may know of (sync.ts `peopleFor`) as they connected; null for everyone. */
  knows: Set<string> | null;
  /** The tab is in front and the person did something lately. */
  active: boolean;
  /** The channel the tab shows, if any (its "viewing" faces, and changes of a public channel they aren't in). */
  viewing: string | null;
  send: (frame: ServerFrame) => void;
  close: (code: number, reason: string) => void;
};

type Hub = {
  /** workspace → connection id → connection */
  workspaces: Map<string, Map<string, Connection>>;
  /** workspace → person → what others last heard about them */
  presence: Map<string, Map<string, Presence>>;
  /** Presence changes wait this long, so a reload or a quick tab switch says nothing. */
  presenceTimers: Map<string, NodeJS.Timeout>;
};

const KEY = "__leafdeskMessageHub";
const hub = ((globalThis as Record<string, unknown>)[KEY] ??= {
  workspaces: new Map(),
  presence: new Map(),
  presenceTimers: new Map(),
} satisfies Hub) as Hub;

const PRESENCE_SETTLE_MS = 4000;

export function connectionsIn(workspaceId: string): Connection[] {
  return [...(hub.workspaces.get(workspaceId)?.values() ?? [])];
}

/** The people with a connection open in the workspace, whether one of theirs is a guest's and whom that guest may know of. */
export function connectedPeople(workspaceId: string): Map<string, { guest: boolean; knows: Set<string> | null }> {
  const people = new Map<string, { guest: boolean; knows: Set<string> | null }>();
  for (const c of connectionsIn(workspaceId)) people.set(c.userId, { guest: c.guest, knows: c.knows });
  return people;
}

/** Whether what concerns `userId` (presence, status) may go to the connection: a guest hears only of those they know. */
const mayHear = (c: Pick<Connection, "knows" | "userId">, userId: string) => !c.knows || c.knows.has(userId) || c.userId === userId;

export function addConnection(connection: Connection) {
  const conns = hub.workspaces.get(connection.workspaceId) ?? new Map<string, Connection>();
  conns.set(connection.id, connection);
  hub.workspaces.set(connection.workspaceId, conns);
  settlePresence(connection.workspaceId, connection.userId);
}

export function removeConnection(connection: Connection) {
  const conns = hub.workspaces.get(connection.workspaceId);
  if (!conns) return;
  const viewing = connection.viewing;
  conns.delete(connection.id);
  if (!conns.size) hub.workspaces.delete(connection.workspaceId);
  if (viewing) announceViewers(connection.workspaceId, viewing);
  settlePresence(connection.workspaceId, connection.userId);
}

/** Sends a frame to every connection of these people in the workspace. */
export function sendToPeople(workspaceId: string, userIds: Iterable<string>, frame: ServerFrame | ((userId: string) => ServerFrame | null)) {
  const wanted = new Set(userIds);
  if (!wanted.size) return;
  for (const c of connectionsIn(workspaceId)) {
    if (!wanted.has(c.userId)) continue;
    const out = typeof frame === "function" ? frame(c.userId) : frame;
    if (out) c.send(out);
  }
}

/** The people who have this channel open now. */
export function viewersOf(workspaceId: string, channelId: string): string[] {
  return [...new Set(connectionsIn(workspaceId).filter((c) => c.viewing === channelId && c.active).map((c) => c.userId))];
}

/** Tells those who have the channel open who else does. */
function announceViewers(workspaceId: string, channelId: string) {
  const userIds = viewersOf(workspaceId, channelId);
  for (const c of connectionsIn(workspaceId)) if (c.viewing === channelId) c.send({ t: "viewers", channelId, userIds });
}

/** The tab now shows `channelId` (null: no channel), as the person may see it (the caller checked). */
export function setViewing(connection: Connection, channelId: string | null) {
  const before = connection.viewing;
  if (before === channelId) return;
  connection.viewing = channelId;
  if (before) announceViewers(connection.workspaceId, before);
  if (channelId) announceViewers(connection.workspaceId, channelId);
}

export function setActive(connection: Connection, active: boolean) {
  if (connection.active === active) return;
  connection.active = active;
  if (connection.viewing) announceViewers(connection.workspaceId, connection.viewing);
  settlePresence(connection.workspaceId, connection.userId);
}

/** Whether the person has a tab in front showing this channel: they see its new messages without being told. */
export function isWatching(workspaceId: string, userId: string, channelId: string): boolean {
  return connectionsIn(workspaceId).some((c) => c.userId === userId && c.active && c.viewing === channelId);
}

/** Whether the person has the app in front anywhere in the workspace. */
export function isActive(workspaceId: string, userId: string): boolean {
  return connectionsIn(workspaceId).some((c) => c.userId === userId && c.active);
}

function presenceNow(workspaceId: string, userId: string): Presence {
  const theirs = connectionsIn(workspaceId).filter((c) => c.userId === userId);
  if (!theirs.length) return "offline";
  return theirs.some((c) => c.active) ? "active" : "away";
}

/** Everyone's presence in the workspace (only of the people in `knows`, when given), as others last heard it. */
export function presenceIn(workspaceId: string, knows: Set<string> | null = null): Record<string, Presence> {
  const out: Record<string, Presence> = {};
  for (const c of connectionsIn(workspaceId)) if (!knows || knows.has(c.userId)) out[c.userId] = presenceNow(workspaceId, c.userId);
  return out;
}

/** Tells the workspace a person's presence once it has held still a moment. */
function settlePresence(workspaceId: string, userId: string) {
  const key = `${workspaceId}\n${userId}`;
  clearTimeout(hub.presenceTimers.get(key));
  const now = presenceNow(workspaceId, userId);
  const known = hub.presence.get(workspaceId)?.get(userId) ?? "offline";
  // Coming in is told at once; going away waits, so a reload in between says nothing.
  const delay = now === "active" && known !== "active" ? 0 : PRESENCE_SETTLE_MS;
  hub.presenceTimers.set(
    key,
    setTimeout(() => {
      hub.presenceTimers.delete(key);
      const state = presenceNow(workspaceId, userId);
      const told = hub.presence.get(workspaceId) ?? new Map<string, Presence>();
      if ((told.get(userId) ?? "offline") === state) return;
      if (state === "offline") told.delete(userId);
      else told.set(userId, state);
      if (told.size) hub.presence.set(workspaceId, told);
      else hub.presence.delete(workspaceId);
      for (const c of connectionsIn(workspaceId)) if (mayHear(c, userId)) c.send({ t: "presence", userId, state });
    }, delay).unref(),
  );
}

/** Tells the channel's people with a connection that someone types (they are told again while it lasts). */
export function announceTyping(workspaceId: string, recipients: Iterable<string>, frame: Extract<ServerFrame, { t: "typing" }>) {
  sendToPeople(
    workspaceId,
    [...recipients].filter((id) => id !== frame.userId),
    frame,
  );
}

export { TYPING_SHOWN_MS };

/** Closes the connections of the user's sessions that ended (`liveSessionIds` are those still going). */
export function closeEndedMessageSessions(userId: string, liveSessionIds: string[]) {
  const live = new Set(liveSessionIds);
  for (const conns of hub.workspaces.values()) {
    for (const c of [...conns.values()]) {
      if (c.userId !== userId || live.has(c.sessionId)) continue;
      c.send({ t: "closed", reason: "signedOut" });
      c.close(4401, "Session ended");
    }
  }
}

/** Closes someone's connections to a workspace they are no longer in. */
export function closeWorkspaceConnections(workspaceId: string, userId: string) {
  for (const c of connectionsIn(workspaceId)) {
    if (c.userId !== userId) continue;
    c.send({ t: "closed", reason: "removed" });
    c.close(4403, "Removed");
  }
}

/**
 * Closes connections to the workspace (only `userId`'s, when given) so they connect again and are
 * checked afresh: after a role or policy change, as the collaboration server's editors are.
 */
export function reconnectWorkspace(workspaceId: string, userId?: string) {
  for (const c of connectionsIn(workspaceId)) if (!userId || c.userId === userId) c.close(4000, "Check again");
}
