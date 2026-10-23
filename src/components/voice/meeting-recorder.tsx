"use client";

/**
 * Records a meeting (lib/meetings) for the whole workspace's screens: the provider sits in the
 * workspace layout, so the recording goes on when the person opens other pages or switches tabs.
 * One meeting at a time.
 *
 * The microphone's stream is cut into pieces of MEETING_CHUNK_SECONDS, each by a MediaRecorder of
 * its own (a timesliced recorder's pieces aren't playable files on their own), which are sent one
 * at a time to /api/meetings/chunk with their place in the meeting: seconds recorded before them,
 * pauses left out. A piece that fails is tried again, then left as a gap. The block (and anyone
 * else with the page open) sees the transcript fill in as the server writes it.
 */
import { CircleStop, Mic, Pause, Play } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { finishMeetingAction, markMeetingGapAction, meetingHeartbeatAction, startMeetingAction } from "@/app/actions/meetings";
import { IconButton } from "@/components/ui";
import { formatStamp, MAX_MEETING_SECONDS, MEETING_CHUNK_SECONDS, MEETING_HEARTBEAT_MS } from "@/lib/meetings";
import { RECORDER_BITS_PER_SECOND, RECORDER_TYPES, type VoiceNoteLimits } from "@/lib/voice-notes";
import { canRecord } from "./use-voice-recorder";

export type MeetingRecorderStatus = "starting" | "recording" | "paused" | "finishing";

/** The meeting being recorded, as the block and the bar show it. */
export type MeetingRecording = {
  pageId: string;
  meetingId: string;
  title: string;
  status: MeetingRecorderStatus;
  /** Seconds recorded, pauses left out. */
  seconds: number;
  /** Pieces left as gaps after their retries. */
  gaps: number;
  /** Pieces waiting to be sent. */
  waiting: number;
};

