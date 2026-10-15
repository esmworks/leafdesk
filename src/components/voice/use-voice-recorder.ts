"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RECORDER_BITS_PER_SECOND, RECORDER_TYPES, type VoiceNoteLimits } from "@/lib/voice-notes";

/** Why recording didn't start: see `page.voiceNote.errors`. */
export type RecorderErrorCode = "unsupported" | "insecure" | "denied" | "noDevice" | "failed";

export type RecorderState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "recording"; seconds: number }
  | { status: "error"; code: RecorderErrorCode };

/** A finished recording; `limited` when it stopped at the length or size limit. */
export type Recording = { blob: Blob; type: string; seconds: number; limited: boolean };

/** Whether this browser can record at all (false on the server and in old browsers). */
export function canRecord(): boolean {
  return typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

function startError(error: unknown): RecorderErrorCode {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "noDevice";
  return "failed";
}

/**
 * Records from the microphone with MediaRecorder, in the best format the browser has (see
 * RECORDER_TYPES), up to the server's length and size limits: it stops by itself at either.
 * `level` is how loud the microphone is now (0-1), for a meter.
 */
export function useVoiceRecorder(limits: VoiceNoteLimits, onRecorded: (recording: Recording) => void) {
  const [state, setState] = useState<RecorderState>({ status: "idle" });
  const [level, setLevel] = useState(0);
  const session = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    started: number;
    timer: ReturnType<typeof setInterval>;
    audio: AudioContext | null;
    discard: boolean;
    limited: boolean;
  } | null>(null);
  /**
   * Bumped by every start() and cancel(): a start() still waiting for the microphone (the permission
   * prompt) that finds it changed, or the component gone, lets go of the microphone instead of
   * recording.
   */
  const attempt = useRef(0);
  const mounted = useRef(true);
  const handler = useRef(onRecorded);
  useEffect(() => {
    handler.current = onRecorded;
  }, [onRecorded]);

  const release = useCallback(() => {
    const current = session.current;
    if (!current) return;
    clearInterval(current.timer);
    current.stream.getTracks().forEach((track) => track.stop());
    void current.audio?.close().catch(() => {});
    session.current = null;
    setLevel(0);
  }, []);

  const stop = useCallback((limited = false) => {
    const current = session.current;
    if (!current || current.recorder.state === "inactive") return;
    current.limited ||= limited;
    current.recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    attempt.current++;
    const current = session.current;
    if (!current) return setState({ status: "idle" });
    current.discard = true;
    if (current.recorder.state !== "inactive") current.recorder.stop();
    else release();
  }, [release]);

  const start = useCallback(async () => {
    if (session.current) return;
    if (!window.isSecureContext) return setState({ status: "error", code: "insecure" });
    if (!canRecord()) return setState({ status: "error", code: "unsupported" });
    const mine = ++attempt.current;
    setState({ status: "starting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      if (mine === attempt.current && mounted.current) setState({ status: "error", code: startError(error) });
      return;
    }
    // Cancelled, closed or started again while the browser asked for the microphone.
    if (mine !== attempt.current || !mounted.current || session.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const mimeType = RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? "";
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: RECORDER_BITS_PER_SECOND });
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      return setState({ status: "error", code: "unsupported" });
    }
    const chunks: Blob[] = [];
    let bytes = 0;
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      chunks.push(event.data);
      bytes += event.data.size;
      // Room for the last piece, which arrives after stop().
      if (bytes > limits.maxBytes * 0.95) stop(true);
    };
    recorder.onstop = () => {
      const current = session.current;
      const seconds = current ? (Date.now() - current.started) / 1000 : 0;
      const discard = current?.discard ?? true;
      const limited = current?.limited ?? false;
      release();
      setState({ status: "idle" });
      if (discard || !chunks.length) return;
      const type = recorder.mimeType || mimeType || "audio/webm";
      handler.current({ blob: new Blob(chunks, { type }), type, seconds, limited });
    };

    // A meter, so people see the microphone hears them; recording works without it.
    let audio: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      audio = new AudioContext();
      analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(analyser);
    } catch {
      audio = null;
      analyser = null;
    }
    const samples = analyser ? new Uint8Array(analyser.fftSize) : null;

    const started = Date.now();
    const timer = setInterval(() => {
      const seconds = (Date.now() - started) / 1000;
      if (seconds >= limits.maxSeconds) stop(true);
      setState((prev) => (prev.status === "recording" ? { status: "recording", seconds } : prev));
      if (analyser && samples) {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += ((s - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
      }
    }, 150);
    session.current = { recorder, stream, started, timer, audio, discard: false, limited: false };
    // Pieces every second, so the size limit is watched while recording.
    recorder.start(1000);
    setState({ status: "recording", seconds: 0 });
  }, [limits.maxBytes, limits.maxSeconds, release, stop]);

  // Leaving the page (or closing the dialog) lets go of the microphone.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = session.current;
      if (!current) return;
      current.discard = true;
      if (current.recorder.state !== "inactive") current.recorder.stop();
      current.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return { state, level, start, stop: () => stop(false), cancel };
}
