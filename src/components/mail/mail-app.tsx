"use client";

import { Database, Inbox, Paperclip, RefreshCw, Search, Star } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { mailActionAction, refreshMailboxAction } from "@/app/actions/mail";
import { read } from "@/components/read";
import { SidebarOpenButton } from "@/components/sidebar/sidebar-context";
import { showToast } from "@/components/toast";
import { cn, Dialog, DialogHeader, IconButton } from "@/components/ui";
import { MAIL_UNDO_SECONDS, type MailAction, type MailThreadItem } from "@/lib/mail-client";
import { Composer, type ComposeMode } from "./composer";
import { countUnread, loadMailboxes, mailHref, onCompose, pickOpen, putFolders, putMailbox, useMailboxes } from "./mail-store";
import { useFolderName } from "./mail-sidebar";
import { ThreadView, useWhen } from "./thread-view";

/** How often the open folder asks the mail server for new mail while the page is in front. */
const REFRESH_MS = 60_000;
const MOVES: MailAction[] = ["archive", "trash", "junk", "inbox", "delete"];
const keepOpen = () => {};

type List = { items: MailThreadItem[]; next: string | null; loading: boolean; error: string | null };

const ThreadRow = memo(function ThreadRow({
  item,
  href,
  selected,
  me,
  onOpen,
}: {
  item: MailThreadItem;
  href: string;
  selected: boolean;
  me: string;
  onOpen: (item: MailThreadItem) => void;
}) {
  const t = useTranslations("mail");
  const when = useWhen();
  const senders = item.senders.map((s) => (s.address === me ? t("me") : s.name?.split(" ")[0] || s.address)).join(", ");
  return (
    <a
      href={href}
      data-thread={item.threadId}
      aria-current={selected ? "true" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onOpen(item);
      }}
      className={cn("relative flex gap-3 border-b border-border px-4 py-2.5 outline-none focus-visible:bg-bg-hover", selected ? "bg-bg-active" : "hover:bg-bg-hover")}
    >
      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", item.unread ? "bg-accent" : "bg-transparent")} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn("truncate text-sm", item.unread ? "font-semibold" : "text-fg-muted")}>{senders}</span>
          {item.count > 1 && <span className="text-xs text-fg-faint tabular-nums">{item.count}</span>}
          <span className="flex-1" />
          {item.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-fg-icon" aria-label={t("hasFiles")} />}
          {item.starred && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-amber-500" aria-label={t("starred")} />}
          <span className={cn("shrink-0 text-xs tabular-nums", item.unread ? "text-fg" : "text-fg-faint")}>{when(item.sentAt)}</span>
        </div>
        <div className={cn("truncate text-sm", item.unread ? "text-fg" : "text-fg-muted")}>{item.subject || t("noSubject")}</div>
        {item.preview && <div className="truncate text-sm text-fg-faint">{item.preview}</div>}
        {item.row && (
          <div className="mt-1">
            <span className="inline-flex max-w-48 items-center gap-1 rounded border border-border bg-bg-subtle px-1.5 py-px text-xs text-fg-muted">
              <Database className="h-3 w-3 shrink-0 text-fg-icon" />
              <span className="truncate">{item.row.title || t("untitledRow")}</span>
            </span>
          </div>
        )}
      </div>
    </a>
  );
});

/** Elements whose Enter is their own: it presses or follows them. */
const PRESSABLE = "a, button, summary, [role=button], [role=link], [role=menuitem], [role=option], [role=tab]";

/** Whether a key press is for the page: not typed into a field, nor with a modifier. */
const forPage = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return !(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest("[data-dialog]")));
};

