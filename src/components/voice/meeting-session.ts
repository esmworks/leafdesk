/**
 * The recording itself, for meeting-recorder.tsx, which loads this only when a recording starts.
 *
 * The microphone's stream is cut into pieces of MEETING_CHUNK_SECONDS, each by a MediaRecorder of
 * its own (a timesliced recorder's pieces aren't playable files on their own), which are sent one
 * at a time to /api/meetings/chunk with their place in the meeting: seconds recorded before them,
 * pauses left out. A piece that fails is tried again, then left as a gap (meeting-pieces.ts). The block (and anyone
 * else with the page open) sees the transcript fill in as the server writes it.
 */
import { finishMeetingAction, markMeetingGapAction, meetingHeartbeatAction, startMeetingAction } from "@/app/actions/meetings";
import { MAX_MEETING_SECONDS, MEETING_CHUNK_SECONDS, MEETING_HEARTBEAT_MS } from "@/lib/meeting-clock";
import { RECORDER_BITS_PER_SECOND, RECORDER_TYPES } from "@/lib/voice-notes";
import { deliverPiece, FINAL_CODES } from "./meeting-pieces";
import type { MeetingRecorderStatus } from "./meeting-recorder";
import { canRecord } from "./use-voice-recorder";

/** What the recorder shows of a session. */
export type SessionView = { status: MeetingRecorderStatus; seconds: number; gaps: number; waiting: number };

/** The texts of meetings.errors the session can end with. */
export type SessionError = "noAccess" | "notFound" | "notRecording" | "tooLong" | "disabled" | "failed" | "insecure" | "unsupported" | "denied" | "noDevice";

export type SessionHooks = {
  /** The session's state changed (also every half second while it runs). */
  update: (view: SessionView) => void;
  /** The session is over: `problem` says why when it didn't end as asked (a translated text). */
  ended: (problem: string | null) => void;
  translate: (key: SessionError) => string;
};

export type SessionControls = { pause: () => void; resume: () => void; stop: () => void; dispose: () => void };

type Piece = { chunk: number; offset: number; duration: number; blob: Blob };

function startError(error: unknown): SessionError {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "noDevice";
  return "failed";
}

/**
 * Asks for the microphone, tells the server the recording starts and records until stopped.
 * Resolves to the controls, or to the translated reason it couldn't start.
 */
