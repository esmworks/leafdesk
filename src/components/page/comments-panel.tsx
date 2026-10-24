"use client";

import { CommentsExtension, type ThreadData } from "@blocknote/core/comments";
import { Thread, useBlockNoteEditor, useExtension, useExtensionState, useThreads } from "@blocknote/react";
import { ArrowDownUp, Bell, BellOff, Bookmark, BookmarkX, Check, MoreHorizontal, Undo2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent } from "react";
import {
  answerSuggestionsAction,
  markThreadAction,
  muteThreadAction,
  mutedThreadsAction,
  seeThreadsAction,
  threadStatesAction,
} from "@/app/actions/comments";
import { Button, cn, IconButton, MenuItem, Popover } from "@/components/ui";
import { isPageThread, mergedFromOf, suggestionOfThread, threadOfHash } from "@/lib/comments";
import { isAiSuggestion, suggestionAuthor, type Decision } from "@/lib/suggestions";
import { lastActivity, newThreadIds } from "@/lib/thread-activity";

const FILTERS = ["open", "resolved", "marked", "all"] as const;
type Filter = (typeof FILTERS)[number];
const SORTS = ["recent", "page"] as const;
type Sort = (typeof SORTS)[number];

/**
 * Who answers suggested edits here: people who may edit accept or reject them, their author
 * withdraws their own (server/suggested-edits.ts).
 */
export type SuggestionAnswers = { userId: string; canAnswer: boolean; offline: boolean };

/**
 * All of the page's discussions beside the editor: its comment threads on text and about the whole
 * page, newest activity first (or in the order of the text they're about), each marked when others
 * wrote in it since the viewer last saw it. Each person can mark threads to come back to later and
 * list just those. Rendered inside BlockNoteView, whose editor the threads belong to.
 */
export function CommentsPanel({ pageId, onClose, answers }: { pageId: string; onClose: () => void; answers: SuggestionAnswers }) {
  const t = useTranslations("page.comments");
  const [filter, setFilter] = useState<Filter>("open");
  const [sort, setSort] = useState<Sort>("recent");

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
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        <h2 className="flex-1 text-sm font-semibold">{t("title")}</h2>
        <Popover
          align="end"
          className="w-52"
          trigger={({ toggle }) => (
            <IconButton label={t("sort.label")} title={t(`sort.${sort}`)} className="h-7 w-7 text-fg-muted" onClick={toggle}>
              <ArrowDownUp className="h-4 w-4" />
            </IconButton>
          )}
        >
          {(close) =>
            SORTS.map((s) => (
              <MenuItem
                key={s}
                pressed={sort === s}
                trailing={sort === s ? <Check className="h-4 w-4" /> : undefined}
                onClick={() => {
                  close();
                  setSort(s);
                }}
              >
                {t(`sort.${s}`)}
              </MenuItem>
            ))
          }
        </Popover>
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
        <Threads pageId={pageId} filter={filter} sort={sort} onFilter={setFilter} answers={answers} />
        <p className="comments-empty px-1 py-6 text-center text-sm text-fg-faint">{t(`empty.${filter}`)}</p>
      </div>
    </aside>
  );
}

/**
 * The threads of the filter, newest activity first or in the order of the text they're about
 * (threads about the whole page, as agents write, first). Each says what it is about: a few words
 * of its text, the page, or that its text was deleted. (BlockNote's own sidebar can't tell a thread
 * about the page from one whose text is gone.)
 */
function Threads({
  pageId,
  filter,
  sort,
  onFilter,
  answers,
}: {
  pageId: string;
  filter: Filter;
  sort: Sort;
  onFilter: (filter: Filter) => void;
  answers: SuggestionAnswers;
}) {
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

  // The viewer's marks and when they last saw each thread, read once as the panel opens: what is
  // new stays marked while it is open, though the server now counts everything listed as seen.
  // Selecting a thread here sees it (and takes its mark of new away).
  const [viewer, setViewer] = useState<{ id: string; seen: Record<string, string> } | null>(null);
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set());
  const [seenNow, setSeenNow] = useState<Record<string, string>>({});
  const told = useRef(false);
  useEffect(() => {
    let current = true;
    setViewer(null);
    told.current = false;
    threadStatesAction(pageId).then(
      (states) => {
        if (!current) return;
        setViewer({ id: states.viewerId, seen: states.seen });
        setMarked(new Set(states.marked));
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [pageId]);
  useEffect(() => {
    if (!viewer || told.current || !threads.size) return;
    told.current = true;
    seeThreadsAction(pageId, [...threads.keys()]).catch(() => {});
  }, [viewer, threads, pageId]);
  useEffect(() => {
    if (!selectedThreadId || !viewer) return;
    setSeenNow((prev) => ({ ...prev, [selectedThreadId]: new Date().toISOString() }));
    seeThreadsAction(pageId, [selectedThreadId]).catch(() => {});
  }, [selectedThreadId, viewer, pageId]);
  const fresh = useMemo(
    () => (viewer ? newThreadIds([...threads.values()], viewer.id, { ...viewer.seen, ...seenNow }) : new Set<string>()),
    [viewer, threads, seenNow],
  );
  const onMark = useCallback(
    async (threadId: string, mark: boolean) => {
      const set = (on: boolean) =>
        setMarked((prev) => {
          const next = new Set(prev);
          if (on) next.add(threadId);
          else next.delete(threadId);
          return next;
        });
      set(mark);
      try {
        await markThreadAction(pageId, threadId, mark);
      } catch {
        set(!mark);
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
    if ((thread.resolved && filter === "open") || (!thread.resolved && filter === "resolved") || (filter === "marked" && !marked.has(linked))) onFilter("all");
    comments.selectThread(linked);
    requestAnimationFrame(() =>
      document.querySelector(".comments-panel .bn-thread.selected")?.scrollIntoView({ block: "nearest" }),
    );
  }, [linked, threads, positions, waited, filter, onFilter, comments, marked]);

  const shown = useMemo(() => {
    const at = (thread: ThreadData) => (isPageThread(thread.metadata) ? -1 : (positions.get(thread.id)?.from ?? Number.MAX_VALUE));
    return [...threads.values()]
      .filter((thread) =>
        filter === "marked" ? marked.has(thread.id) : thread.resolved ? filter !== "open" : filter !== "resolved",
      )
      .sort(sort === "page" ? (a, b) => at(a) - at(b) : (a, b) => lastActivity(b) - lastActivity(a))
      .map((thread) => {
        const position = positions.get(thread.id);
        let referenceText: string;
        const mergedFrom = mergedFromOf(thread.metadata);
        // About a merged row as a whole: named after that row, the comments came with it.
        if (isPageThread(thread.metadata)) referenceText = mergedFrom !== null ? t("mergedFrom", { title: mergedFrom }) : t("aboutPage");
        else if (!position) referenceText = deleted;
        else {
          const text = editor.transact((tr) => (tr.doc.nodeSize < position.to ? "" : tr.doc.textBetween(position.from, position.to)));
          referenceText = text.length > 15 ? `${text.slice(0, 15)}…` : text;
        }
        return { thread, referenceText, orphaned: !position && !isPageThread(thread.metadata) };
      });
  }, [threads, positions, filter, sort, marked, editor, deleted, t]);

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
          marked={marked.has(thread.id)}
          onMark={onMark}
          isNew={fresh.has(thread.id)}
          pageId={pageId}
          answers={answers}
        />
      ))}
    </div>
  );
}