/** The Mail page: a folder's threads beside the open one, with search and keyboard shortcuts. */
export function MailApp({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("mail");
  const folderName = useFolderName();
  const router = useRouter();
  const search = useSearchParams();
  const { boxes, error: boxesError } = useMailboxes(workspaceId);
  const { box, folder } = pickOpen(boxes, search.get("box"), search.get("f"));
  const threadId = search.get("t");
  const query = search.get("q") ?? "";
  const [typed, setTyped] = useState(query);
  const [list, setList] = useState<List>({ items: [], next: null, loading: true, error: null });
  const [compose, setCompose] = useState<ComposeMode | null>(null);
  const [composeNew, setComposeNew] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Moves wait MAIL_UNDO_SECONDS for Undo before the mail server hears of them.
  const pending = useRef(new Map<string, { run: () => void; timer: ReturnType<typeof setTimeout> }>());
  // What the list shows: an answer or an Undo for another mailbox, folder or search is dropped.
  const shownKey = box && folder ? `${box.id}|${folder.id}|${query}` : null;
  const shown = useRef(shownKey);
  useEffect(() => {
    shown.current = shownKey;
  }, [shownKey]);

  const go = useCallback(
    (open: { box?: string | null; f?: string | null; t?: string | null; q?: string | null }, replace = false) => {
      const href = mailHref(workspaceId, { box: box?.id, f: folder?.id, t: threadId, q: query || null, ...open });
      if (replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [box?.id, folder?.id, threadId, query, router, workspaceId],
  );

  // The first open of a mailbox reads its folders and newest mail.
  const opening = useRef<string | null>(null);
  useEffect(() => {
    if (!box || box.folders || opening.current === box.id) return;
    opening.current = box.id;
    const failed = (error: string) => {
      opening.current = null;
      setList({ items: [], next: null, loading: false, error });
    };
    void read("mailOpen", box.id)
      .then((result) => (result.ok ? putMailbox(result.data) : failed(result.error)))
      .catch(() => failed(t("loadFailed")));
  }, [box, t]);

  const loadPage = useCallback(
    async (cursor: string | null) => {
      if (!box || !folder) return;
      const key = `${box.id}|${folder.id}|${query}`;
      const result = await read("mailThreads", { mailboxId: box.id, folderId: folder.id, search: query, cursor }).catch(() => null);
      if (shown.current !== key) return;
      if (!result?.ok) return setList((l) => ({ ...l, loading: false, error: result?.error ?? t("loadFailed") }));
      const skip = new Set(pending.current.keys());
      setList((l) => {
        const fresh = result.data.items.filter((i) => !skip.has(i.threadId));
        if (cursor) return { items: [...l.items, ...fresh.filter((i) => !l.items.some((o) => o.threadId === i.threadId))], next: result.data.next, loading: false, error: null };
        // A refresh of the first page keeps what was loaded further down.
        const last = fresh[fresh.length - 1];
        const older = result.data.next && last ? l.items.filter((o) => o.sentAt < last.sentAt && !fresh.some((i) => i.threadId === o.threadId)) : [];
        return { items: [...fresh, ...older], next: older.length ? l.next : result.data.next, loading: false, error: null };
      });
    },
    [box, folder, query, t],
  );

  useEffect(() => {
    if (!box?.folders || !folder) return;
    setList({ items: [], next: null, loading: true, error: null });
    void loadPage(null);
    // loadPage follows box, folder and query.
  }, [box?.id, box?.folders, folder?.id, query]); // eslint-disable-line react-hooks/exhaustive-deps
  // The timer below reads the list as it is then (a search typed since included).
  const loadLatest = useRef(loadPage);
  useEffect(() => {
    loadLatest.current = loadPage;
  }, [loadPage]);

  // New mail: as the folder opens, then every REFRESH_MS while the page is in front.
  useEffect(() => {
    if (!box?.folders || !folder) return;
    const mailboxId = box.id;
    const folderId = folder.id;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void read("mailRefreshFolder", mailboxId, folderId)
        .then((result) => {
          if (!result.ok) return;
          putFolders(mailboxId, result.data);
          void loadLatest.current(null);
        })
        // Offline: the next check tries again.
        .catch(() => {});
    };
    check();
    const timer = setInterval(check, REFRESH_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [box?.id, !!box?.folders, folder?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // What waits for Undo goes now when the page is left.
  useEffect(() => {
    const flush = () => {
      for (const [id, p] of pending.current) {
        clearTimeout(p.timer);
        p.run();
        pending.current.delete(id);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  useEffect(() => onCompose(() => setComposeNew(true)), []);
  useEffect(() => setTyped(query), [query]);

  const items = list.items;
  const selected = items.find((i) => i.threadId === threadId) ?? null;

  const act = useCallback(
    (item: MailThreadItem, action: MailAction) => {
      if (!box || !folder) return;
      const mailboxId = box.id;
      const folderId = folder.id;
      const send = () =>
        void mailActionAction({ mailboxId, folderId, threadIds: [item.threadId], action }).then((result) => {
          if (!result.ok) {
            showToast({ message: result.error });
            void loadPage(null);
            void loadMailboxes(workspaceId);
          }
        });
      if (!MOVES.includes(action)) {
        const patch: Partial<MailThreadItem> =
          action === "read" ? { unread: false, unseen: 0 } : action === "unread" ? { unread: true, unseen: item.held } : { starred: action === "star" };
        // A search lists threads of every folder: the counts wait for the next refresh then.
        if (!query && action === "read") countUnread(mailboxId, folderId, -item.unseen);
        if (!query && action === "unread") countUnread(mailboxId, folderId, item.held - item.unseen);
        setList((l) => ({ ...l, items: l.items.map((i) => (i.threadId === item.threadId ? { ...i, ...patch } : i)) }));
        if (action === "unread") counted.current.delete(item.threadId);
        if (action === "unread" && threadId === item.threadId) go({ t: null });
        return send();
      }
      // Out of the list at once, to the next thread; to the server after the Undo window.
      const at = items.findIndex((i) => i.threadId === item.threadId);
      const next = items[at + 1] ?? items[at - 1] ?? null;
      setList((l) => ({ ...l, items: l.items.filter((i) => i.threadId !== item.threadId) }));
      if (!query) countUnread(mailboxId, folderId, -item.unseen);
      if (threadId === item.threadId) go({ t: next?.threadId ?? null }, true);
      const from = shown.current;
      const timer = setTimeout(() => {
        pending.current.delete(item.threadId);
        send();
      }, MAIL_UNDO_SECONDS * 1000);
      pending.current.set(item.threadId, { run: send, timer });
      showToast({
        message: t(`done.${action as "archive"}`),
        undo: () => {
          const waiting = pending.current.get(item.threadId);
          if (!waiting) return;
          clearTimeout(waiting.timer);
          pending.current.delete(item.threadId);
          if (!query) countUnread(mailboxId, folderId, item.unseen);
          if (shown.current === from) setList((l) => ({ ...l, items: [...l.items, item].sort((a, b) => b.sentAt.localeCompare(a.sentAt)) }));
        },
      });
    },
    [box, folder, items, threadId, query, go, loadPage, t, workspaceId],
  );

  const openThread = useCallback(
    (item: MailThreadItem) => {
      setCompose(null);
      go({ t: item.threadId });
    },
    [go],
  );

  // Each unread message of the open thread calls onRead as its body comes, often with the callback
  // of an earlier render (the thread view loads once per thread): it reads the list through a ref, and
  // the folder's count goes down once per opening, by all of them.
  const counted = useRef(new Set<string>());
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  }, [items]);
  useEffect(() => counted.current.clear(), [threadId]);
  const onRead = useCallback(() => {
    if (!box || !folder || !threadId || counted.current.has(threadId)) return;
    const item = latest.current.find((i) => i.threadId === threadId);
    if (!item?.unread) return;
    counted.current.add(threadId);
    if (!query) countUnread(box.id, folder.id, -item.unseen);
    setList((l) => ({ ...l, items: l.items.map((i) => (i.threadId === threadId ? { ...i, unread: false, unseen: 0 } : i)) }));
  }, [box, folder, threadId, query]);

  // Keyboard: c new, / search, j/k next/previous, Enter/o open, e archive, # trash, ! junk, s star,
  // u unread, r/a/f reply/all/forward, Esc back to the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!forPage(e) || composeNew) return;
      const at = items.findIndex((i) => i.threadId === threadId);
      const current = at >= 0 ? items[at] : null;
      const move = (to: number) => {
        const target = items[Math.max(0, Math.min(items.length - 1, to))];
        if (!target) return;
        openThread(target);
        listRef.current?.querySelector(`[data-thread="${CSS.escape(target.threadId)}"]`)?.scrollIntoView({ block: "nearest" });
      };
      // Only keys that do something here are taken from the browser: Enter on a focused button stays its own.
      const keys: Record<string, () => void> = {
        c: () => setComposeNew(true),
        "/": () => searchBox.current?.focus(),
        j: () => move(at + 1),
        k: () => move(at < 0 ? 0 : at - 1),
      };
      const first = items[0];
      if (!current && first) {
        keys.o = () => openThread(first);
        if (!(e.target as HTMLElement | null)?.closest?.(PRESSABLE)) keys.Enter = keys.o;
      }
      if (current) {
        const archive = folder?.role === "archive" || folder?.role === "trash" || folder?.role === "junk" ? "inbox" : "archive";
        if (folder?.role !== "junk") keys["!"] = () => act(current, "junk");
        Object.assign(keys, {
          Escape: () => go({ t: null }),
          e: () => act(current, archive),
          "#": () => act(current, folder?.role === "trash" ? "delete" : "trash"),
          s: () => act(current, current.starred ? "unstar" : "star"),
          u: () => act(current, "unread"),
          r: () => setCompose("reply"),
          a: () => setCompose("replyAll"),
          f: () => setCompose("forward"),
        });
      }
      const run = keys[e.key];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, threadId, folder?.role, act, openThread, go, composeNew]);

  // Search as typed, a moment after the last key.
  useEffect(() => {
    if (typed === query) return;
    const timer = setTimeout(() => go({ q: typed.trim() || null, t: null }, true), 350);
    return () => clearTimeout(timer);
  }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshAll() {
    if (!box || refreshing) return;
    setRefreshing(true);
    const result = await refreshMailboxAction(box.id).catch(() => null);
    setRefreshing(false);
    if (result?.ok) {
      putMailbox(result.data);
      void loadPage(null);
    } else if (result) showToast({ message: result.error });
  }

  if (boxesError) return <Notice>{boxesError}</Notice>;
  if (!boxes) return <div className="h-full" aria-busy />;
  if (!box) return null;
  if (!box.folders || !folder) {
    return (
      <Notice>
        <RefreshCw className={cn("mx-auto mb-3 h-5 w-5 text-fg-icon", !list.error && "animate-spin")} />
        <p className="font-medium text-fg">{t("firstRead")}</p>
        <p className="mt-1">{t("firstReadHint")}</p>
        {list.error && <p className="mt-3 text-danger">{list.error}</p>}
      </Notice>
    );
  }

  const name = folderName(folder);
  return (
    <div className="flex h-full min-h-0">
      <section className={cn("flex w-full min-w-0 shrink-0 flex-col border-e border-border md:w-[400px]", threadId && "hidden md:flex")} aria-label={name}>
        <div className="shrink-0 space-y-2 border-b border-border px-4 pt-3 pb-3">
          <div className="flex items-center gap-2">
            <SidebarOpenButton className="-ms-1.5 max-md:-ms-2" />
            <h1 className="truncate text-base font-semibold">{query ? t("results") : name}</h1>
            {!query && folder.unseen > 0 && folder.role !== "trash" && folder.role !== "junk" && <span className="shrink-0 text-xs text-fg-faint">{t("unreadCount", { count: folder.unseen })}</span>}
            <span className="flex-1" />
            <IconButton label={t("refresh")} className="h-8 w-8 text-fg-icon" onClick={() => void refreshAll()} disabled={refreshing}>
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            </IconButton>
          </div>
          <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-bg px-2.5 focus-within:border-accent">
            <Search className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
            <input
              ref={searchBox}
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setTyped("");
                  e.currentTarget.blur();
                }
              }}
              placeholder={t("searchPlaceholder")}
              aria-label={t("search")}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
            />
            {!typed && <kbd className="font-sans text-xs text-fg-faint">/</kbd>}
          </label>
        </div>
        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (list.next && !list.loading && el.scrollTop + el.clientHeight > el.scrollHeight - 400) {
              setList((l) => ({ ...l, loading: true }));
              void loadPage(list.next);
            }
          }}
        >
          {list.error && !items.length ? (
            <Notice>{list.error}</Notice>
          ) : list.loading && !items.length ? (
            <div aria-busy>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="space-y-1.5 border-b border-border px-4 py-3 ps-9">
                  <div className="h-3.5 w-1/3 animate-pulse rounded bg-bg-hover" />
                  <div className="h-3.5 w-3/4 animate-pulse rounded bg-bg-hover" />
                </div>
              ))}
            </div>
          ) : !items.length ? (
            <Notice>
              <Inbox className="mx-auto mb-2 h-5 w-5 text-fg-icon" />
              {query ? t("emptySearch") : t("empty")}
            </Notice>
          ) : (
            <>
              {items.map((item) => (
                <ThreadRow
                  key={item.threadId}
                  item={item}
                  href={mailHref(workspaceId, { box: box.id, f: folder.id, t: item.threadId, q: query || null })}
                  selected={item.threadId === threadId}
                  me={box.address}
                  onOpen={openThread}
                />
              ))}
              {list.loading && <div className="py-3 text-center text-xs text-fg-faint">{t("loading")}</div>}
            </>
          )}
        </div>
      </section>
      {threadId ? (
        <ThreadView
          key={threadId}
          workspaceId={workspaceId}
          box={box}
          folder={folder}
          threadId={threadId}
          starred={!!selected?.starred}
          onAction={(action) => {
            const item = selected ?? { threadId, unread: false, starred: false } as MailThreadItem;
            act(item, action);
          }}
          onBack={() => go({ t: null })}
          onRead={onRead}
          compose={compose}
          onComposeChange={setCompose}
          onSent={() => void loadPage(null)}
        />
      ) : (
        <div className="hidden min-w-0 flex-1 items-center justify-center text-sm text-fg-faint md:flex">{t("noneOpen")}</div>
      )}
      {/* A click beside it or Escape doesn't throw a written message away: Discard and the close button do (Escape closes an empty one, Composer). */}
      <Dialog open={composeNew} onClose={keepOpen} className="max-w-2xl">
        <DialogHeader title={t("composer.newTitle")} onClose={() => setComposeNew(false)} closeLabel={t("composer.discard")} />
        <Composer box={box} mode="new" source={null} className="rounded-none border-0" onCancel={() => setComposeNew(false)} onSent={() => setComposeNew(false)} />
      </Dialog>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="h-0">
        <SidebarOpenButton className="m-2" />
      </div>
      <div className="mx-auto max-w-sm px-6 py-16 text-center text-sm text-fg-muted">{children}</div>
    </>
  );
}

