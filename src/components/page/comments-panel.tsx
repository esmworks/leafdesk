"use client";

import { CommentsExtension, type ThreadData } from "@blocknote/core/comments";
import { Thread, useBlockNoteEditor, useExtension, useExtensionState, useThreads } from "@blocknote/react";
import { Bell, BellOff, MoreHorizontal, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useState, type FocusEvent } from "react";
import { muteThreadAction, mutedThreadsAction } from "@/app/actions/comments";
import { cn, IconButton, MenuItem, Popover } from "@/components/ui";
import { isPageThread, threadOfHash } from "@/lib/comments";

const FILTERS = ["open", "resolved", "all"] as const;
type Filter = (typeof FILTERS)[number];

/**
 * The page's comment threads beside the editor, in the order of the text they're about. Rendered
 * inside BlockNoteView, whose editor the threads belong to.
 */
export function CommentsPanel({ pageId, onClose }: { pageId: string; onClose: () => void }) {
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
      // Beside the row panel when the page is in one (it sets --comments-right to its width).
      className="comments-panel fixed top-11 inset-e-0 bottom-0 z-30 flex w-full flex-col border-s border-border bg-bg md:inset-e-[var(--comments-right,0px)] md:w-[360px]"
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
        <Threads pageId={pageId} filter={filter} onFilter={setFilter} />
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
function Threads({ pageId, filter, onFilter }: { pageId: string; filter: Filter; onFilter: (filter: Filter) => void }) {
  const t = useTranslations("page.comments");
  const editor = useBlockNoteEditor();
  const comments = useExtension(CommentsExtension);
  const threads = useThreads();
  const positions = useExtensionState(CommentsExtension, { selector: (state) => state.threadPositions });
  const selectedThreadId = useExtensionState(CommentsExtension, { selector: (state) => state.selectedThreadId });
  const deleted = editor.dictionary.comments.deleted_reference_text;

  // The threads whose replies the viewer muted. Read again as the threads change: posting in one,
  // or being mentioned there, unmutes it (see server/thread-mute).
  const [muted, setMuted] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let current = true;
    mutedThreadsAction(pageId).then(
      (ids) => current && setMuted(new Set(ids)),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [pageId, threads]);
  const onMute = useCallback(
    async (threadId: string, mute: boolean) => {
      const set = (on: boolean) =>
        setMuted((prev) => {
          const next = new Set(prev);
          if (on) next.add(threadId);
          else next.delete(threadId);
          return next;
        });
      set(mute);
      try {
        await muteThreadAction(pageId, threadId, mute);
      } catch {
        set(!mute);
      }
    },
    [pageId],
  );

  // The thread a link names (`#comment-<id>`): selected once it has loaded, after its text has
  // (so the page scrolls there), or a moment later for a thread whose text is gone. A resolved one
  // shows under all threads. One that was deleted leaves just the panel open.
  const [linked, setLinked] = useState<string | undefined>();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const fromHash = () => {
      setLinked(threadOfHash(window.location.hash));
      setWaited(false);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  useEffect(() => {
    if (!linked) return;
    const timer = setTimeout(() => setWaited(true), 3_000);
    return () => clearTimeout(timer);
  }, [linked]);
  useEffect(() => {
    const thread = linked ? threads.get(linked) : undefined;
    if (!linked || !thread || !(positions.has(linked) || isPageThread(thread.metadata) || waited)) return;
    setLinked(undefined);
    if (thread.resolved && filter === "open") onFilter("all");
    comments.selectThread(linked);
    requestAnimationFrame(() =>
      document.querySelector(".comments-panel .bn-thread.selected")?.scrollIntoView({ block: "nearest" }),
    );
  }, [linked, threads, positions, waited, filter, onFilter, comments]);

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
        <SidebarThread
          key={thread.id}
          thread={thread}
          selected={thread.id === selectedThreadId}
          referenceText={referenceText}
          orphaned={orphaned}
          muted={muted.has(thread.id)}
          onMute={onMute}
        />
      ))}
    </div>
  );
}

/**
 * One thread of the list; focusing it selects it (and its text in the page), as in BlockNote's
 * sidebar. Its menu mutes the replies in it, which shows beside the menu while it lasts.
 */
const SidebarThread = memo(function SidebarThread({
  thread,
  selected,
  referenceText,
  orphaned,
  muted,
  onMute,
}: {
  thread: ThreadData;
  selected: boolean;
  referenceText: string;
  orphaned: boolean;
  muted: boolean;
  onMute: (threadId: string, mute: boolean) => Promise<void>;
}) {
  const t = useTranslations("page.comments");
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
    <div className="comments-thread relative">
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
      <div className="absolute top-1.5 inset-e-1.5 flex items-center gap-0.5">
        {muted && (
          <span role="img" aria-label={t("muted")} title={t("mutedHint")} className="flex h-6 w-6 items-center justify-center text-fg-faint">
            <BellOff className="h-3.5 w-3.5" />
          </span>
        )}
        <Popover
          align="end"
          className="w-56"
          trigger={({ toggle }) => (
            <IconButton label={t("threadMenu")} className="h-6 w-6 text-fg-muted" onClick={toggle}>
              <MoreHorizontal className="h-4 w-4" />
            </IconButton>
          )}
        >
          {(close) => (
            <MenuItem
              icon={muted ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
              title={t(muted ? "unmuteHint" : "muteHint")}
              onClick={() => {
                close();
                void onMute(thread.id, !muted);
              }}
            >
              {t(muted ? "unmute" : "mute")}
            </MenuItem>
          )}
        </Popover>
      </div>
    </div>
  );
});
