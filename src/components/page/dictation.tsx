"use client";

/**
 * Dictating into a page at the caret: Cmd/Ctrl+Shift+D (or `/` Dictate) records, and what was said
 * is written where the caret was, as it was said (no AI rewrite). Pressing the chord again, Enter or
 * the chip beside the caret finishes; holding the chord and letting go finishes too (push to talk).
 * Esc, focus leaving the editor, the page closing or another dictation cancels and writes nothing.
 * The phases are lib/dictation's; recording and the transcription request are shared with the AI
 * chat's microphone (voice/dictation.ts, voice/use-voice-recorder.ts).
 *
 * The caret (and what was selected, which the text replaces) is kept as Yjs relative positions, so
 * it follows what anyone types meanwhile. The text goes in as one transaction, its own undo step;
 * when its place is gone it goes at the caret, and failing that to the clipboard.
 */
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import { Loader2, Mic, Speech } from "lucide-react";
import { useTranslations } from "next-intl";
import type { EditorState } from "prosemirror-state";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey, yUndoPluginKey } from "y-prosemirror";
import type { RelativePosition, UndoManager } from "yjs";
import { copyText } from "@/components/settings/copy-button";
import { showToast } from "@/components/toast";
import { claimDictation, transcribeRecording, useCanRecord, useDictationError } from "@/components/voice/dictation";
import { useVoiceRecorder, type Recording } from "@/components/voice/use-voice-recorder";
import { dictationText, isRecordingPhase, pressesDictate, releasesDictate, stepDictation, type DictationInput, type DictationPhase } from "@/lib/dictation";
import { comboText, DICTATE_COMBO, isMac } from "@/lib/shortcuts";
import type { VoiceNoteLimits } from "@/lib/voice-notes";
import type { PageEditor } from "./embed-blocks";

/** Where the text goes: the selection when dictation started, and the text that was selected. */
type Spot = number | RelativePosition;
type Target = { from: Spot; to: Spot; selected: string };

export type Dictation = {
  /** Starts dictating at the caret (the slash menu's entry); does nothing where it can't. */
  start: () => void;
  /** Dictation works in this editor: the workspace can transcribe and the browser can record. */
  available: boolean;
  /** The chip beside the caret while dictating. */
  chip: ReactNode;
};

const NO_LIMITS: VoiceNoteLimits = { maxSeconds: 0, maxBytes: 0 };
/** Stands for an inline node (a mention, a date) in the text around the caret. */
const INLINE = "￼";

/** Whether text may be written in place of from..to: both ends in text blocks that aren't code. */
function writable(state: EditorState, from: number, to: number): boolean {
  if (from < 0 || from > to || to > state.doc.content.size) return false;
  return [state.doc.resolve(from), state.doc.resolve(to)].every(($pos) => $pos.parent.isTextblock && !$pos.parent.type.spec.code);
}

/** The selection as a place that follows later edits, or null where nothing can be written. */
function capture(state: EditorState): Target | null {
  const { from, to } = state.selection;
  if (!writable(state, from, to)) return null;
  const selected = state.doc.textBetween(from, to, "\n", INLINE);
  const binding = ySyncPluginKey.getState(state)?.binding;
  if (binding) {
    try {
      return {
        from: absolutePositionToRelativePosition(from, binding.type, binding.mapping),
        to: absolutePositionToRelativePosition(to, binding.type, binding.mapping),
        selected,
      };
    } catch {
      // The positions as they are: checked again before writing.
    }
  }
  return { from, to, selected };
}

/** Where a kept place is now, or null when it is gone. */
function locate(state: EditorState, target: Target): { from: number; to: number } | null {
  if (typeof target.from === "number" || typeof target.to === "number") {
    return typeof target.from === "number" && typeof target.to === "number" ? { from: target.from, to: target.to } : null;
  }
  const binding = ySyncPluginKey.getState(state)?.binding;
  if (!binding) return null;
  try {
    const from = relativePositionToAbsolutePosition(binding.doc, binding.type, target.from, binding.mapping);
    const to = relativePositionToAbsolutePosition(binding.doc, binding.type, target.to, binding.mapping);
    return from === null || to === null ? null : { from: Math.min(from, to), to };
  } catch {
    return null;
  }
}

