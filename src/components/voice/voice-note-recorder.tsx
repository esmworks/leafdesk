"use client";

/**
 * Records a voice note and has the server write it up (POST /api/ai/voice-note, see
 * server/voice-notes.ts): used by the quick note (app/share) and the editor's "Voice note" dialog.
 * People can choose an audio file instead, where the browser can't record or they have one already.
 * The finished note goes to `onDraft`; saving or inserting it is the caller's part.
 */
import { FileAudio, Loader2, Mic, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, cn } from "@/components/ui";
import { isAiErrorCode } from "@/lib/ai";
import { formatBytes } from "@/lib/files";
import { formatDuration, VOICE_ACCEPT, voiceAudioType, voiceFileName, type VoiceNoteDraft, type VoiceNoteLimits } from "@/lib/voice-notes";
import { useVoiceRecorder, type Recording } from "./use-voice-recorder";

type Phase = { step: "ready" } | { step: "sending"; stage: "transcribing" | "writing"; limited: boolean };

export function VoiceNoteRecorder({
  limits,
  fields,
  onDraft,
  autoStart = false,
  onBusyChange,
}: {
  limits: VoiceNoteLimits;
  /** Where the note goes: `workspaceId` (and `databaseId`) or `pageId`, sent with the audio. */
  fields: Record<string, string | null | undefined>;
  onDraft: (draft: VoiceNoteDraft) => void;
  /** Starts recording right away (the app's "Voice note" shortcut). */
  autoStart?: boolean;
  /** Recording or waiting for the server. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useTranslations("page.voiceNote");
  const [phase, setPhase] = useState<Phase>({ step: "ready" });
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fieldsRef = useRef(fields);
  useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);

  const message = useCallback(
    (code: string) => {
      const key = isAiErrorCode(code) || code === "fileType" || code === "fileTooLarge" ? code : "provider";
      return t(`errors.${key}`, { max: formatBytes(limits.maxBytes) });
    },
    [limits.maxBytes, t],
  );

  const send = useCallback(
    async (audio: Blob, type: string, limited: boolean) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setError(null);
      setPhase({ step: "sending", stage: "transcribing", limited });
      const form = new FormData();
      form.append("audio", new File([audio], voiceFileName(type), { type }));
      for (const [name, value] of Object.entries(fieldsRef.current)) if (value) form.append(name, value);
      try {
        const res = await fetch("/api/ai/voice-note", { method: "POST", body: form, signal: controller.signal });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
          throw new Error(body?.error?.code ?? "provider");
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const event = JSON.parse(line) as { type: string; stage?: "writing"; draft?: VoiceNoteDraft; code?: string };
            if (event.type === "stage" && event.stage) setPhase({ step: "sending", stage: event.stage, limited });
            else if (event.type === "error") throw new Error(event.code ?? "provider");
            else if (event.type === "done" && event.draft) {
              setPhase({ step: "ready" });
              onDraft(event.draft);
              return;
            }
          }
        }
        throw new Error("provider");
      } catch (caught) {
        if (controller.signal.aborted) return;
        setPhase({ step: "ready" });
        setError(message((caught as Error).message));
      } finally {
        if (abort.current === controller) abort.current = null;
      }
    },
    [message, onDraft],
  );

  const onRecorded = useCallback((recording: Recording) => void send(recording.blob, recording.type, recording.limited), [send]);
  const recorder = useVoiceRecorder(limits, onRecorded);
  const { state } = recorder;
  const busy = state.status === "recording" || state.status === "starting" || phase.step === "sending";

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  // Once per mount: a remount (React's development double mount included) cancels the earlier
  // start while it waits for the microphone, and this one takes over.
  const { start } = recorder;
  useEffect(() => {
    if (autoStart) void start();
  }, [autoStart, start]);

  // Closing the dialog or leaving the page stops waiting for the server.
  useEffect(() => () => abort.current?.abort(), []);

  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    const type = voiceAudioType(file.type, file.name);
    if (!type) return setError(message("fileType"));
    if (file.size > limits.maxBytes) return setError(message("fileTooLarge"));
    void send(file, type, false);
  };

  const shownError = error ?? (state.status === "error" ? t(`errors.${state.code}`) : null);

  if (phase.step === "sending") {
    return (
      <div className="rounded-lg border border-border bg-bg-subtle p-4" aria-live="polite">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 size={16} className="animate-spin text-fg-muted" aria-hidden />
          <span>{phase.stage === "transcribing" ? t("transcribing") : t("writing")}</span>
        </div>
        {phase.limited && <p className="mt-2 text-xs text-fg-muted">{t("autoStopped", { minutes: Math.round(limits.maxSeconds / 60) })}</p>}
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              abort.current?.abort();
              setPhase({ step: "ready" });
            }}
          >
            {t("cancel")}
          </Button>
        </div>
      </div>
    );
  }

  if (state.status === "recording") {
    return (
      <div className="rounded-lg border border-border bg-bg-subtle p-4" aria-live="polite">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3 shrink-0" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-danger" />
          </span>
          <span className="text-sm font-medium">{t("recording")}</span>
          <span className="ml-auto text-sm tabular-nums text-fg-muted">
            {formatDuration(state.seconds)} / {formatDuration(limits.maxSeconds)}
          </span>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-active" aria-hidden>
          <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${Math.round(recorder.level * 100)}%` }} />
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button size="md" variant="ghost" onClick={recorder.cancel}>
            {t("discard")}
          </Button>
          <Button size="md" variant="primary" onClick={recorder.stop} autoFocus>
            <Square size={14} fill="currentColor" aria-hidden />
            {t("stop")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="primary" onClick={() => void recorder.start()} disabled={state.status === "starting"} className="h-10 px-4">
          {state.status === "starting" ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Mic size={16} aria-hidden />}
          {t("record")}
        </Button>
        <span className="text-xs text-fg-muted">{t("limit", { minutes: Math.round(limits.maxSeconds / 60) })}</span>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="inline-flex items-center gap-1 text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
        >
          <FileAudio size={14} aria-hidden />
          {t("chooseFile")}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={VOICE_ACCEPT}
          className="hidden"
          onChange={(e) => {
            chooseFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {shownError && (
        <p role="alert" className={cn("text-xs text-danger")}>
          {shownError}
        </p>
      )}
    </div>
  );
}