export type MeetingRecorder = {
  /** The recording limits when meetings can be recorded in this workspace, else null. */
  limits: VoiceNoteLimits | null;
  workspaceId: string;
  current: MeetingRecording | null;
  /** Why the last recording couldn't start or ended early (translated), until the next start. */
  problem: { meetingId: string; message: string } | null;
  start: (pageId: string, meetingId: string, title: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

const Context = createContext<MeetingRecorder | null>(null);

/** The workspace's meeting recorder; null outside a workspace (published pages, print). */
export const useMeetingRecorder = () => useContext(Context);

type Piece = { chunk: number; offset: number; duration: number; blob: Blob };

type Session = {
  pageId: string;
  meetingId: string;
  stream: MediaStream;
  mimeType: string;
  recorder: MediaRecorder | null;
  /** Seconds recorded before the piece being recorded now. */
  recorded: number;
  /** When the piece being recorded started (ms), while recording. */
  pieceStarted: number | null;
  nextChunk: number;
  paused: boolean;
  stopping: boolean;
  /** Ended for good: nothing more is sent, and the meeting isn't finished from here. */
  dropped: boolean;
  queue: Piece[];
  sending: boolean;
  gaps: number;
  ticker: ReturnType<typeof setInterval>;
  heartbeat: ReturnType<typeof setInterval> | null;
};

const RETRY_MS = [2_000, 5_000, 15_000];
/** Refusals no retry changes: the recording ends. */
const FINAL = new Set(["noAccess", "notFound", "notRecording", "tooLong", "disabled"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "noDevice";
  return "failed";
}

export function MeetingRecorderProvider({ workspaceId, limits, children }: { workspaceId: string; limits: VoiceNoteLimits | null; children: ReactNode }) {
  const te = useTranslations("meetings.errors");
  const [current, setCurrent] = useState<MeetingRecording | null>(null);
  const [problem, setProblem] = useState<MeetingRecorder["problem"]>(null);
  const session = useRef<Session | null>(null);
  const titleRef = useRef("");

  const recordedNow = (s: Session) => s.recorded + (s.pieceStarted !== null ? (Date.now() - s.pieceStarted) / 1000 : 0);

  const show = useCallback((s: Session | null, status?: MeetingRecorderStatus) => {
    if (!s) return setCurrent(null);
    setCurrent((prev) => ({
      pageId: s.pageId,
      meetingId: s.meetingId,
      title: titleRef.current,
      status: status ?? prev?.status ?? "recording",
      seconds: recordedNow(s),
      gaps: s.gaps,
      waiting: s.queue.length,
    }));
  }, []);

  const release = useCallback((s: Session) => {
    clearInterval(s.ticker);
    if (s.heartbeat) clearInterval(s.heartbeat);
    s.stream.getTracks().forEach((track) => track.stop());
  }, []);

  /** Ends the session without finishing the meeting (it went away, or access was lost). */
  const drop = useCallback(
    (s: Session, message: string) => {
      s.dropped = true;
      s.stopping = true;
      if (s.recorder && s.recorder.state !== "inactive") s.recorder.stop();
      release(s);
      if (session.current === s) session.current = null;
      setProblem({ meetingId: s.meetingId, message });
      setCurrent(null);
    },
    [release],
  );

  const finish = useCallback(
    async (s: Session) => {
      if (s.dropped || s.sending || s.queue.length || s.recorder) return;
      s.dropped = true;
      release(s);
      const res = await finishMeetingAction(s.pageId, s.meetingId, s.recorded).catch(() => null);
      if (session.current === s) session.current = null;
      setCurrent(null);
      if (!res?.ok) setProblem({ meetingId: s.meetingId, message: res?.error ?? te("failed") });
    },
    [release, te],
  );

  const send = useCallback(
    async (s: Session, piece: Piece) => {
      const place = { pageId: s.pageId, meetingId: s.meetingId, chunk: piece.chunk, offset: piece.offset, duration: piece.duration };
      for (let attempt = 0; attempt <= RETRY_MS.length; attempt++) {
        if (s.dropped) return;
        try {
          const form = new FormData();
          form.set("pageId", place.pageId);
          form.set("meetingId", place.meetingId);
          form.set("chunk", String(place.chunk));
          form.set("offset", String(place.offset));
          form.set("duration", String(place.duration));
          form.set("audio", new File([piece.blob], `meeting-${piece.chunk}.${s.mimeType.includes("mp4") ? "m4a" : s.mimeType.includes("ogg") ? "ogg" : "webm"}`, { type: piece.blob.type }));
          const res = await fetch("/api/meetings/chunk", { method: "POST", body: form });
          if (res.ok) return;
          const code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? "";
          if (FINAL.has(code)) return drop(s, te(code as "noAccess"));
        } catch {
          // Offline for a moment: tried again below.
        }
        if (attempt < RETRY_MS.length) await sleep(RETRY_MS[attempt]);
      }
      if (s.dropped) return;
      const gap = await markMeetingGapAction(place).catch(() => null);
      s.gaps++;
      if (gap && !gap.ok && gap.code && FINAL.has(gap.code)) drop(s, gap.error);
    },
    [drop, te],
  );

  const pump = useCallback(
    async (s: Session) => {
      if (s.sending) return;
      s.sending = true;
      while (s.queue.length && !s.dropped) {
        await send(s, s.queue[0]);
        s.queue.shift();
        if (session.current === s) show(s);
      }
      s.sending = false;
      if (s.stopping) await finish(s);
    },
    [send, show, finish],
  );

  /** Records the next piece, which ends itself after MEETING_CHUNK_SECONDS (or on pause and stop). */
  const startPiece = useCallback(
    (s: Session) => {
      const recorder = new MediaRecorder(s.stream, { ...(s.mimeType ? { mimeType: s.mimeType } : {}), audioBitsPerSecond: RECORDER_BITS_PER_SECOND });
      const parts: Blob[] = [];
      const started = Date.now();
      const offset = s.recorded;
      const chunk = s.nextChunk++;
      const length = Math.min(MEETING_CHUNK_SECONDS, Math.max(5, (limits?.maxSeconds ?? 600) - 5)) * 1000;
      // Pieces arrive every second, in background tabs too: the piece ends on the first one past its length.
      recorder.ondataavailable = (event) => {
        if (event.data.size) parts.push(event.data);
        if (recorder.state === "recording" && Date.now() - started >= length) recorder.stop();
      };
      recorder.onstop = () => {
        const duration = Math.max(0, (Date.now() - started) / 1000);
        s.recorded = offset + duration;
        s.pieceStarted = null;
        s.recorder = null;
        if (parts.length && !s.dropped) {
          s.queue.push({ chunk, offset: Math.round(offset * 10) / 10, duration: Math.round(duration * 10) / 10, blob: new Blob(parts, { type: recorder.mimeType || s.mimeType || "audio/webm" }) });
          void pump(s);
        }
        if (s.dropped) return;
        if (s.recorded >= MAX_MEETING_SECONDS) s.stopping = true;
        if (s.stopping) {
          show(s, "finishing");
          void finish(s);
        } else if (!s.paused) startPiece(s);
      };
      s.recorder = recorder;
      s.pieceStarted = started;
      recorder.start(1000);
    },
    [limits?.maxSeconds, pump, show, finish],
  );

  const start = useCallback(
    async (pageId: string, meetingId: string, title: string) => {
      if (session.current || !limits) return;
      setProblem(null);
      titleRef.current = title;
      if (!window.isSecureContext) return setProblem({ meetingId, message: te("insecure") });
      if (!canRecord()) return setProblem({ meetingId, message: te("unsupported") });
      setCurrent({ pageId, meetingId, title, status: "starting", seconds: 0, gaps: 0, waiting: 0 });
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (error) {
        setCurrent(null);
        return setProblem({ meetingId, message: te(startError(error) as "denied") });
      }
      const res = await startMeetingAction(pageId, meetingId).catch(() => null);
      if (!res?.ok) {
        stream.getTracks().forEach((track) => track.stop());
        setCurrent(null);
        return setProblem({ meetingId, message: res?.error ?? te("failed") });
      }
      const mimeType = RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? "";
      const s: Session = {
        pageId,
        meetingId,
        stream,
        mimeType,
        recorder: null,
        recorded: res.data.seconds,
        pieceStarted: null,
        nextChunk: res.data.nextChunk,
        paused: false,
        stopping: false,
        dropped: false,
        queue: [],
        sending: false,
        gaps: 0,
        ticker: setInterval(() => {
          if (session.current !== s) return;
          if (!s.stopping && recordedNow(s) >= MAX_MEETING_SECONDS) {
            s.stopping = true;
            s.recorder?.stop();
          }
          show(s);
        }, 500),
        heartbeat: null,
      };
      // The microphone went away (unplugged, or taken back in the browser's settings): end there.
      for (const track of stream.getTracks()) {
        track.onended = () => {
          if (session.current !== s || s.stopping) return;
          s.stopping = true;
          if (s.recorder) s.recorder.stop();
          else void finish(s);
        };
      }
      session.current = s;
      try {
        startPiece(s);
      } catch {
        drop(s, te("unsupported"));
        return;
      }
      show(s, "recording");
    },
    [limits, te, show, startPiece, finish, drop],
  );

  const pause = useCallback(() => {
    const s = session.current;
    if (!s || s.paused || s.stopping) return;
    s.paused = true;
    s.recorder?.stop();
    // Nothing is sent while paused: the meeting hears from its recorder anyway.
    s.heartbeat = setInterval(() => void meetingHeartbeatAction(s.pageId, s.meetingId, s.recorded).catch(() => {}), MEETING_HEARTBEAT_MS);
    show(s, "paused");
  }, [show]);

  const resume = useCallback(() => {
    const s = session.current;
    if (!s || !s.paused || s.stopping || s.recorder) return;
    s.paused = false;
    if (s.heartbeat) clearInterval(s.heartbeat);
    s.heartbeat = null;
    startPiece(s);
    show(s, "recording");
  }, [show, startPiece]);

  const stop = useCallback(() => {
    const s = session.current;
    if (!s || s.stopping) return;
    s.stopping = true;
    show(s, "finishing");
    if (s.recorder && s.recorder.state !== "inactive") s.recorder.stop();
    else void finish(s);
  }, [show, finish]);

  // Closing the tab or leaving the app would end the recording: the browser asks first.
  const active = current !== null;
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  // Leaving the workspace lets go of the microphone.
  useEffect(
    () => () => {
      const s = session.current;
      if (s) {
        s.dropped = true;
        if (s.recorder && s.recorder.state !== "inactive") s.recorder.stop();
        release(s);
      }
    },
    [release],
  );

  const value = useMemo<MeetingRecorder>(
    () => ({ limits, workspaceId, current, problem, start, pause, resume, stop }),
    [limits, workspaceId, current, problem, start, pause, resume, stop],
  );

  return (
    <Context.Provider value={value}>
      {children}
      {current && <RecordingBar recording={current} workspaceId={workspaceId} onPause={pause} onResume={resume} onStop={stop} />}
    </Context.Provider>
  );
}

/** The meeting being recorded, while the person is somewhere else in the app: time, pause, stop. */
function RecordingBar({
  recording,
  workspaceId,
  onPause,
  onResume,
  onStop,
}: {
  recording: MeetingRecording;
  workspaceId: string;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const t = useTranslations("meetings");
  const pathname = usePathname();
  const href = `/w/${workspaceId}/p/${recording.pageId}`;
  // On the meeting's own page its block has the controls.
  if (pathname === href) return null;
  const busy = recording.status === "starting" || recording.status === "finishing";
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm shadow-lg sm:inset-x-auto sm:inset-e-6"
    >
      <span className={recording.status === "recording" ? "h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-danger" : "h-2.5 w-2.5 shrink-0 rounded-full bg-fg-faint"} aria-hidden />
      <Link href={href} className="min-w-0 flex-1 truncate hover:underline">
        {recording.title.trim() || t("untitled")}
      </Link>
      <span className="shrink-0 tabular-nums text-fg-muted">{busy ? t("block.finishing") : formatStamp(recording.seconds)}</span>
      {!busy &&
        (recording.status === "paused" ? (
          <IconButton label={t("block.resume")} onClick={onResume}>
            <Play className="h-4 w-4" />
          </IconButton>
        ) : (
          <IconButton label={t("block.pause")} onClick={onPause}>
            <Pause className="h-4 w-4" />
          </IconButton>
        ))}
      {!busy && (
        <IconButton label={t("block.stop")} onClick={onStop}>
          <CircleStop className="h-4 w-4 text-danger" />
        </IconButton>
      )}
      {busy && <Mic className="h-4 w-4 shrink-0 text-fg-faint" aria-hidden />}
    </div>
  );
}