/**
 * Where to write: in place of what was selected (after it, when someone changed it meanwhile), else
 * at the caret, else nowhere.
 */
function writeRange(state: EditorState, target: Target): { from: number; to: number } | null {
  const kept = locate(state, target);
  if (kept && kept.to <= state.doc.content.size) {
    const range = state.doc.textBetween(kept.from, kept.to, "\n", INLINE) === target.selected ? kept : { from: kept.to, to: kept.to };
    if (writable(state, range.from, range.to)) return range;
  }
  const head = state.selection.head;
  return writable(state, head, head) ? { from: head, to: head } : null;
}

/** Writes what was said as one transaction (its own undo step); false when it can't go in. */
function writeDictation(editor: PageEditor, target: Target, said: string): boolean {
  const view = editor.prosemirrorView;
  if (!view || !editor.isEditable) return false;
  const state = view.state;
  const range = writeRange(state, target);
  if (!range) return false;
  const $from = state.doc.resolve(range.from);
  const $to = state.doc.resolve(range.to);
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, INLINE);
  const after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size, undefined, INLINE);
  const text = dictationText(before, after, said);
  if (!text) return true;
  const undo: UndoManager | undefined = yUndoPluginKey.getState(state)?.undoManager;
  undo?.stopCapturing();
  view.dispatch(state.tr.insertText(text, range.from, range.to));
  undo?.stopCapturing();
  return true;
}

