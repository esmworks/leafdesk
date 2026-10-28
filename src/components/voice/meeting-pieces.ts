/**
 * Sends a piece of a meeting's audio to /api/meetings/chunk, for the live recording
 * (meeting-session.ts) and an uploaded one (meeting-upload-session.ts) alike. A piece that fails
 * is tried again a few times; one the AI limits hold back waits as long as the server says, and
 * that wait doesn't count as a try.
 */

/** Where a piece goes: as server/meetings ChunkPlace. */
export type PiecePlace = { pageId: string; meetingId: string; chunk: number; offset: number; duration: number };

const RETRY_MS = [2_000, 5_000, 15_000];
/** How long to wait when the server is busy and doesn't say for how long. */
const RATE_LIMIT_MS = 10_000;
/** Refusals no retry changes: the recording ends. */
export const FINAL_CODES = new Set(["noAccess", "notFound", "notRecording", "tooLong", "disabled"]);

/** Waits `ms`, or less once `over` says so (checked each half second). */
async function wait(ms: number, over: () => boolean) {
  for (const end = Date.now() + ms; Date.now() < end && !over(); ) await new Promise((resolve) => setTimeout(resolve, Math.min(500, end - Date.now())));
}

/** "sent"; "failed" after its tries (a gap to mark); a refusal that ends the recording; or "over" when it was over first. */
export type Delivery = { result: "sent" } | { result: "failed" } | { result: "final"; code: string } | { result: "over" };

export async function deliverPiece(place: PiecePlace, audio: File, over: () => boolean): Promise<Delivery> {
  for (let attempt = 0; ; ) {
    if (over()) return { result: "over" };
    let pause: number | null = null;
    try {
      const form = new FormData();
      form.set("pageId", place.pageId);
      form.set("meetingId", place.meetingId);
      form.set("chunk", String(place.chunk));
      form.set("offset", String(place.offset));
      form.set("duration", String(place.duration));
      form.set("audio", audio);
      const sent = await fetch("/api/meetings/chunk", { method: "POST", body: form });
      if (sent.ok) return { result: "sent" };
      const code = ((await sent.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? "";
      if (FINAL_CODES.has(code)) return { result: "final", code };
      if (code === "rateLimited") {
        const seconds = Number(sent.headers.get("Retry-After"));
        pause = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 + 250 : RATE_LIMIT_MS;
      }
    } catch {
      // Offline for a moment: tried again below.
    }
    if (pause === null) {
      if (attempt >= RETRY_MS.length) return over() ? { result: "over" } : { result: "failed" };
      pause = RETRY_MS[attempt++];
    }
    await wait(pause, over);
  }
}
