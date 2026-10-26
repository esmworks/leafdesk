"use client";

import { Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn, IconButton, selectClass } from "@/components/ui";
import { parseRate, pickVoice, READ_ALOUD_RATES, splitForSpeech } from "@/lib/read-aloud";

const STORE_KEY = "leafdesk.readAloud";
/** Blocks left unread: code says little read out. */
const SKIPPED_TYPES = new Set(["codeBlock"]);

type Part = { el: HTMLElement | null; text: string };

function readStore(): { voice: string | null; rate: number } {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as { voice?: unknown; rate?: unknown };
    return { voice: typeof stored.voice === "string" ? stored.voice : null, rate: parseRate(stored.rate) };
  } catch {
    return { voice: null, rate: 1 };
  }
}

function writeStore(value: { voice: string | null; rate: number }) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(value));
  } catch {
    // Remembered for next time only where the browser lets it.
  }
}

/** A block's own text, without the names of others' cursors drawn in it. */
function blockText(el: HTMLElement): string {
  const out: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      node instanceof HTMLElement && node.matches(".bn-collaboration-cursor__base, [contenteditable=false] button")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) out.push(node.textContent ?? "");
    else if ((node as HTMLElement).tagName === "BR") out.push(" ");
  }
  return out.join("").replace(/⁠/g, "");
}

/** The title, then each block of the page's body with text, in the order shown. */
function pageParts(root: HTMLElement, title: string): Part[] {
  const editor = root.querySelector<HTMLElement>(".leafdesk-editor");
  const blocks = editor ? [...editor.querySelectorAll<HTMLElement>(".bn-block-content")] : [];
  const parts: Part[] = title.trim() ? [{ el: null, text: title }] : [];
  for (const el of blocks) {
    // A block holding others (columns, a synced page) is read through them.
    if (el.querySelector(".bn-block-content") || SKIPPED_TYPES.has(el.dataset.contentType ?? "")) continue;
    const text = blockText(el).trim();
    if (text) parts.push({ el, text });
  }
  return parts;
}

/**
 * Reads the page aloud with the browser's speech, block by block, marking and scrolling to the
 * block being read. Nothing leaves the device. Pausing stops the current block, and playing again
 * starts it over (pausing mid-utterance isn't reliable in every browser).
 */