/** Dictation for one page editor; `limits` null where the workspace can't transcribe or the person can't edit. */
export function useDictation(editor: PageEditor, workspaceId: string, limits: VoiceNoteLimits | null): Dictation {
  const t = useTranslations("page.dictation");
  const canRecord = useCanRecord();
  const available = limits !== null && canRecord;
  const message = useDictationError(limits?.maxBytes ?? 0);
  const [phase, setPhase] = useState<DictationPhase>("idle");
  // The phase as of now, for key handlers and the recorder's callbacks (state lags a render).
  const current = useRef<DictationPhase>("idle");
  const target = useRef<Target | null>(null);
  const recorded = useRef<Recording | null>(null);
  const abort = useRef<AbortController | null>(null);
  const release = useRef<(() => void) | null>(null);
  /** When the chord that started this dictation went down, while it is held. */
  const held = useRef<number | null>(null);
  const dispatchRef = useRef<(input: DictationInput) => void>(() => {});

  const recorder = useVoiceRecorder(limits ?? NO_LIMITS, (recording) => {
    recorded.current = recording;
    dispatchRef.current({ type: "recorded" });
  });
  const recorderRef = useRef(recorder);
  // After every render, on purpose: the handlers below use the latest recorder.
  useLayoutEffect(() => {
    recorderRef.current = recorder;
  });

  const write = useCallback(
    async (recording: Recording) => {
      const controller = new AbortController();
      abort.current = controller;
      let said: string;
      try {
        said = await transcribeRecording(recording, workspaceId, { signal: controller.signal, inPage: true });
      } catch (caught) {
        if (controller.signal.aborted) return;
        abort.current = null;
        showToast({ message: message((caught as Error).message) });
        dispatchRef.current({ type: "settled" });
        return;
      }
      if (controller.signal.aborted) return;
      abort.current = null;
      const place = target.current;
      let placed = false;
      try {
        placed = place !== null && writeDictation(editor, place, said);
      } catch (error) {
        console.error("[dictation]", error);
      }
      if (placed) {
        if (recording.limited) showToast({ message: t("autoStopped", { minutes: Math.round((limits?.maxSeconds ?? 0) / 60) }) });
      } else {
        // Never lost: what can't go in the page goes to the clipboard.
        const copied = await copyText(said.trim(), editor.domElement ?? document.body);
        showToast({ message: copied ? t("copied") : t("notPlaced", { text: said.trim() }) });
      }
      dispatchRef.current({ type: "settled" });
    },
    [editor, limits?.maxSeconds, message, t, workspaceId],
  );

  const dispatch = useCallback(
    (input: DictationInput) => {
      const step = stepDictation(current.current, input);
      current.current = step.phase;
      setPhase(step.phase);
      const rec = recorderRef.current;
      switch (step.effect) {
        case "start":
          release.current?.();
          release.current = claimDictation(() => dispatchRef.current({ type: "cancel" }));
          void rec.start();
          break;
        case "stop":
          rec.stop();
          break;
        case "discard":
          rec.cancel();
          break;
        case "send":
          if (recorded.current) void write(recorded.current);
          recorded.current = null;
          break;
        case "abort":
          abort.current?.abort();
          abort.current = null;
          break;
      }
      if (!isRecordingPhase(step.phase)) {
        release.current?.();
        release.current = null;
        held.current = null;
      }
      if (step.phase === "idle") target.current = null;
    },
    [write],
  );
  useLayoutEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  /** Starts at the caret of this editor, where text can be written. */
  const begin = useCallback(
    (pressedAt: number | null) => {
      if (!available || current.current !== "idle" || !editor.isEditable) return false;
      const state = editor.prosemirrorView?.state;
      const place = state ? capture(state) : null;
      if (!place) return false;
      target.current = place;
      dispatch({ type: "chord" });
      held.current = pressedAt;
      return true;
    },
    [available, dispatch, editor],
  );

  const start = useCallback(() => {
    if (!begin(null)) return;
    if (!editor.prosemirrorView?.hasFocus()) editor.focus();
  }, [begin, editor]);

  // The recorder's own news: the microphone is on, it ended without audio, or it couldn't start.
  const status = recorder.state.status;
  const failure = recorder.state.status === "error" ? recorder.state.code : null;
  useEffect(() => {
    if (status === "recording") dispatchRef.current({ type: "listening" });
    else if (status === "idle") dispatchRef.current({ type: "ended" });
  }, [status]);
  useEffect(() => {
    if (!failure || current.current !== "starting") return;
    showToast({ message: message(failure) });
    dispatchRef.current({ type: "failed" });
  }, [failure, message]);

  // The keys: the chord anywhere in this editor (or while this one dictates), Esc, Enter, letting go.
  useEffect(() => {
    if (!available) return;
    const mac = isMac();
    const onKeyDown = (e: KeyboardEvent) => {
      const now = current.current;
      if (pressesDictate(e, mac)) {
        if (now === "idle") {
          if (!editor.prosemirrorView?.hasFocus()) return;
          // Held down from before: not a new press.
          if (e.repeat) return;
          if (!begin(Date.now())) return;
        } else if (!e.repeat) {
          held.current = null;
          dispatch({ type: "chord" });
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (now === "idle" || e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dispatch({ type: "cancel" });
      } else if (e.key === "Enter" && now === "listening" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        dispatch({ type: "finish" });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (held.current === null || !releasesDictate(e)) return;
      const heldMs = Date.now() - held.current;
      held.current = null;
      dispatch({ type: "release", heldMs });
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [available, begin, dispatch, editor]);

  // Focus moving elsewhere in the window cancels a recording; switching windows (or the browser
  // asking for the microphone) doesn't.
  const recording = isRecordingPhase(phase);
  useEffect(() => {
    const dom = editor.domElement;
    if (!recording || !dom) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFocusOut = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (isRecordingPhase(current.current) && document.hasFocus() && !editor.prosemirrorView?.hasFocus()) dispatch({ type: "cancel" });
      });
    };
    dom.addEventListener("focusout", onFocusOut);
    return () => {
      clearTimeout(timer);
      dom.removeEventListener("focusout", onFocusOut);
    };
  }, [recording, dispatch, editor]);

  // Leaving the page, or the workspace no longer transcribing here, cancels; so does unmounting.
  useEffect(() => {
    const onHide = () => dispatchRef.current({ type: "cancel" });
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);
  useEffect(() => {
    if (!available && current.current !== "idle") dispatchRef.current({ type: "cancel" });
  }, [available]);
  useEffect(
    () => () => {
      abort.current?.abort();
      release.current?.();
    },
    [],
  );

  // The chip sits under the place the text goes, following scrolling and edits.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const position = useCallback(() => {
    const view = editor.prosemirrorView;
    const place = target.current;
    if (!view || !place) return setAt(null);
    const pos = locate(view.state, place)?.to ?? view.state.selection.head;
    try {
      const coords = view.coordsAtPos(Math.min(pos, view.state.doc.content.size));
      const below = coords.bottom + 6;
      // Above the line near the bottom of the window, and inside the window when the place scrolled away.
      const top = Math.max(8, Math.min(below + 36 > window.innerHeight ? coords.top - 36 : below, window.innerHeight - 40));
      const left = Math.max(8, Math.min(coords.left - 12, window.innerWidth - 248));
      setAt((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    } catch {
      setAt(null);
    }
  }, [editor]);
  const level = recorder.level;
  useLayoutEffect(() => {
    if (phase !== "idle") position();
  }, [phase, level, position]);
  useEffect(() => {
    if (phase === "idle") return;
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [phase, position]);

  const shortcut = useMemo(() => (available ? comboText(DICTATE_COMBO, isMac()) : ""), [available]);
  const label = phase === "starting" ? t("starting") : phase === "listening" ? t("listening") : t("writing");
  const chip =
    phase !== "idle" && at
      ? createPortal(
          <>
            <button
              type="button"
              data-dictation-chip=""
              tabIndex={-1}
              className="fixed z-50 flex max-w-60 items-center gap-2 rounded-full border border-border bg-bg py-1 ps-2 pe-1.5 text-xs shadow-md hover:bg-bg-hover"
              style={{ top: at.top, left: at.left }}
              title={t("hint", { shortcut })}
              aria-label={t("finish")}
              // Keeps the caret in the page: focus leaving it would cancel.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => dispatch({ type: "finish" })}
            >
              {phase === "listening" ? (
                <Mic className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />
              ) : (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-muted" aria-hidden />
              )}
              <span className="truncate font-medium">{label}</span>
              {phase === "listening" && <LevelMeter level={level} />}
              <kbd className="shrink-0 rounded border border-border bg-bg-subtle px-1 font-sans text-[11px] text-fg-muted">{shortcut}</kbd>
            </button>
            <span className="sr-only" role="status" aria-live="polite">
              {label}
            </span>
          </>,
          document.body,
        )
      : null;

  return { start, available, chip };
}

/** Bars that rise with how loud the microphone is (0-1). */
function LevelMeter({ level }: { level: number }) {
  return (
    <span className="flex h-3 shrink-0 items-center gap-0.5" aria-hidden>
      {[0.5, 0.85, 1, 0.7].map((weight, i) => (
        <span
          key={i}
          className="w-0.5 rounded-full bg-accent transition-[height] duration-150"
          style={{ height: `${3 + Math.round(Math.min(1, level * 1.5 * weight) * 9)}px` }}
        />
      ))}
    </span>
  );
}

/** The slash menu's "Dictate" entry, in the AI group beside "Voice note". */
export function useDictateSlashItems(start: () => void, enabled: boolean): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.dictation");
  const ta = useTranslations("ai.assistant");
  return useMemo(() => {
    if (!enabled) return [];
    return [
      {
        title: t("slashTitle"),
        subtext: t("slashSubtext"),
        aliases: t("slashAliases").split(" "),
        group: ta("group"),
        badge: comboText(DICTATE_COMBO, isMac()),
        icon: <Speech size={18} />,
        // After the slash menu removed "/…" and put the caret back.
        onItemClick: () => setTimeout(start),
      },
    ];
  }, [enabled, start, t, ta]);
}
