"use client";

/**
 * Dictating a question in the AI chat's box: the microphone records (components/voice), the server
 * writes down what was said (POST /api/ai/transcribe) and the text goes into the box, not sent, so
 * the person can fix it first. The same button starts and stops; while recording it turns red and
 * says so, with the time in it, and a way to cancel (or Escape) shows beside it. Only where the workspace can transcribe and the browser
 * can record. What it shares with dictating into a page is in voice/dictation.ts.
 */
import { Loader2, Mic, Square, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { claimDictation, transcribeRecording, useDictationError } from "@/components/voice/dictation";
import { useVoiceRecorder, type Recording } from "@/components/voice/use-voice-recorder";
import { cn, IconButton } from "@/components/ui";
import { formatDuration, type VoiceNoteLimits } from "@/lib/voice-notes";

/** What the box shows above itself about the last recording: a failure, or a note. */
export type DictationNotice = { message: string; error: boolean } | null;

export function DictateButton({
  workspaceId,
  limits,
  disabled,
  onText,
  onNotice,
}: {
  workspaceId: string;
  limits: VoiceNoteLimits;
  disabled: boolean;
  /** What was said, to go into the box. */
  onText: (text: string) => void;
  onNotice: (notice: DictationNotice) => void;
}) {
  const t = useTranslations("ai.chat.dictation");
  const [sending, setSending] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const message = useDictationError(limits.maxBytes);

  const send = useCallback(
    async (recording: Recording) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setSending(true);
      try {
        onText(await transcribeRecording(recording, workspaceId, { signal: controller.signal }));
        onNotice(recording.limited ? { message: t("autoStopped", { minutes: Math.round(limits.maxSeconds / 60) }), error: false } : null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        onNotice({ message: message((caught as Error).message), error: true });
      } finally {
        if (abort.current === controller) {
          abort.current = null;
          setSending(false);
        }
      }
    },
    [limits.maxSeconds, message, onNotice, onText, t, workspaceId],
  );

  const recorder = useVoiceRecorder(limits, (recording) => void send(recording));
  const { state, start, stop, cancel } = recorder;
  const recording = state.status === "recording";
  const starting = state.status === "starting";

  // The recorder's own failures (no permission, no microphone) show with the others.
  const failed = state.status === "error" ? state.code : null;
  useEffect(() => {
    if (failed) onNotice({ message: message(failed), error: true });
  }, [failed, message, onNotice]);

  const stopWaiting = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setSending(false);
  }, []);
  // Closing the chat stops waiting for the server; the recorder lets go of the microphone itself.
  useEffect(() => () => abort.current?.abort(), []);

  // One dictation at a time: starting one in a page cancels this recording, and this one cancels it.
  useEffect(() => {
    if (recording || starting) return claimDictation(cancel);
  }, [recording, starting, cancel]);

  // Escape cancels a recording rather than closing the panel around it.
  useEffect(() => {
    if (!recording && !starting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, starting, cancel]);

  const label = sending ? t("transcribing") : recording ? t("stop") : t("start");
  return (
    <>
      {/* One button that starts and stops, so focus stays on it; its colors are its own, so not IconButton. */}
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={recording}
        aria-disabled={sending || undefined}
        className={cn(
          "inline-flex h-7 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-40 disabled:hover:bg-transparent",
          recording
            ? "gap-1.5 bg-danger/10 px-2 text-xs font-medium text-danger hover:bg-danger/20"
            : "w-7 text-fg-muted hover:bg-bg-active hover:text-fg",
        )}
        disabled={disabled && !recording && !sending}
        onClick={() => {
          if (sending) return;
          if (recording) return stop();
          if (starting) return cancel();
          onNotice(null);
          void start();
        }}
      >
        {sending || starting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : recording ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-danger motion-safe:animate-pulse" aria-hidden />
            <span role="timer" className="tabular-nums">
              {formatDuration(state.seconds)}
            </span>
            <Square className="h-3 w-3 fill-current" aria-hidden />
            <span>{t("stopShort")}</span>
          </>
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </button>
      {(recording || sending) && (
        <IconButton label={t("cancel")} className="h-7 w-7" onClick={recording ? cancel : stopWaiting}>
          <X className="h-4 w-4" />
        </IconButton>
      )}
      <span className="sr-only" aria-live="polite">
        {sending ? t("transcribing") : ""}
      </span>
    </>
  );
}
