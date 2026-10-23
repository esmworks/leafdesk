"use client";

/**
 * Records a meeting (lib/meetings) for the whole workspace's screens: the provider sits in the
 * workspace layout, so the recording goes on when the person opens other pages or switches tabs.
 * One meeting at a time. The recording itself (meeting-session.ts) and the bar shown elsewhere in
 * the app load only when a recording starts: every workspace screen carries this provider.
 */
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { VoiceNoteLimits } from "@/lib/voice-notes";
import type { SessionControls } from "./meeting-session";

const MeetingRecordingBar = dynamic(() => import("./meeting-recording-bar"), { ssr: false });

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

const running = (session: SessionControls | "starting" | null) => (typeof session === "object" ? session : null);

export function MeetingRecorderProvider({ workspaceId, limits, children }: { workspaceId: string; limits: VoiceNoteLimits | null; children: ReactNode }) {
  const te = useTranslations("meetings.errors");
  const [current, setCurrent] = useState<MeetingRecording | null>(null);
  const [problem, setProblem] = useState<MeetingRecorder["problem"]>(null);
  /** The running session's controls; "starting" while the microphone and the server are asked. */
  const session = useRef<SessionControls | "starting" | null>(null);

  const start = useCallback(
    async (pageId: string, meetingId: string, title: string) => {
      if (session.current || !limits) return;
      session.current = "starting";
      setProblem(null);
      setCurrent({ pageId, meetingId, title, status: "starting", seconds: 0, gaps: 0, waiting: 0 });
      let ended = false;
      const fail = (message: string) => {
        session.current = null;
        setCurrent(null);
        setProblem({ meetingId, message });
      };
      const started = await import("./meeting-session")
        .then(({ startMeetingSession }) =>
          startMeetingSession(pageId, meetingId, limits.maxSeconds, {
            translate: (key) => te(key),
            update: (view) => setCurrent({ pageId, meetingId, title, ...view }),
            ended: (message) => {
              ended = true;
              session.current = null;
              setCurrent(null);
              if (message) setProblem({ meetingId, message });
            },
          }),
        )
        .catch(() => ({ problem: te("failed") }));
      if ("problem" in started) return fail(started.problem);
      // The session may have ended already (the microphone went away at once).
      if (!ended) session.current = started.controls;
    },
    [limits, te],
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
    () => ({ limits, workspaceId, current, problem, start, pause, resume, stop }),
    [limits, workspaceId, current, problem, start, pause, resume, stop],
  );

  return (
    <Context.Provider value={value}>
      {children}
      {current && <MeetingRecordingBar recording={current} workspaceId={workspaceId} onPause={pause} onResume={resume} onStop={stop} />}
    </Context.Provider>
  );
}
