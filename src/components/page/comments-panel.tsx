"use client";

import { CommentsExtension, type ThreadData } from "@blocknote/core/comments";
import { Thread, useBlockNoteEditor, useExtension, useExtensionState, useThreads } from "@blocknote/react";
import { ArrowDownUp, Bell, BellOff, Bookmark, BookmarkX, Check, ChevronDown, MoreHorizontal, Undo2, UserRound, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FocusEvent } from "react";
import {
  answerSuggestionsAction,
  markThreadAction,
  muteThreadAction,
  mutedThreadsAction,
  seeThreadsAction,
  threadStatesAction,
} from "@/app/actions/comments";
import { Button, cn, IconButton, MenuItem, Popover, textareaClass } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { isPageThread, mergedFromOf, propertyOf, suggestionOfThread, threadOfHash } from "@/lib/comments";
import { PROPERTY_COMMENT_EVENT, takePropertyCommentRequest, type PropertyCommentRequest } from "@/lib/comments-request";
import { isAiSuggestion, suggestionAuthor, type Decision } from "@/lib/suggestions";
import { hasCommentBy, lastActivity, newThreadIds, threadPeople } from "@/lib/thread-activity";
import { CommentChangeError, propertyNameOf, type ServerThreadStore } from "./comment-store";

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
 * list just those, or list the threads someone wrote in (alongside either list). A database row's
 * threads on its property values show too, named after their property; a property's comment
 * button opens the panel to start one. Rendered inside BlockNoteView, whose editor the threads
 * belong to.
 */
export function CommentsPanel({ pageId, store, onClose, answers }: { pageId: string; store: ServerThreadStore; onClose: () => void; answers: SuggestionAnswers }) {
  const t = useTranslations("page.comments");
  const [filter, setFilter] = useState<Filter>("open");
  const [sort, setSort] = useState<Sort>("recent");
  // The person whose threads are listed, for this page only.
  const [personOf, setPersonOf] = useState<{ pageId: string; userId: string } | null>(null);
  const person = personOf?.pageId === pageId ? personOf.userId : null;
  const setPerson = useCallback((userId: string | null) => setPersonOf(userId ? { pageId, userId } : null), [pageId]);
  // The property a new thread is being written on (a row's property asked for it).
  const [composing, setComposing] = useState<PropertyCommentRequest | null>(null);
  useEffect(() => {
    const fromRequest = () => {
      const property = takePropertyCommentRequest(pageId);
      if (property) setComposing(property);
    };
    fromRequest();
    window.addEventListener(PROPERTY_COMMENT_EVENT, fromRequest);
    return () => window.removeEventListener(PROPERTY_COMMENT_EVENT, fromRequest);
  }, [pageId]);

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
        <PersonFilter viewerId={answers.userId} person={person} onPerson={setPerson} />
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
        {composing && (
          <PropertyComposer
            key={composing.propertyId}
            store={store}
            property={composing}
            onDone={() => {
              setComposing(null);
              setFilter((f) => (f === "open" || f === "all" ? f : "open"));
            }}
          />
        )}
        <Threads pageId={pageId} filter={filter} sort={sort} onFilter={setFilter} person={person} onPerson={setPerson} answers={answers} />
        <p className="comments-empty px-1 py-6 text-center text-sm text-fg-faint">{person ? t("empty.person") : t(`empty.${filter}`)}</p>
      </div>
    </aside>
  );
}

/**
 * Lists only the threads someone wrote in: everyone who wrote a comment still there, the viewer
 * first, then by name. Names come from the editor's store of comment authors (which asks the
 * server for those it doesn't know). Hidden while fewer than two people wrote.
 */