export async function startMeetingSession(
  pageId: string,
  meetingId: string,
  maxSeconds: number,
  hooks: SessionHooks,
): Promise<{ controls: SessionControls } | { problem: string }> {
  const te = hooks.translate;
  if (!window.isSecureContext) return { problem: te("insecure") };
  if (!canRecord()) return { problem: te("unsupported") };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    return { problem: te(startError(error)) };
  }
  const res = await startMeetingAction(pageId, meetingId).catch(() => null);
  if (!res?.ok) {
    stream.getTracks().forEach((track) => track.stop());
    return { problem: res?.error ?? te("failed") };
  }

  const mimeType = RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? "";
  const pieceMs = Math.min(MEETING_CHUNK_SECONDS, Math.max(5, maxSeconds - 5)) * 1000;
  let recorder: MediaRecorder | null = null;
  /** Seconds recorded before the piece being recorded now. */
  let recorded = res.data.seconds;
  /** When the piece being recorded started (ms), while recording. */
  let pieceStarted: number | null = null;
  let nextChunk = res.data.nextChunk;
  let status: MeetingRecorderStatus = "recording";
  let stopping = false;
  /** Over for good: nothing more is sent. */
  let over = false;
  let sending = false;
  let gaps = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const queue: Piece[] = [];

  const recordedNow = () => recorded + (pieceStarted !== null ? (Date.now() - pieceStarted) / 1000 : 0);
  const show = (next?: MeetingRecorderStatus) => {
    if (next) status = next;
    if (!over) hooks.update({ status, seconds: recordedNow(), gaps, waiting: queue.length });
  };
  const ticker = setInterval(() => {
    if (!stopping && recordedNow() >= MAX_MEETING_SECONDS) {
      stopping = true;
      recorder?.stop();
    }
    show();
  }, 500);

  const release = () => {
    clearInterval(ticker);
    if (heartbeat) clearInterval(heartbeat);
    stream.getTracks().forEach((track) => track.stop());
  };

  /** Ends without finishing the meeting (it went away, or access was lost). */
  const drop = (message: string | null) => {
    if (over) return;
    over = true;
    stopping = true;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    release();
    hooks.ended(message);
  };

  const finish = async () => {
    if (over || sending || queue.length || recorder) return;
    over = true;
    release();
    const done = await finishMeetingAction(pageId, meetingId, recorded).catch(() => null);
    hooks.ended(done?.ok ? null : (done?.error ?? te("failed")));
  };

  const send = async (piece: Piece) => {
    const place = { pageId, meetingId, chunk: piece.chunk, offset: piece.offset, duration: piece.duration };
    const extension = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
    const sent = await deliverPiece(place, new File([piece.blob], `meeting-${piece.chunk}.${extension}`, { type: piece.blob.type }), () => over);
    if (sent.result === "final") return drop(te(sent.code as SessionError));
    if (sent.result !== "failed") return;
    const gap = await markMeetingGapAction(place).catch(() => null);
    gaps++;
    if (gap && !gap.ok && gap.code && FINAL_CODES.has(gap.code)) drop(gap.error);
  };

  const pump = async () => {
    if (sending) return;
    sending = true;
    while (queue.length && !over) {
      await send(queue[0]);
      queue.shift();
      show();
    }
    sending = false;
    if (stopping) await finish();
  };

  /** Records the next piece, which ends itself after its length (or on pause and stop). */
  const startPiece = () => {
    const piece = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: RECORDER_BITS_PER_SECOND });
    const parts: Blob[] = [];
    const started = Date.now();
    const offset = recorded;
    const chunk = nextChunk++;
    // Data arrives every second, in background tabs too: the piece ends on the first past its length.
    piece.ondataavailable = (event) => {
      if (event.data.size) parts.push(event.data);
      if (piece.state === "recording" && Date.now() - started >= pieceMs) piece.stop();
    };
    piece.onstop = () => {
      const duration = Math.max(0, (Date.now() - started) / 1000);
      recorded = offset + duration;
      pieceStarted = null;
      recorder = null;
      if (parts.length && !over) {
        queue.push({ chunk, offset: Math.round(offset * 10) / 10, duration: Math.round(duration * 10) / 10, blob: new Blob(parts, { type: piece.mimeType || mimeType || "audio/webm" }) });
        void pump();
      }
      if (over) return;
      if (recorded >= MAX_MEETING_SECONDS) stopping = true;
      if (stopping) {
        show("finishing");
        void finish();
      } else if (status !== "paused") startPiece();
    };
    recorder = piece;
    pieceStarted = started;
    piece.start(1000);
  };

  // The microphone went away (unplugged, or taken back in the browser's settings): end there.
  for (const track of stream.getTracks()) {
    track.onended = () => {
      if (over || stopping) return;
      stopping = true;
      if (recorder) recorder.stop();
      else void finish();
    };
  }
  try {
    startPiece();
  } catch {
    release();
    return { problem: te("unsupported") };
  }
  show("recording");

  return {
    controls: {
      pause() {
        if (over || status === "paused" || stopping) return;
        status = "paused";
        recorder?.stop();
        // Nothing is sent while paused: the meeting hears from its recorder anyway.
        heartbeat = setInterval(() => void meetingHeartbeatAction(pageId, meetingId, recorded).catch(() => {}), MEETING_HEARTBEAT_MS);
        show();
      },
      resume() {
        if (over || status !== "paused" || stopping || recorder) return;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        status = "recording";
        startPiece();
        show();
      },
      stop() {
        if (over || stopping) return;
        stopping = true;
        show("finishing");
        if (recorder && recorder.state !== "inactive") recorder.stop();
        else void finish();
      },
      /** Lets go of the microphone without telling anyone (the workspace was left). */
      dispose() {
        if (over) return;
        over = true;
        if (recorder && recorder.state !== "inactive") recorder.stop();
        release();
      },
    },
  };
}
