/**
 * Who has a page open. Every browser showing the page puts a `presence` field in its awareness
 * state on the page's collab document; the collab server overwrites it with the identity the
 * connection signed in with, so a browser can't show up as someone else.
 */

export const PRESENCE_FIELD = "presence";

/**
 * The editor's cursor label (`{ name, color }`), which other people's editors draw at this tab's
 * cursor. The collab server overwrites it like the presence.
 */
export const CURSOR_FIELD = "user";

const CURSOR_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];

/** A person's cursor and avatar color, the same in every browser and on the server. */
export function userColor(userId: string) {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

/** `image`: their profile picture (`user.image`), when they have one. */
export type Presence = { id: string; name: string; image?: string | null };

/** At most this many avatars show in the page header; the rest fold into "+N". */
export const MAX_AVATARS = 4;

function asPresence(value: unknown): Presence | null {
  if (!value || typeof value !== "object") return null;
  const { id, name, image } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id || typeof name !== "string") return null;
  return typeof image === "string" && image ? { id, name, image } : { id, name };
}

/**
 * The people in a document's awareness states, once each however many tabs they have open, in the
 * order they appear, leaving out `selfId` and this tab's own state (`selfClient`).
 */
export function viewersOf(states: Map<number, Record<string, unknown>>, selfId: string, selfClient?: number): Presence[] {
  const seen = new Map<string, Presence>();
  for (const [client, state] of states) {
    if (client === selfClient) continue;
    const presence = asPresence(state?.[PRESENCE_FIELD]);
    if (!presence || presence.id === selfId || seen.has(presence.id)) continue;
    seen.set(presence.id, presence);
  }
  return [...seen.values()];
}

export function sameViewers(a: Presence[], b: Presence[]) {
  return a.length === b.length && a.every((p, i) => p.id === b[i].id && p.name === b[i].name && p.image === b[i].image);
}

/** The avatars to show and how many fold into "+N". Never folds just one person away. */
export function splitViewers<T>(viewers: T[], max = MAX_AVATARS): { shown: T[]; more: number } {
  if (viewers.length <= max) return { shown: viewers, more: 0 };
  return { shown: viewers.slice(0, max - 1), more: viewers.length - max + 1 };
}

/** The letter on an avatar: the first character of the name, as the members list shows it. */
export function initialOf(name: string) {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : "?";
}

/** Text color for initials on a `#rrggbb` background. */
export function textOn(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  // White on every cursor color but the light ones (yellow), where it would wash out.
  return luminance > 0.45 ? "#000000" : "#ffffff";
}
