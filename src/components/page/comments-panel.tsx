"use client";

import { CommentsExtension, type ThreadData } from "@blocknote/core/comments";
import { Thread, useBlockNoteEditor, useExtension, useExtensionState, useThreads } from "@blocknote/react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useState, type FocusEvent } from "react";
import { cn, IconButton } from "@/components/ui";
import { isPageThread } from "@/lib/comments";

const FILTERS = ["open", "resolved", "all"] as const;
type Filter = (typeof FILTERS)[number];

/**
 * The page's comment threads beside the editor, in the order of the text they're about. Rendered
 * inside BlockNoteView, whose editor the threads belong to.
 */
export function CommentsPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslations("page.comments");
  const [filter, setFilter] = useState<Filter>("open");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      aria-label={t("title")}
      className="comments-panel fixed top-11 right-0 bottom-0 z-30 flex w-full flex-col border-l border-border bg-bg md:w-[360px]"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-3">
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <IconButton label={t("close")} className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <nav className="flex shrink-0 gap-1 border-b border-border px-3">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "-mb-px border-b-2 px-2 py-1.5 text-sm",
              filter === f ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            {t(`filters.${f}`)}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <Threads filter={filter} />
        <p className="comments-empty px-1 py-6 text-center text-sm text-fg-faint">{t(`empty.${filter}`)}</p>
      </div>
    </aside>
  );
}

/**
 * The threads of the filter, in the order of the text they're about; threads about the whole page
 * (as agents write) first. Each says what it is about: a few words of its text, the page, or that
 * its text was deleted. (BlockNote's own sidebar can't tell a thread about the page from one whose
 * text is gone.)
 */
function Threads({ filter }: { filter: Filter }) {
  const t = useTranslations("page.comments");
  const editor = useBlockNoteEditor();
  const threads = useThreads();
  const positions = useExtensionState(CommentsExtension, { selector: (state) => state.threadPositions });
  const selectedThreadId = useExtensionState(CommentsExtension, { selector: (state) => state.selectedThreadId });
  const deleted = editor.dictionary.comments.deleted_reference_text;

  const shown = useMemo(() => {
    const at = (thread: ThreadData) => (isPageThread(thread.metadata) ? -1 : (positions.get(thread.id)?.from ?? Number.MAX_VALUE));
    return [...threads.values()]
      .filter((thread) => (thread.resolved ? filter !== "open" : filter !== "resolved"))
      .sort((a, b) => at(a) - at(b))
      .map((thread) => {
        const position = positions.get(thread.id);
        let referenceText: string;
        if (isPageThread(thread.metadata)) referenceText = t("aboutPage");
        else if (!position) referenceText = deleted;
        else {
          const text = editor.transact((tr) => (tr.doc.nodeSize < position.to ? "" : tr.doc.textBetween(position.from, position.to)));
          referenceText = text.length > 15 ? `${text.slice(0, 15)}…` : text;
        }
        return { thread, referenceText, orphaned: !position && !isPageThread(thread.metadata) };
      });
  }, [threads, positions, filter, editor, deleted, t]);

  return (
    <div className="bn-threads-sidebar">
      {shown.map(({ thread, referenceText, orphaned }) => (
        <SidebarThread key={thread.id} thread={thread} selected={thread.id === selectedThreadId} referenceText={referenceText} orphaned={orphaned} />
      ))}
    </div>
  );
}

/** One thread of the list; focusing it selects it (and its text in the page), as in BlockNote's sidebar. */
const SidebarThread = memo(function SidebarThread({
  thread,
  selected,
  referenceText,
  orphaned,
}: {
  thread: ThreadData;
  selected: boolean;
  referenceText: string;
  orphaned: boolean;
}) {
  const comments = useExtension(CommentsExtension);
  const onFocus = useCallback(
    (event: FocusEvent) => {
      if ((event.target as Element).closest(".bn-action-toolbar")) return;
      comments.selectThread(thread.id);
    },
    [comments, thread.id],
  );
  const onBlur = useCallback(
    (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (!next || (next as Element).closest(".bn-action-toolbar")) return;
      const from = event.target instanceof Node ? event.target : null;
      const into = next instanceof Element ? next.closest(".bn-thread") : null;
      if (!from || !into || !into.contains(from)) comments.selectThread(undefined);
    },
    [comments],
  );
  return (
    <Thread
      thread={thread}
      selected={selected}
      orphaned={orphaned}
      referenceText={referenceText}
      maxCommentsBeforeCollapse={5}
      onFocus={onFocus}
      onBlur={onBlur}
      tabIndex={0}
    />
  );
});