export function ReadAloud({ root, title, onClose }: { root: HTMLElement | null; title: string; onClose: () => void }) {
  const t = useTranslations("page.readAloud");
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [settings, setSettings] = useState(readStore);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [parts, setParts] = useState<Part[]>([]);
  // Each start bumps this: callbacks of utterances cancelled since then do nothing.
  const run = useRef(0);
  const marked = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!supported) return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, [supported]);

  const mark = useCallback((el: HTMLElement | null) => {
    marked.current?.removeAttribute("data-reading");
    marked.current = el;
    if (el) {
      el.setAttribute("data-reading", "");
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, []);

  const stop = useCallback(() => {
    run.current++;
    if (supported) speechSynthesis.cancel();
    setPlaying(false);
  }, [supported]);

  const lang = document.documentElement.lang || navigator.language;
  const voice = pickVoice(voices, lang, settings.voice);

  /** Reads `list` from block `from` on, with `use`'s voice and speed. */
  const speakFrom = useCallback(
    (from: number, list: Part[], use: { voice: string | null; rate: number }) => {
      if (!supported) return;
      const id = ++run.current;
      speechSynthesis.cancel();
      const chosen = pickVoice(speechSynthesis.getVoices(), lang, use.voice);
      const next = (i: number) => {
        if (id !== run.current) return;
        if (i >= list.length) {
          setPlaying(false);
          setIndex(0);
          mark(null);
          return;
        }
        setIndex(i);
        mark(list[i].el);
        const pieces = splitForSpeech(list[i].text);
        pieces.forEach((piece, n) => {
          const u = new SpeechSynthesisUtterance(piece);
          if (chosen) {
            u.voice = chosen;
            u.lang = chosen.lang;
          }
          u.rate = use.rate;
          if (n === pieces.length - 1) u.onend = () => next(i + 1);
          u.onerror = (e) => {
            // Cancelling (pause, skip, close) reports an error too; only a real one stops reading.
            if (id === run.current && e.error !== "canceled" && e.error !== "interrupted") stop();
          };
          speechSynthesis.speak(u);
        });
      };
      setPlaying(true);
      next(from);
    },
    [supported, lang, mark, stop],
  );

  // Starts reading as it opens, from the top.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded || !root || !supported) return;
    setLoaded(true);
    const list = pageParts(root, title);
    setParts(list);
    if (list.length) speakFrom(0, list, settings);
  }, [loaded, root, title, supported, speakFrom, settings]);

  // Closing (or leaving the page) stops the voice and takes the mark away.
  useEffect(
    () => () => {
      run.current++;
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      marked.current?.removeAttribute("data-reading");
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Reads again from `i` with the page as it is now (it may have changed since). */
  function playAt(i: number) {
    const list = root ? pageParts(root, title) : parts;
    setParts(list);
    const at = Math.max(0, Math.min(i, list.length - 1));
    if (list.length) speakFrom(at, list, settings);
  }

  function change(next: { voice?: string | null; rate?: number }) {
    const value = { ...settings, ...next };
    setSettings(value);
    writeStore(value);
    // The new voice or speed takes over from the block being read.
    if (playing) speakFrom(index, parts, value);
  }

  const message = !supported ? t("unsupported") : loaded && !parts.length ? t("nothing") : null;

  return (
    <div
      role="region"
      aria-label={t("label")}
      className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-1 rounded-full border border-border bg-bg px-2 py-1.5 shadow-lg print:hidden"
    >
      {message ? (
        <span className="px-2 text-sm text-fg-muted">{message}</span>
      ) : (
        <>
          <IconButton label={t("previous")} className="h-8 w-8" disabled={!parts.length} onClick={() => playAt(index - 1)}>
            <SkipBack className="h-4 w-4" />
          </IconButton>
          <button
            type="button"
            aria-label={playing ? t("pause") : t("play")}
            title={playing ? t("pause") : t("play")}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg hover:opacity-90 disabled:opacity-50"
            disabled={!parts.length}
            onClick={() => (playing ? stop() : playAt(index))}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <IconButton label={t("next")} className="h-8 w-8" disabled={!parts.length || index >= parts.length - 1} onClick={() => playAt(index + 1)}>
            <SkipForward className="h-4 w-4" />
          </IconButton>
          <span className="px-1 text-xs text-fg-muted tabular-nums" aria-live="off">
            {t("progress", { current: Math.min(index + 1, parts.length), total: parts.length })}
          </span>
          <label className="sr-only" htmlFor="read-aloud-rate">
            {t("speed")}
          </label>
          <select
            id="read-aloud-rate"
            className={cn(selectClass, "h-7 rounded-full px-2 text-xs")}
            value={settings.rate}
            onChange={(e) => change({ rate: parseRate(e.target.value) })}
          >
            {READ_ALOUD_RATES.map((r) => (
              <option key={r} value={r}>
                {`${r}×`}
              </option>
            ))}
          </select>
          {voices.length > 1 && (
            <>
              <label className="sr-only" htmlFor="read-aloud-voice">
                {t("voice")}
              </label>
              <select
                id="read-aloud-voice"
                className={cn(selectClass, "h-7 max-w-40 rounded-full px-2 text-xs")}
                value={voice?.voiceURI ?? ""}
                onChange={(e) => change({ voice: e.target.value || null })}
              >
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {`${v.name} (${v.lang})`}
                  </option>
                ))}
              </select>
            </>
          )}
        </>
      )}
      <IconButton label={t("close")} className="h-8 w-8" onClick={onClose}>
        <X className="h-4 w-4" />
      </IconButton>
    </div>
  );
}