function PersonFilter({ viewerId, person, onPerson }: { viewerId: string; person: string | null; onPerson: (userId: string | null) => void }) {
  const t = useTranslations("page.comments.person");
  const comments = useExtension(CommentsExtension);
  const threads = useThreads();
  const ids = useMemo(() => threadPeople([...threads.values()]), [threads]);
  const store = comments.userStore;
  useEffect(() => {
    const wanted = person && !ids.includes(person) ? [...ids, person] : ids;
    if (wanted.length) void store.loadUsers(wanted);
  }, [store, ids, person]);
  const users = useSyncExternalStore(
    store.store.subscribe,
    () => store.store.state,
    () => store.store.state,
  );
  const nameOf = useCallback((id: string) => users.get(id)?.username || "…", [users]);
  const people = useMemo(
    () => [...ids].sort((a, b) => Number(b === viewerId) - Number(a === viewerId) || nameOf(a).localeCompare(nameOf(b))),
    [ids, viewerId, nameOf],
  );
  if (people.length < 2 && !person) return null;
  const label = (id: string) => (id === viewerId ? t("you", { name: nameOf(id) }) : nameOf(id));
  return (
    <Popover
      align="end"
      className="max-h-80 w-60 overflow-y-auto"
      trigger={({ toggle }) =>
        person ? (
          <button
            type="button"
            onClick={toggle}
            aria-pressed
            aria-label={t("active", { name: nameOf(person) })}
            title={t("active", { name: nameOf(person) })}
            className="inline-flex h-7 max-w-36 items-center gap-1.5 rounded-md bg-bg-hover px-1.5 text-sm text-fg"
          >
            <UserAvatar name={nameOf(person)} image={users.get(person)?.avatarUrl} size="xs" />
            <span className="truncate">{nameOf(person)}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          </button>
        ) : (
          <IconButton label={t("label")} title={t("label")} className="h-7 w-7 text-fg-muted" onClick={toggle}>
            <UserRound className="h-4 w-4" />
          </IconButton>
        )
      }
    >
      {(close) => (
        <>
          <MenuItem
            pressed={person === null}
            trailing={person === null ? <Check className="h-4 w-4" /> : undefined}
            onClick={() => {
              close();
              onPerson(null);
            }}
          >
            {t("everyone")}
          </MenuItem>
          {people.map((id) => (
            <MenuItem
              key={id}
              icon={<UserAvatar name={nameOf(id)} image={users.get(id)?.avatarUrl} size="xs" />}
              pressed={person === id}
              trailing={person === id ? <Check className="h-4 w-4" /> : undefined}
              onClick={() => {
                close();
                onPerson(id);
              }}
            >
              {label(id)}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
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
  person,
  onPerson,
  answers,
}: {
  pageId: string;
  filter: Filter;
  sort: Sort;
  onFilter: (filter: Filter) => void;
  /** Only the threads this person wrote in; null for everyone's. */
  person: string | null;
  onPerson: (userId: string | null) => void;
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
    if (!linked || !thread || !(positions.has(linked) || isPageThread(thread.metadata) || propertyOf(thread.metadata) || waited)) return;
    setLinked(undefined);
    if ((thread.resolved && filter === "open") || (!thread.resolved && filter === "resolved") || (filter === "marked" && !marked.has(linked))) onFilter("all");
    if (person && !hasCommentBy(thread, person)) onPerson(null);
    comments.selectThread(linked);
    requestAnimationFrame(() =>
      document.querySelector(".comments-panel .bn-thread.selected")?.scrollIntoView({ block: "nearest" }),
    );
  }, [linked, threads, positions, waited, filter, onFilter, person, onPerson, comments, marked]);

  const shown = useMemo(() => {
    // Threads about the whole page first, then those on the row's property values, then the text's.
    const at = (thread: ThreadData) =>
      isPageThread(thread.metadata) ? -2 : propertyOf(thread.metadata) ? -1 : (positions.get(thread.id)?.from ?? Number.MAX_VALUE);
    return [...threads.values()]
      .filter((thread) =>
        filter === "marked" ? marked.has(thread.id) : thread.resolved ? filter !== "open" : filter !== "resolved",
      )
      .filter((thread) => !person || hasCommentBy(thread, person))
      .sort(sort === "page" ? (a, b) => at(a) - at(b) : (a, b) => lastActivity(b) - lastActivity(a))
      .map((thread) => {
        const position = positions.get(thread.id);
        let referenceText: string;
        const mergedFrom = mergedFromOf(thread.metadata);
        const property = propertyNameOf(thread.metadata);
        // About a merged row as a whole: named after that row, the comments came with it.
        if (isPageThread(thread.metadata)) referenceText = mergedFrom !== null ? t("mergedFrom", { title: mergedFrom }) : t("aboutPage");
        else if (property !== null) referenceText = t("aboutProperty", { name: property });
        else if (!position) referenceText = deleted;
        else {
          const text = editor.transact((tr) => (tr.doc.nodeSize < position.to ? "" : tr.doc.textBetween(position.from, position.to)));
          referenceText = text.length > 15 ? `${text.slice(0, 15)}…` : text;
        }
        return { thread, referenceText, orphaned: !position && !isPageThread(thread.metadata) && property === null };
      });
  }, [threads, positions, filter, sort, marked, person, editor, deleted, t]);

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
 * A new thread on a row's property value: plain text, a paragraph a line (replies in it then use
 * the thread's own comment box). Once posted the thread shows, selected, in the list below.
 */
function PropertyComposer({ store, property, onDone }: { store: ServerThreadStore; property: PropertyCommentRequest; onDone: () => void }) {
  const t = useTranslations("page.comments");
  const tc = useTranslations("common");
  const comments = useExtension(CommentsExtension);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const thread = await store.createPropertyThread(property.propertyId, text);
      onDone();
      comments.selectThread(thread.id);
    } catch (e) {
      setError(e instanceof CommentChangeError && e.code === "notFound" ? t("propertyGone") : tc("genericError"));
      setBusy(false);
    }
  };
  return (
    <form
      className="mb-3 rounded-md border border-border p-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="property-comment" className="mb-1.5 block text-xs font-medium text-fg-muted">
        {t("onProperty", { name: property.name })}
      </label>
      <textarea
        id="property-comment"
        autoFocus
        rows={3}
        value={text}
        placeholder={t("propertyPlaceholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            // The panel closes on Escape otherwise.
            e.preventDefault();
            onDone();
          }
        }}
        className={textareaClass}
      />
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          {tc("cancel")}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy || !text.trim()}>
          {t("post")}
        </Button>
      </div>
    </form>
  );
}

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