/**
 * One thread of the list; focusing it selects it (and scrolls the page to its text, highlighted),
 * as in BlockNote's sidebar. Its menu mutes the replies in it and marks it to come back to later,
 * which show beside the menu while they last, as does that it is new to the viewer.
 */
const SidebarThread = memo(function SidebarThread({
  thread,
  selected,
  referenceText,
  orphaned,
  muted,
  onMute,
  marked,
  onMark,
  isNew,
  pageId,
  answers,
}: {
  pageId: string;
  answers: SuggestionAnswers;
  thread: ThreadData;
  selected: boolean;
  referenceText: string;
  orphaned: boolean;
  muted: boolean;
  onMute: (threadId: string, mute: boolean) => Promise<void>;
  marked: boolean;
  onMark: (threadId: string, mark: boolean) => Promise<void>;
  isNew: boolean;
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
  // Room at the end of the thread's first line for what shows there (see .comments-thread in globals.css).
  const tools = { "--thread-tools": `${1.75 + (muted ? 1.5 : 0) + (marked ? 1.5 : 0) + (isNew ? 2.75 : 0)}rem` } as CSSProperties;
  return (
    <div className="comments-thread relative" style={tools}>
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
      <SuggestionBar thread={thread} pageId={pageId} answers={answers} />
      <div className="absolute top-1.5 inset-e-1.5 flex items-center gap-0.5">
        {isNew && (
          <span className="flex h-6 items-center gap-1 px-1 text-xs font-medium text-accent">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            {t("new")}
          </span>
        )}
        {marked && (
          <span role="img" aria-label={t("marked")} title={t("markedHint")} className="flex h-6 w-6 items-center justify-center text-accent">
            <Bookmark className="h-3.5 w-3.5 fill-current" />
          </span>
        )}
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
            <>
              <MenuItem
                icon={marked ? <BookmarkX className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
                title={t(marked ? "unmarkHint" : "markHint")}
                onClick={() => {
                  close();
                  void onMark(thread.id, !marked);
                }}
              >
                {t(marked ? "unmark" : "mark")}
              </MenuItem>
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
            </>
          )}
        </Popover>
      </div>
    </div>
  );
});

/**
 * Under the thread of a suggested edit: that it is one (by the AI, when it is), and while it waits,
 * Accept and Reject for people who may edit, Withdraw for its author. The page changes for everyone
 * through its document, and the server resolves the thread.
 */
function SuggestionBar({ thread, pageId, answers }: { thread: ThreadData; pageId: string; answers: SuggestionAnswers }) {
  const t = useTranslations("page.comments.suggestion");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = suggestionOfThread(thread.metadata);
  if (!id) return null;
  const own = suggestionAuthor(id) === answers.userId;
  const answer = async (decision: Decision) => {
    setPending(true);
    setError(null);
    try {
      const result = await answerSuggestionsAction(pageId, decision, [id]);
      if (!result.ok) setError(t(`errors.${result.code}`));
    } catch {
      setError(t("errors.failed"));
    } finally {
      setPending(false);
    }
  };
  const waiting = !thread.resolved;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 text-xs">
      <span className="me-auto text-fg-muted">{isAiSuggestion(id) ? t("byAi") : t("label")}</span>
      {waiting && answers.canAnswer && (
        <>
          <Button size="sm" variant="primary" disabled={pending || answers.offline} onClick={() => void answer("accept")}>
            <Check className="h-3.5 w-3.5" />
            {t("accept")}
          </Button>
          <Button size="sm" disabled={pending || answers.offline} onClick={() => void answer("reject")}>
            <X className="h-3.5 w-3.5" />
            {t("reject")}
          </Button>
        </>
      )}
      {waiting && !answers.canAnswer && own && (
        <Button size="sm" disabled={pending || answers.offline} onClick={() => void answer("reject")}>
          <Undo2 className="h-3.5 w-3.5" />
          {t("withdraw")}
        </Button>
      )}
      {error && (
        <p role="alert" className="w-full text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
