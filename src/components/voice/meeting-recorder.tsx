"use client";

/**
 * Records a meeting (lib/meetings) for the whole workspace's screens: the provider sits in the
 * workspace layout, so the recording goes on when the person opens other pages or switches tabs.
 * One meeting at a time, recorded from the microphone or from an uploaded file. The recording
 * itself (meeting-session.ts, meeting-upload-session.ts) and the bar shown elsewhere in the app
 * load only when a recording starts: every workspace screen carries this provider.
 */
import { lazyPart } from "@/components/lazy-part";
import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MeetingSource } from "@/lib/meetings";
import type { VoiceNoteLimits } from "@/lib/voice-notes";
import type { SessionControls } from "./meeting-session";

const MeetingRecordingBar = lazyPart(() => import("./meeting-recording-bar").then((m) => m.default));

export type MeetingRecorderStatus = "starting" | "recording" | "paused" | "finishing";

/** The meeting being recorded, as the block and the bar show it. */
export type MeetingRecording = {
  pageId: string;
  meetingId: string;
  title: string;
  status: MeetingRecorderStatus;
  /** "file" while an uploaded recording is being sent, else "" (the microphone). */
  source: MeetingSource;
  /** Seconds recorded (of an upload: sent), pauses left out. */
  seconds: number;
  /** An upload's length in seconds (0 while it is read, and for the microphone). */
  total: number;
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
  /** Transcribes a recording made elsewhere into a meeting not recorded yet. */
  upload: (pageId: string, meetingId: string, title: string, file: File) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

const Context = createContext<MeetingRecorder | null>(null);

/** The workspace's meeting recorder; null outside a workspace (published pages, print). */
export const useMeetingRecorder = () => useContext(Context);

const running = (session: SessionControls | "starting" | null) => (typeof session === "object" ? session : null);

export function MeetingRecorderProvider({ workspaceId, limits, children }: { workspaceId: string; limits: VoiceNoteLimits | null; children: ReactNode }) {
  const te = useTranslations("meetings.errors");
  const [current, setCurrent] = useState<MeetingRecording | null>(null);
  const [problem, setProblem] = useState<MeetingRecorder["problem"]>(null);
  /** The running session's controls; "starting" while the microphone and the server are asked. */
  const session = useRef<SessionControls | "starting" | null>(null);

  /** Runs a session: `begin` starts it with the hooks, and resolves to its controls or why it couldn't start. */
  const open = useCallback(
    async (
      pageId: string,
      meetingId: string,
      title: string,
      source: MeetingSource,
      begin: (hooks: { update: (view: Partial<MeetingRecording>) => void; ended: (message: string | null) => void }) => Promise<{ controls: SessionControls } | { problem: string }>,
    ) => {
      if (session.current || !limits) return;
      session.current = "starting";
      setProblem(null);
      setCurrent({ pageId, meetingId, title, source, status: "starting", seconds: 0, total: 0, gaps: 0, waiting: 0 });
      let ended = false;
      const fail = (message: string) => {
        session.current = null;
        setCurrent(null);
        setProblem({ meetingId, message });
      };
      const started = await begin({
        update: (view) => setCurrent((was) => ({ pageId, meetingId, title, source, status: "starting", seconds: 0, total: 0, gaps: 0, waiting: 0, ...was, ...view })),
        ended: (message) => {
          ended = true;
          session.current = null;
          setCurrent(null);
          if (message) setProblem({ meetingId, message });
        },
      }).catch(() => ({ problem: te("failed") }));
      if ("problem" in started) return fail(started.problem);
      // The session may have ended already (the microphone went away at once).
      if (!ended) session.current = started.controls;
    },
    [limits, te],
  );

  const start = useCallback(
    (pageId: string, meetingId: string, title: string) =>
      open(pageId, meetingId, title, "", async (hooks) => {
        const { startMeetingSession } = await import("./meeting-session");
        return startMeetingSession(pageId, meetingId, limits?.maxSeconds ?? 0, { ...hooks, translate: (key) => te(key) });
      }),
    [open, limits, te],
  );

  const upload = useCallback(
    (pageId: string, meetingId: string, title: string, file: File) =>
      open(pageId, meetingId, title, "file", async (hooks) => {
        const { startMeetingUpload } = await import("./meeting-upload-session");
        return startMeetingUpload(pageId, meetingId, file, limits?.maxBytes ?? 0, { ...hooks, translate: (key) => te(key) });
      }),
    [open, limits, te],
  );

  const pause = useCallback(() => running(session.current)?.pause(), []);
  const resume = useCallback(() => running(session.current)?.resume(), []);
  const stop = useCallback(() => running(session.current)?.stop(), []);

  // Closing the tab or leaving the app would end the recording: the browser asks first.
  const active = current !== null;
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  // Leaving the workspace lets go of the microphone.
  useEffect(() => () => running(session.current)?.dispose(), []);

  const value = useMemo<MeetingRecorder>(
    () => ({ limits, workspaceId, current, problem, start, upload, pause, resume, stop }),
    [limits, workspaceId, current, problem, start, upload, pause, resume, stop],
  );

  return (
    <Context.Provider value={value}>
      {children}
      {current && <MeetingRecordingBar recording={current} workspaceId={workspaceId} onPause={pause} onResume={resume} onStop={stop} />}
    </Context.Provider>
  );
}
