"use client";

import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { TextSelection } from "prosemirror-state";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, cn, IconButton } from "@/components/ui";
import { replaceAllMatches, replaceMatch, stepIndex } from "@/lib/find-replace";
import { isMac } from "@/lib/shortcuts";
import type { PageEditor } from "./embed-blocks";
import { findKey, FindReplace, type FindMeta } from "./find-replace";

/** Longest selection that seeds the query; longer ones are more likely an accident than a search. */
const MAX_SEED = 200;

/** The text selected where focus is: in a field, or in the page (including the editor). */
function selectedText(): string {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const { selectionStart: start, selectionEnd: end } = el;
    return start !== null && end !== null ? el.value.slice(start, end) : "";
  }
  return window.getSelection()?.toString() ?? "";
}

/**
 * Find (and, for editors, replace) in the page body. Cmd/Ctrl+F opens it while focus is inside the
 * page (the element marked `data-find-scope`); elsewhere the browser's own find runs. Floats in the
 * top-right corner of the editor and stays there while the page scrolls.
 */
export function FindBar({ editor, editable }: { editor: PageEditor; editable: boolean }) {
  const t = useTranslations("page.find");
  const locale = useLocale();
  const extension = editor.getExtension(FindReplace);
  const subscribe = useCallback((listener: () => void) => extension?.subscribe(listener) ?? (() => {}), [extension]);
  const state = useSyncExternalStore(
    subscribe,
    () => findKey.getState(editor.prosemirrorState),
    () => undefined,
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  // Bumped on every Cmd/Ctrl+F, so pressing it again focuses the open bar too.
  const [focusRequest, setFocusRequest] = useState(0);
  const canReplace = editable && replaceOpen;

  const current = () => findKey.getState(editor.prosemirrorState);
  const dispatch = useCallback(
    (meta: FindMeta) => editor.transact((tr) => void tr.setMeta(findKey, meta)),
    [editor],
  );

  // The plugin searches for what the bar shows; closing clears the highlights.
  useEffect(() => {
    if (!open && !findKey.getState(editor.prosemirrorState)?.query) return;
    dispatch({ query: open ? query : "", caseSensitive, locale, reveal: open });
  }, [editor, dispatch, open, query, caseSensitive, locale]);

  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  function step(direction: 1 | -1) {
    const s = current();
    if (!s || s.matches.length === 0) return;
    dispatch({ current: stepIndex(s.current, s.matches.length, direction), reveal: true });
  }

  function openBar() {
    const active = document.activeElement;
    const fromBar = !!rootRef.current && rootRef.current.contains(active);
    if (!fromBar) {
      returnFocus.current = active instanceof HTMLElement ? active : null;
      const seed = selectedText();
      if (seed && !seed.includes("\n") && seed.length <= MAX_SEED) setQuery(seed);
    }
    setOpen(true);
    setFocusRequest((n) => n + 1);
  }

  function close() {
    const s = current();
    const match = s?.matches[s.current];
    setOpen(false);
    if (editable && match) {
      // Leave the match selected, the way the browser's find does.
      editor.transact((tr) => void tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)));
      editor.focus();
    } else if (returnFocus.current?.isConnected) {
      returnFocus.current.focus();
    }
    returnFocus.current = null;
  }

  function replaceCurrent() {
    const s = current();
    const match = s?.matches[s.current];
    if (!editable || !match) return;
    editor.transact((tr) => {
      replaceMatch(tr, match, replacement);
      // Carry on after the new text, so a replacement containing the query isn't found again.
      tr.setMeta(findKey, { anchor: match.from + replacement.length, reveal: true } satisfies FindMeta);
    });
  }

  function replaceAll() {
    const s = current();
    if (!editable || !s || s.matches.length === 0) return;
    // One transaction: one change to sync, one step to undo.
    editor.transact((tr) => {
      replaceAllMatches(tr, s.matches, replacement);
      tr.setMeta(findKey, { reveal: true } satisfies FindMeta);
    });
  }

  // The latest handlers, for the document-wide shortcut listener below.
  const handlers = useRef({ openBar, step, open });
  useEffect(() => {
    handlers.current = { openBar, step, open };
  });

  useEffect(() => {
    let lastPointer: EventTarget | null = null;
    const onPointer = (e: PointerEvent) => {
      lastPointer = e.target;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(isMac() ? e.metaKey : e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "f" && key !== "g") return;
      const scope = rootRef.current?.closest("[data-find-scope]");
      // Focus inside the page, or a click there when nothing took focus.
      const active = document.activeElement;
      const target = active && active !== document.body ? active : lastPointer;
      if (!scope || !(target instanceof Node) || !scope.contains(target)) return;
      if (key === "g") {
        if (!handlers.current.open) return;
        e.preventDefault();
        handlers.current.step(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.shiftKey) return;
      e.preventDefault();
      handlers.current.openBar();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  function onFindKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function onReplaceKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) replaceAll();
      else replaceCurrent();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  const count = state?.query ? state.matches.length : 0;
  const counter = !query ? "" : count === 0 ? t("noResults") : `${state!.current + 1}/${count}`;

  return (
    // Zero height, so the bar floats over the editor without pushing the text down.
    <div ref={rootRef} className="sticky top-12 z-10 h-0">
      {open && (
        <div
          role="search"
          aria-label={t("label")}
          className="absolute top-0 right-4 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-1 rounded-md border border-border bg-bg p-1 shadow-lg md:right-[54px]"
        >
          <div className="flex items-center gap-0.5">
            {editable && (
              <IconButton
                label={replaceOpen ? t("hideReplace") : t("showReplace")}
                aria-expanded={replaceOpen}
                className="h-7 w-6"
                onClick={() => setReplaceOpen((v) => !v)}
              >
                {replaceOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </IconButton>
            )}
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFindKey}
              placeholder={t("placeholder")}
              aria-label={t("placeholder")}
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent"
            />
            <span aria-live="polite" className={cn("w-16 shrink-0 truncate px-1 text-right text-xs tabular-nums", count === 0 ? "text-fg-faint" : "text-fg-muted")}>
              {counter}
            </span>
            <IconButton
              label={t("matchCase")}
              aria-pressed={caseSensitive}
              className={cn("h-7 w-7", caseSensitive && "bg-bg-active text-fg")}
              onClick={() => setCaseSensitive((v) => !v)}
            >
              <CaseSensitive className="h-4 w-4" />
            </IconButton>
            <IconButton label={t("previous")} className="h-7 w-7 disabled:pointer-events-none disabled:opacity-40" disabled={count === 0} onClick={() => step(-1)}>
              <ChevronUp className="h-4 w-4" />
            </IconButton>
            <IconButton label={t("next")} className="h-7 w-7 disabled:pointer-events-none disabled:opacity-40" disabled={count === 0} onClick={() => step(1)}>
              <ChevronDown className="h-4 w-4" />
            </IconButton>
            <IconButton label={t("close")} className="h-7 w-7" onClick={close}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          {canReplace && (
            <div className="flex items-center gap-1 pl-6.5">
              <input
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={onReplaceKey}
                placeholder={t("replacePlaceholder")}
                aria-label={t("replacePlaceholder")}
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent"
              />
              <Button size="sm" variant="ghost" disabled={count === 0} onClick={replaceCurrent}>
                {t("replace")}
              </Button>
              <Button size="sm" variant="ghost" disabled={count === 0} onClick={replaceAll}>
                {t("replaceAll")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
