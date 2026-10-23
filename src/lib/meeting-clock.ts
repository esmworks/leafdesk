// The meeting recorder's clock, apart from lib/meetings so the recorder (which loads on its own)
// doesn't carry the rest of it. lib/meetings re-exports all of it.

/** The longest meeting: recording stops by itself at three hours. */
export const MAX_MEETING_SECONDS = 3 * 60 * 60;
/** How long each piece of audio sent to be transcribed is. */
export const MEETING_CHUNK_SECONDS = 30;
/** A recording whose recorder hasn't reported for this long may be ended by anyone who can edit it. */
export const MEETING_STALE_MS = 5 * 60 * 1000;
/** While paused, the recorder says it is still there this often. */
export const MEETING_HEARTBEAT_MS = 2 * 60 * 1000;

/** `[mm:ss]` as written in the summary and the transcript (`h:mm:ss` from an hour on). */
export function formatStamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
