"use client";

import { Hash, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tagSuggestionsAction } from "@/app/actions/tags";
import { cn } from "@/components/ui";
import { openSearch } from "@/lib/search-open";
import { tagKey } from "@/lib/tags";
import type { TagSuggestion } from "@/server/page-tags";
import type { PageEditor } from "./embed-blocks";
import { tagAtCaret } from "./tags";

/**
 * While a `#tag` is typed in the page (components/page/tags.ts tagAtCaret), the tags of the
 * workspace's pages the person can open that start so, on the most pages first, and a way to find
 * the pages carrying the one typed; nothing when no tag starts so. Arrow keys choose, Enter or Tab
 * completes (Enter on a tag typed out in full just goes on to a new line), Escape closes; a space
 * ends the tag and closes it too. It opens only as the tag is typed: moving the caret into one doesn't.
 */
type Typing = { from: number; query: string };

export default function TagMenu({ editor, workspaceId }: { editor: PageEditor; workspaceId: string }) {
  const t = useTranslations("page.tags");
  const [typing, setTyping] = useState<Typing | null>(null);
  // Escape closes the menu of the tag starting there until another one is typed.
  const dismissed = useRef<number | null>(null);
  const [loaded, setLoaded] = useState<TagSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const [, setScrolled] = useState(0);

  useEffect(() => {
    const read = () => {
      const view = editor.prosemirrorView;
      return view?.hasFocus() ? tagAtCaret(view.state) : null;
    };
    const offChange = editor.onChange(() => {
      const found = read();
      if (found?.from !== dismissed.current) dismissed.current = null;
      setTyping(found && found.from !== dismissed.current ? found : null);
    }, false);
    // A move of the caret keeps the menu only while it stays at the end of the same tag.
    const offSelection = editor.onSelectionChange(() => {
      const found = read();
      setTyping((current) => (current && found?.from === current.from ? found : null));
    }, false);
    return () => {
      offChange();
      offSelection();
    };
  }, [editor]);

  const query = typing?.query ?? null;
  useEffect(() => {
    if (query === null) return;
    let live = true;
    const timer = setTimeout(() => {
      tagSuggestionsAction(workspaceId, query).then(
        (found) => live && setLoaded(found),
        () => {},
      );
    }, 100);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, workspaceId]);

  const tags = useMemo(() => {
    if (query === null) return [];
    const wanted = tagKey(query);
    // The tag typed out in full first, then the ones under it or longer.
    const found = loaded.filter((tag) => tag.key.startsWith(wanted));
    return [...found.filter((tag) => tag.key === wanted), ...found.filter((tag) => tag.key !== wanted)];
  }, [query, loaded]);
  // The tags, then "Find pages tagged …".
  const count = tags.length + 1;

  useEffect(() => setActive(0), [query]);

  const complete = useCallback(
    (label: string) => {
      const view = editor.prosemirrorView;
      if (!view || !typing) return;
      const to = view.state.selection.from;
      const after = view.state.doc.textBetween(to, Math.min(to + 1, view.state.selection.$from.end()));
      // Completed: the caret may stay at its end (a space follows already), without the menu again.
      dismissed.current = typing.from;
      view.dispatch(view.state.tr.insertText(`${label}${/\s/.test(after) ? "" : " "}`, typing.from + 1, to));
      view.focus();
      setTyping(null);
    },
    [editor, typing],
  );

  const choose = useCallback(
    (index: number) => {
      const tag = tags[index];
      if (tag) complete(tag.label);
      else if (typing) {
        setTyping(null);
        openSearch(`#${typing.query.replace(/[-/]+$/, "")}`);
      }
    },
    [tags, typing, complete],
  );

  useEffect(() => {
    const dom = editor.domElement;
    if (!typing || !tags.length || !dom) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const tag = tags[active];
      // A tag typed out in full (case and accents aside) needs no completing: Enter is a new line.
      const exact = tag !== undefined && tag.key === tagKey(typing.query);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        setActive((a) => (a + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
      } else if ((event.key === "Tab" && !event.shiftKey) || (event.key === "Enter" && !event.shiftKey && !exact)) {
        choose(active);
      } else if (event.key === "Escape") {
        dismissed.current = typing.from;
        setTyping(null);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    dom.addEventListener("keydown", onKey, true);
    return () => dom.removeEventListener("keydown", onKey, true);
  }, [editor, typing, tags, active, count, choose]);

  // Follows the page as it scrolls.
  useEffect(() => {
    if (!typing) return;
    const onScroll = () => setScrolled((n) => n + 1);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [typing]);

  const view = editor.prosemirrorView;
  if (!typing || !tags.length || !view) return null;
  let at: { left: number; bottom: number };
  try {
    at = view.coordsAtPos(typing.from);
  } catch {
    return null;
  }
  const item = (index: number) =>
    cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm", index === active && "bg-bg-hover");
  return createPortal(
    <div
      role="listbox"
      aria-label={t("label")}
      // Clicks choose without taking the caret out of the page.
      onMouseDown={(event) => event.preventDefault()}
      style={{ left: Math.max(8, Math.min(at.left, window.innerWidth - 296)), top: at.bottom + 6 }}
      className="fixed z-[80] w-72 max-w-[calc(100vw-16px)] rounded-lg border border-border bg-bg p-1 shadow-lg"
    >
      {tags.map((tag, index) => (
        <button key={tag.key} type="button" role="option" aria-selected={index === active} className={item(index)} onMouseMove={() => setActive(index)} onClick={() => choose(index)}>
          <Hash className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{tag.label}</span>
          <span className="shrink-0 text-xs text-fg-muted">{t("pages", { count: tag.pages })}</span>
        </button>
      ))}
      <button
        type="button"
        role="option"
        aria-selected={active === tags.length}
        className={cn(item(tags.length), "text-fg-muted")}
        onMouseMove={() => setActive(tags.length)}
        onClick={() => choose(tags.length)}
      >
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("find", { tag: typing.query.replace(/[-/]+$/, "") })}</span>
      </button>
    </div>,
    document.body,
  );
}
