"use client";

/**
 * What dictating shares, in the AI chat's box (ai-chat/dictate-button.tsx) and in a page
 * (page/dictation.tsx): whether the browser can record, sending a recording to be written down
 * (POST /api/ai/transcribe), the messages for what went wrong, and one dictation at a time.
 */
import { useTranslations } from "next-intl";
import { useCallback, useSyncExternalStore } from "react";
import { canRecord, type Recording } from "@/components/voice/use-voice-recorder";
import { isAiErrorCode } from "@/lib/ai";
import { formatBytes } from "@/lib/files";
import { voiceFileName } from "@/lib/voice-notes";

/** Codes with their own message (ai.chat.dictation.errors); the AI's other failures have ai.errors'. */
const OWN_ERRORS = ["unsupported", "denied", "noDevice", "failed", "disabled", "tooLarge", "timeout", "provider", "empty"] as const;
const ownError = (code: string): code is (typeof OWN_ERRORS)[number] => (OWN_ERRORS as readonly string[]).includes(code);

const noSubscription = () => () => {};

/** Whether this browser can record; false during the server render and hydration. */
export function useCanRecord() {
  return useSyncExternalStore(noSubscription, canRecord, () => false);
}

/** The message for a failure code, from the recorder or the transcription route. */
export function useDictationError(maxBytes: number) {
  const t = useTranslations("ai.chat.dictation");
  const tAi = useTranslations("ai.errors");
  return useCallback(
    (code: string) => {
      const key = code === "insecure" ? "unsupported" : code === "noAccess" ? "disabled" : code;
      if (ownError(key)) return t(`errors.${key}`, { max: formatBytes(maxBytes) });
      return tAi(isAiErrorCode(key) ? key : "provider", { seconds: 0 });
    },
    [maxBytes, t, tAi],
  );
}

/**
 * What was said in a recording, as the server wrote it down; `inPage` counts it as dictation into
 * a page rather than the chat's. Throws an Error whose message is the failure's code.
 */
export async function transcribeRecording(
  recording: Recording,
  workspaceId: string,
  { signal, inPage = false }: { signal?: AbortSignal; inPage?: boolean } = {},
): Promise<string> {
  const form = new FormData();
  form.append("audio", new File([recording.blob], voiceFileName(recording.type), { type: recording.type }));
  form.append("workspaceId", workspaceId);
  if (inPage) form.append("use", "page");
  const res = await fetch("/api/ai/transcribe", { method: "POST", body: form, signal });
  const body = (await res.json().catch(() => null)) as { text?: unknown; error?: { code?: string } } | null;
  if (!res.ok || typeof body?.text !== "string") throw new Error(body?.error?.code ?? "provider");
  return body.text;
}

let owner: { cancel: () => void } | null = null;

/**
 * Takes the microphone for a dictation: one that had it is cancelled. Returns the release, which
 * does nothing once another dictation took it.
 */
export function claimDictation(cancel: () => void): () => void {
  const mine = { cancel };
  const previous = owner;
  owner = mine;
  if (previous) previous.cancel();
  return () => {
    if (owner === mine) owner = null;
  };
}
