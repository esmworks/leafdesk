"use client";

import { useEditorChange } from "@blocknote/react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui";
import { openCollapsedAncestors } from "./block-focus";
import type { PageEditor } from "./embed-blocks";
import { currentHeading, headingsOfDoc, sameHeadings, type OutlineHeading } from "./page-outline";

/**
 * The page's floating outline: a short line per heading at the page's end edge, the one being read
 * darker; hovering the lines (or focusing them) lists the headings, and a click scrolls there. Drawn
 * into the place page-view.tsx keeps for it, which hides it on narrow screens, beside panels and in
 * print, and only for pages with two headings or more.
 *
 * Kept cheap: the headings are read from the editor's ProseMirror document a moment after typing
 * stops, and the scroll position is read once a frame at most, only while it is shown.
 */

/** How long typing must pause before the headings are read again. */
const READ_AFTER_MS = 300;
/** Where reading happens: a heading above this far from the top of the window is the current one. */
const READING_LINE = 140;

export default function FloatingOutline({ editor, slot }: { editor: PageEditor; slot: HTMLElement }) {
  const t = useTranslations("page.blocks.toc");
  const tc = useTranslations("common");
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readSoon = (delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const next = headingsOfDoc(editor.prosemirrorState.doc);
      setHeadings((current) => (sameHeadings(current, next) ? current : next));
    }, delay);
  };
  useEditorChange(() => readSoon(READ_AFTER_MS), editor);
  // First once the editor shows the document: this may mount before the editor's view does.
  useEffect(() => {
    readSoon(0);
    return () => void (timer.current && clearTimeout(timer.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  const shown = headings.length >= 2;
  const elementOf = (key: string) => editor.domElement?.querySelector<HTMLElement>(`[data-node-type="blockOuter"][data-id="${CSS.escape(key)}"]`) ?? null;

  useEffect(() => {
    if (!shown) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const root = editor.domElement;
      const tops = headings.map((h) => {
        const element = root?.querySelector(`[data-node-type="blockOuter"][data-id="${CSS.escape(h.key)}"]`);
        const rect = element?.getBoundingClientRect();
        // A heading in a collapsed toggle has no box.
        return rect && rect.height > 0 ? rect.top : null;
      });
      setActive(currentHeading(tops, READING_LINE));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [shown, headings, editor]);

  if (!shown) return null;
  const top = Math.min(...headings.map((h) => h.level));
  const go = (key: string) => {
    const element = elementOf(key);
    if (!element) return;
    openCollapsedAncestors(element);
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return createPortal(
    <nav aria-label={t("label")} className="group/outline pointer-events-auto absolute end-3 top-[18vh] flex flex-col items-end">
      {/* The lines: focusable as one, so the list opens from the keyboard too. */}
      <button
        type="button"
        aria-label={t("label")}
        className="flex max-h-[60vh] flex-col items-end gap-2 overflow-hidden rounded-md px-1.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {headings.map((h, i) => (
          <span
            key={h.key}
            aria-hidden
            className={cn(
              "block h-0.5 shrink-0 rounded-sm transition-colors",
              ["w-4", "w-3", "w-2"][Math.min(2, h.level - top)],
              i === active ? "bg-fg" : "bg-fg-faint",
            )}
          />
        ))}
      </button>
      <div
        className={cn(
          "absolute end-0 top-0 hidden max-h-[70vh] w-64 overflow-y-auto rounded-lg border border-border bg-bg p-1.5 shadow-lg",
          "group-hover/outline:block group-focus-within/outline:block",
        )}
      >
        <ul className="m-0 flex list-none flex-col p-0">
          {headings.map((h, i) => (
            <li key={h.key} style={{ paddingInlineStart: `${Math.min(2, h.level - top) * 0.75}rem` }}>
              <a
                href={`#block-${h.key}`}
                aria-current={i === active ? "location" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  go(h.key);
                }}
                className={cn(
                  "block truncate rounded px-2 py-1 text-sm no-underline hover:bg-bg-hover",
                  i === active ? "font-medium text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                {h.text || tc("untitled")}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>,
    slot,
  );
}
