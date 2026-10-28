/**
 * An uploaded recording of a meeting, for meeting-recorder.tsx, which loads this only when one is
 * chosen. The file is decoded in the browser to one channel at UPLOAD_SAMPLE_RATE, cut into the
 * pieces a live recording is sent in, and each piece is sent as a WAV file through the same route
 * (meeting-pieces.ts): the server transcribes it into the block at its time, as fast as the AI
 * limits let, and writes the meeting up at the end. Nothing of the file leaves the browser but
 * those pieces. Stopping writes up what was transcribed so far.
 */
import { finishMeetingAction, markMeetingGapAction, meetingHeartbeatAction, startMeetingAction } from "@/app/actions/meetings";
import { MAX_MEETING_SECONDS, MEETING_HEARTBEAT_MS } from "@/lib/meeting-clock";
import { encodeWav, mixToMono, UPLOAD_SAMPLE_RATE, uploadPieces, uploadPieceSeconds } from "@/lib/meeting-upload";
import { deliverPiece, FINAL_CODES } from "./meeting-pieces";
import type { SessionControls, SessionError, SessionHooks } from "./meeting-session";

/** The texts of meetings.errors an upload can end with, beyond a recording's. */
export type UploadError = SessionError | "fileUnreadable" | "fileTooLong";

/** How long reading a file's length may take before it is decoded anyway. */
const METADATA_MS = 10_000;

/** The length of a file the browser can play, from its metadata, without decoding it; null when it can't tell. */
function mediaSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const media = document.createElement("audio");
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (seconds: number | null) => {
      if (timer) clearTimeout(timer);
      media.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    media.preload = "metadata";
    media.onloadedmetadata = () => done(Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null);
    media.onerror = () => done(null);
    timer = setTimeout(() => done(null), METADATA_MS);
    media.src = url;
  });
}

/** The file's sound as one channel at UPLOAD_SAMPLE_RATE; throws when the browser can't decode it. */
async function decode(file: File): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, 1, UPLOAD_SAMPLE_RATE);
  const buffer = await context.decodeAudioData(await file.arrayBuffer());
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return mixToMono(channels);
}

/**
 * Reads the file, tells the server the meeting is being transcribed from it, and sends its pieces.
 * Resolves to the controls once the pieces start going, or to the translated reason it can't.
 * `update` gets `total`, the file's length, with each view.
 */
export async function startMeetingUpload(
  pageId: string,
  meetingId: string,
  file: File,
  maxBytes: number,
  hooks: Omit<SessionHooks, "update" | "translate"> & {
    update: (view: { status: "recording" | "finishing"; seconds: number; gaps: number; waiting: number; total: number }) => void;
    translate: (key: UploadError) => string;
  },
): Promise<{ controls: SessionControls } | { problem: string }> {
  const te = hooks.translate;
  const length = await mediaSeconds(file);
  if (length !== null && length > MAX_MEETING_SECONDS + 1) return { problem: te("fileTooLong") };
  let samples: Float32Array | null;
  try {
    samples = await decode(file);
  } catch {
    return { problem: te("fileUnreadable") };
  }
  const total = samples.length / UPLOAD_SAMPLE_RATE;
  if (total > MAX_MEETING_SECONDS + 1) return { problem: te("fileTooLong") };
  if (total < 0.5) return { problem: te("fileUnreadable") };

  const res = await startMeetingAction(pageId, meetingId, "file").catch(() => null);
  if (!res?.ok) return { problem: res?.error ?? te("failed") };
  const startAt = res.data.seconds;
  const pieces = uploadPieces(Math.min(total, MAX_MEETING_SECONDS - startAt), uploadPieceSeconds(maxBytes), { firstChunk: res.data.nextChunk, startAt });

  /** Seconds into the meeting sent so far. */
  let reached = startAt;
  let gaps = 0;
  let stopping = false;
  let over = false;
  const show = (status: "recording" | "finishing" = stopping ? "finishing" : "recording", waiting = 0) => {
    if (!over) hooks.update({ status, seconds: reached, gaps, waiting, total: startAt + total });
  };
  // Between pieces held back by the AI limits, the meeting still hears from its uploader.
  const heartbeat = setInterval(() => void meetingHeartbeatAction(pageId, meetingId, reached).catch(() => {}), MEETING_HEARTBEAT_MS);

  const end = (problem: string | null) => {
    if (over) return;
    over = true;
    clearInterval(heartbeat);
    samples = null;
    hooks.ended(problem);
  };

  const run = async () => {
    for (const [index, piece] of pieces.entries()) {
      if (over || stopping || !samples) break;
      const from = Math.round((piece.offset - startAt) * UPLOAD_SAMPLE_RATE);
      const audio = samples.subarray(from, from + Math.round(piece.duration * UPLOAD_SAMPLE_RATE));
      const place = { pageId, meetingId, ...piece };
      const sent = await deliverPiece(place, new File([encodeWav(audio, UPLOAD_SAMPLE_RATE)], `meeting-${piece.chunk}.wav`, { type: "audio/wav" }), () => over || stopping);
      if (over) return;
      // Stopped while this piece waited its turn: what came before it is written up.
      if (sent.result === "over") break;
      if (sent.result === "final") return end(te(sent.code as SessionError));
      if (sent.result === "failed") {
        const gap = await markMeetingGapAction(place).catch(() => null);
        gaps++;
        if (gap && !gap.ok && gap.code && FINAL_CODES.has(gap.code)) return end(gap.error);
      }
      reached = piece.offset + piece.duration;
      show(undefined, pieces.length - index - 1);
    }
    if (over) return;
    show("finishing");
    clearInterval(heartbeat);
    const done = await finishMeetingAction(pageId, meetingId, reached).catch(() => null);
    end(done?.ok ? null : (done?.error ?? te("failed")));
  };

  show("recording", pieces.length);
  void run();

  return {
    controls: {
      // An upload goes at the pace the server takes it: there is nothing to pause.
      pause() {},
      resume() {},
      stop() {
        if (over || stopping) return;
        stopping = true;
        show("finishing");
      },
      /** Stops sending without telling anyone (the workspace was left). */
      dispose() {
        over = true;
        clearInterval(heartbeat);
        samples = null;
      },
    },
  };
}
