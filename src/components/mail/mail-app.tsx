"use client";

import { Database, Inbox, Paperclip, RefreshCw, Search, Star } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mailActionAction, refreshMailboxAction } from "@/app/actions/mail";
import { lazyPart } from "@/components/lazy-part";
import { read } from "@/components/read";
import { SelectBox, useSelection } from "@/components/selection";
import { SidebarOpenButton } from "@/components/sidebar/sidebar-context";
import { currentToast, dismissToast, showToast } from "@/components/toast";
import { cn, IconButton } from "@/components/ui";
import { MAIL_MAX_THREADS, MAIL_UNDO_SECONDS, type MailAction, type MailFolderView, type MailThreadItem, type MailUndoneSend } from "@/lib/mail-client";
import type { ComposeMode } from "./compose-start";
import { loadAhead } from "./mail-cache";
import { countUnread, loadMailboxes, mailHref, onCompose, pickOpen, putFolders, putMailbox, useMailboxes, useWhen } from "./mail-store";
import { useFolderName } from "./mail-sidebar";

// The open thread and a new message load the first time they show.
const ThreadView = lazyPart(() => import("./thread-view").then((m) => m.ThreadView), <div className="min-w-0 flex-1" />);
const PaneComposer = lazyPart(() => import("./composer").then((m) => m.PaneComposer), <div className="min-w-0 flex-1" />);
const ThreadMenu = lazyPart(() => import("./thread-menu").then((m) => m.ThreadMenu));
const SelectionBar = lazyPart(() => import("./selection-bar").then((m) => m.SelectionBar), <div className="h-8" />);

/** How often the open folder asks the mail server for new mail while the page is in front. */
const REFRESH_MS = 60_000;
const MOVES: MailAction[] = ["archive", "trash", "junk", "inbox", "move", "delete"];
/** g then one of these opens the mailbox's folder of that role, within GO_MS of the g. */
const GO_KEYS: Record<string, MailFolderView["role"]> = { i: "inbox", s: "sent", d: "drafts", a: "archive", t: "trash" };
const GO_MS = 1500;
/** Messages shown in the list are loaded ahead from the top, at most this many. */
const AHEAD_TOP = 8;
const aheadOf = (item: MailThreadItem) => loadAhead([item.messageId]);

type List = { items: MailThreadItem[]; next: string | null; loading: boolean; error: string | null };

const ThreadRow = memo(function ThreadRow({
  item,
  href,
  selected,
  checked,
  selecting,
  menuOpen,
  me,
  onOpen,
  onSelect,
  onHover,
  onMenu,
}: {
  item: MailThreadItem;
  href: string;
  selected: boolean;
  /** It is among the conversations selected for the selection bar. */
  checked: boolean;
  /** Some conversation is selected: every row shows its box. */
  selecting: boolean;
  /** Its right-click menu is open: it stays marked meanwhile. */
  menuOpen: boolean;
  me: string;
  onOpen: (item: MailThreadItem) => void;
  /** Selects it or takes it out of the selection; `range` from the last one clicked (Shift). */
  onSelect: (item: MailThreadItem, range: boolean) => void;
  onHover: (item: MailThreadItem) => void;
  onMenu: (item: MailThreadItem, at: { x: number; y: number }) => void;
}) {
  const t = useTranslations("mail");
  const when = useWhen();
  const senders = item.senders.map((s) => (s.address === me ? t("me") : s.name?.split(" ")[0] || s.address)).join(", ");
  return (
    <div className="group relative">
      <a
        href={href}
        data-thread={item.threadId}
        aria-current={selected ? "true" : undefined}
        onPointerEnter={() => onHover(item)}
        // Shift-click selects a range, not the text between.
        onMouseDown={(e) => e.shiftKey && e.preventDefault()}
        onClick={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          // Cmd/Ctrl-click and Shift-click select; the menu opens a conversation in a new tab.
          if (e.metaKey || e.ctrlKey || e.shiftKey) onSelect(item, e.shiftKey);
          else onOpen(item);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(item, { x: e.clientX, y: e.clientY });
        }}
        className={cn(
          "relative flex gap-3 border-b border-border px-4 py-2.5 outline-none focus-visible:bg-bg-hover",
          selected ? "bg-bg-active" : menuOpen ? "bg-bg-hover" : "hover:bg-bg-hover",
          checked && "bg-accent/10 hover:bg-accent/15",
        )}
      >
        {/* The unread dot gives way to the selection box (laid over it, outside the link) on hover. */}
        <span
          className={cn(
            "mt-1.5 h-2 w-2 shrink-0 rounded-full",
            item.unread ? "bg-accent" : "bg-transparent",
            selecting || checked ? "opacity-0" : "group-hover:opacity-0 group-has-[input:focus-visible]:opacity-0",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn("truncate text-sm", item.unread && "font-semibold")}>{senders}</span>
            {item.hasDraft && <span className="shrink-0 text-xs font-medium text-danger">{t("draft")}</span>}
            {item.count > 1 && <span className="text-xs text-fg-muted tabular-nums">{item.count}</span>}
            <span className="flex-1" />
            {item.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-fg-icon" aria-label={t("hasFiles")} />}
            {item.starred && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-amber-500" aria-label={t("starred")} />}
            <span className={cn("shrink-0 text-xs tabular-nums", item.unread ? "font-semibold text-fg" : "text-fg-muted")}>{when(item.sentAt)}</span>
          </div>
          <div className={cn("truncate text-sm", item.unread && "font-semibold")}>{item.subject || t("noSubject")}</div>
          {item.preview && <div className="truncate text-sm text-fg-muted">{item.preview}</div>}
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
      {/* A touch screen keeps the dot until a selection starts (the menu's Select). */}
      <span className={cn("absolute top-2 inset-s-2", !selecting && "pointer-coarse:hidden")}>
        <SelectBox
          checked={checked}
          label={t("bulk.selectThread", { subject: item.subject || t("noSubject") })}
          visible={selecting}
          onToggle={(range) => onSelect(item, range)}
        />
      </span>
    </div>
  );
});

/** Elements whose Enter is their own: it presses or follows them. */
const PRESSABLE = "a, button, summary, [role=button], [role=link], [role=menuitem], [role=option], [role=tab]";

/** Whether a key press was typed into a field, or into a dialog. */
const inField = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest("[data-dialog]"));
};

/** Whether a key press is for the page: not typed into a field, nor with a modifier. */
const forPage = (e: KeyboardEvent) => !(e.metaKey || e.ctrlKey || e.altKey) && !inField(e);

/** The Mail page: a folder's threads beside the open one, with search and keyboard shortcuts. */
export function MailApp({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("mail");
  const folderName = useFolderName();
  const search = useSearchParams();
  const { boxes, error: boxesError } = useMailboxes(workspaceId);
  const { box, folder } = pickOpen(boxes, search.get("box"), search.get("f"));
  // A thread is opened soon after the list shows, a right click opens its menu at once, and a
  // selection shows its bar: their code starts loading now.
  useEffect(() => {
    void ThreadView.preload();
    void ThreadMenu.preload();
    void SelectionBar.preload();
  }, []);
  const threadId = search.get("t");
  // A new message is written in the pane where a thread shows (?c=new), so Back closes it; a saved
  // draft is opened there too (?c=d:<id>), and each save moves the address to its new id.
  const composeParam = search.get("c");
  const draftId = composeParam?.startsWith("d:") ? composeParam.slice(2) : null;
  const composing = composeParam === "new" || !!draftId;
  // The pane is written on until it is closed or another one opened: not anew when a save moves the address.
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [pane, setPane] = useState({ c: composeParam, n: 0, draft: draftId });
  if (pane.c !== composeParam) setPane(composeParam && composeParam === savedTo ? { ...pane, c: composeParam } : { c: composeParam, n: pane.n + 1, draft: draftId });
  const query = search.get("q") ?? "";
  const [typed, setTyped] = useState(query);
  const [list, setList] = useState<List>({ items: [], next: null, loading: true, error: null });
  const [compose, setCompose] = useState<ComposeMode | null>(null);
  const [menu, setMenu] = useState<{ item: MailThreadItem; at: { x: number; y: number } } | null>(null);
  const openMenu = useCallback((item: MailThreadItem, at: { x: number; y: number }) => setMenu({ item, at }), []);
  const [refreshing, setRefreshing] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Moves wait MAIL_UNDO_SECONDS for Undo before the mail server hears of them.
  const pending = useRef(new Map<string, { threadIds: string[]; run: () => void; timer: ReturnType<typeof setTimeout> }>());
  // The last move while its Undo still can take it back, for ⌘/Ctrl+Z, and the note offering it.
  const lastUndo = useRef<{ undo: () => void; toast: number | undefined } | null>(null);
  // When g was pressed, for g i, g s, g d, g a and g t.
  const goPressed = useRef(0);
  // What the list shows: an answer or an Undo for another mailbox, folder or search is dropped.
  const shownKey = box && folder ? `${box.id}|${folder.id}|${query}` : null;
  const shown = useRef(shownKey);
  useEffect(() => {
    shown.current = shownKey;
  }, [shownKey]);

  const go = useCallback(
    (open: { box?: string | null; f?: string | null; t?: string | null; q?: string | null; c?: string | null }, replace = false) => {
      const href = mailHref(workspaceId, { box: box?.id, f: folder?.id, t: threadId, q: query || null, ...open });
      // Only the address changes: the page is the same, so the server isn't asked for it again.
      if (replace) window.history.replaceState(null, "", href);
      else window.history.pushState(null, "", href);
    },
    [box?.id, folder?.id, threadId, query, workspaceId],
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
      const skip = new Set([...pending.current.values()].flatMap((p) => p.threadIds));
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
    // loadPage follows box, folder and query; new folder counts (a refresh) leave the list as it is.
  }, [box?.id, !!box?.folders, folder?.id, query]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  }, [go]);
  useEffect(() => onCompose(() => goRef.current({ c: "new" })), []);

  // A send undone opens its draft again in the pane, while Mail is still open; once a message went,
  // the list is read again (the folder open then: the sent folder or the drafts show the change).
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const sendUndone = useCallback((draft: MailUndoneSend) => {
    if (live.current && draft.id) goRef.current({ c: `d:${draft.id}`, t: null });
  }, []);
  const afterSend = useRef<(thread: boolean) => void>(() => {});
  afterSend.current = (thread) => {
    if (thread || folder?.role === "sent" || folder?.role === "drafts") void loadPage(null);
  };
  useEffect(() => setTyped(query), [query]);

  const items = list.items;
  const selected = items.find((i) => i.threadId === threadId) ?? null;
  // Conversations picked for the selection bar: Cmd/Ctrl- or Shift-click, x, their boxes.
  const rows = useMemo(() => items.map((i) => ({ id: i.threadId })), [items]);
  const selection = useSelection(rows);
  const picked = useMemo(() => {
    const ids = new Set(selection.ids);
    return items.filter((i) => ids.has(i.threadId));
  }, [items, selection.ids]);
  // The rows and keys reach the selection through a ref: its functions change on every render.
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  });
  const onSelect = useCallback((item: MailThreadItem, range: boolean) => selectionRef.current.toggle(item.threadId, range), []);

  // The top of the list, and the threads beside the open one, are loaded ahead.
  useEffect(() => loadAhead(items.slice(0, AHEAD_TOP).map((i) => i.messageId)), [items]);
  useEffect(() => {
    const at = items.findIndex((i) => i.threadId === threadId);
    if (at >= 0) loadAhead([items[at + 1], items[at + 2], items[at - 1]].map((i) => i?.messageId));
  }, [items, threadId]);

  const act = useCallback(
    (targets: MailThreadItem[], action: MailAction, to?: MailFolderView) => {
      if (!box || !folder || !targets.length) return;
      const mailboxId = box.id;
      const folderId = folder.id;
      const ids = targets.map((i) => i.threadId);
      const unseen = targets.reduce((n, i) => n + i.unseen, 0);
      const send = () => {
        for (let at = 0; at < ids.length; at += MAIL_MAX_THREADS) {
          void mailActionAction({ mailboxId, folderId, threadIds: ids.slice(at, at + MAIL_MAX_THREADS), action, to: to?.id }).then((result) => {
            if (!result.ok) {
              showToast({ message: result.error });
              void loadPage(null);
              void loadMailboxes(workspaceId);
            }
          });
        }
      };
      const touched = new Set(ids);
      if (!MOVES.includes(action)) {
        const patch = (item: MailThreadItem): Partial<MailThreadItem> =>
          action === "read" ? { unread: false, unseen: 0 } : action === "unread" ? { unread: true, unseen: item.held } : { starred: action === "star" };
        // A search lists threads of every folder: the counts wait for the next refresh then.
        if (!query && action === "read") countUnread(mailboxId, folderId, -unseen);
        if (!query && action === "unread") countUnread(mailboxId, folderId, targets.reduce((n, i) => n + i.held - i.unseen, 0));
        setList((l) => ({ ...l, items: l.items.map((i) => (touched.has(i.threadId) ? { ...i, ...patch(i) } : i)) }));
        if (action === "unread") for (const id of ids) counted.current.delete(id);
        if (action === "unread" && threadId && touched.has(threadId)) go({ t: null });
        return send();
      }
      // Out of the list at once, the open one to the next thread left; to the server after the Undo window.
      if (threadId && touched.has(threadId)) {
        const at = items.findIndex((i) => i.threadId === threadId);
        const left = (i: MailThreadItem) => !touched.has(i.threadId);
        const next = items.slice(at + 1).find(left) ?? items.slice(0, Math.max(at, 0)).findLast(left) ?? null;
        go({ t: next?.threadId ?? null }, true);
      }
      setList((l) => ({ ...l, items: l.items.filter((i) => !touched.has(i.threadId)) }));
      if (!query) countUnread(mailboxId, folderId, -unseen);
      const from = shown.current;
      const key = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.current.delete(key);
        if (lastUndo.current?.undo === undo) lastUndo.current = null;
        send();
      }, MAIL_UNDO_SECONDS * 1000);
      pending.current.set(key, { threadIds: ids, run: send, timer });
      const count = targets.length;
      const done = action as "archive";
      const undo = () => {
        const waiting = pending.current.get(key);
        if (lastUndo.current?.undo === undo) lastUndo.current = null;
        if (!waiting) return;
        clearTimeout(waiting.timer);
        pending.current.delete(key);
        if (!query) countUnread(mailboxId, folderId, unseen);
        if (shown.current === from) setList((l) => ({ ...l, items: [...l.items, ...targets].sort((a, b) => b.sentAt.localeCompare(a.sentAt)) }));
      };
      showToast({
        message:
          count > 1
            ? to
              ? t("bulk.done.move", { count, folder: folderName(to) })
              : t(`bulk.done.${done}`, { count })
            : to
              ? t("done.move", { folder: folderName(to) })
              : t(`done.${done}`),
        undo,
      });
      lastUndo.current = { undo, toast: currentToast()?.id };
    },
    [box, folder, items, threadId, query, go, loadPage, t, workspaceId, folderName],
  );

  const openThread = useCallback(
    (item: MailThreadItem) => {
      setCompose(null);
      // A draft is written on, not read.
      if (folder?.role === "drafts") go({ c: `d:${item.messageId}`, t: null });
      else go({ t: item.threadId, c: null });
    },
    [go, folder?.role],
  );

  /** The pane's draft was saved or thrown away: the address follows it, and the drafts list. */
  const paneSaved = useCallback(
    (id: string | null, open: boolean) => {
      if (id && open) {
        setSavedTo(`d:${id}`);
        go({ c: `d:${id}` }, true);
      }
      if (folder?.role === "drafts") void loadPage(null);
    },
    [go, folder?.role, loadPage],
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

  // Keyboard (listed in lib/shortcuts.ts): c new, / search, j/k next/previous, Enter/o open, x
  // select, ⌘A select all, e archive, # trash, ! junk, s star, u unread, Shift+I read (the
  // selection's, or the open thread's), r/a/f reply/all/forward, Esc back to the list (or out of the
  // selection first), ⌘Z undo the last move, g then i/s/d/a/t a folder.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (composing || menu) return;
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
      if (mod && e.key.toLowerCase() === "a" && items.length && !inField(e)) {
        e.preventDefault();
        if (!selectionRef.current.all) selectionRef.current.toggleAll();
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && lastUndo.current && !inField(e)) {
        e.preventDefault();
        const { undo, toast } = lastUndo.current;
        undo();
        dismissToast(toast);
        return;
      }
      // With a conversation's menu open, keys are the menu's (Escape closes it).
      if (!forPage(e)) return;
      if (Date.now() - goPressed.current < GO_MS) {
        goPressed.current = 0;
        const to = GO_KEYS[e.key] && box?.folders?.find((f) => f.role === GO_KEYS[e.key]);
        if (!to) return;
        e.preventDefault();
        setCompose(null);
        go({ f: to.id, t: null, q: null, c: null });
        return;
      }
      if (e.key === "g") {
        goPressed.current = Date.now();
        e.preventDefault();
        return;
      }
      const at = items.findIndex((i) => i.threadId === threadId || (!!draftId && i.messageId === draftId));
      const current = at >= 0 && threadId ? items[at] : null;
      // The moves and flags are the selection's while there is one.
      const targets = picked.length ? picked : current ? [current] : null;
      const move = (to: number) => {
        const target = items[Math.max(0, Math.min(items.length - 1, to))];
        if (!target) return;
        openThread(target);
        listRef.current?.querySelector(`[data-thread="${CSS.escape(target.threadId)}"]`)?.scrollIntoView({ block: "nearest" });
      };
      // Only keys that do something here are taken from the browser: Enter on a focused button stays its own.
      const keys: Record<string, () => void> = {
        c: () => go({ c: "new" }),
        "/": () => searchBox.current?.focus(),
        j: () => move(at + 1),
        k: () => move(at < 0 ? 0 : at - 1),
      };
      const first = items[0];
      if (!current && first) {
        keys.o = () => openThread(first);
        if (!(e.target as HTMLElement | null)?.closest?.(PRESSABLE)) keys.Enter = keys.o;
      }
      if (targets) {
        const archive = folder?.role === "archive" || folder?.role === "trash" || folder?.role === "junk" ? "inbox" : "archive";
        if (folder?.role !== "junk") keys["!"] = () => act(targets, "junk");
        Object.assign(keys, {
          e: () => act(targets, archive),
          "#": () => act(targets, folder?.role === "trash" ? "delete" : "trash"),
          s: () => act(targets, targets.every((i) => i.starred) ? "unstar" : "star"),
          u: () => act(targets, "unread"),
          I: () => act(targets, "read"),
        });
      }
      if (current) {
        keys.x = () => onSelect(current, false);
        Object.assign(keys, {
          r: () => setCompose("reply"),
          a: () => setCompose("replyAll"),
          f: () => setCompose("forward"),
        });
        // Escape leaves a selection first (useSelection).
        if (!picked.length) keys.Escape = () => go({ t: null });
      }
      const run = keys[e.key];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, picked, threadId, draftId, box?.folders, folder?.role, act, openThread, onSelect, go, composing, menu]);

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
  // A right click on one of several selected conversations is for all of them.
  const menuMany = menu && picked.length > 1 && selection.isSelected(menu.item.threadId) ? picked : null;
  return (
    <div className="flex h-full min-h-0">
      <section className={cn("flex w-full min-w-0 shrink-0 flex-col border-e border-border md:w-[400px]", (threadId || composing) && "hidden md:flex")} aria-label={name}>
        <div className="shrink-0 space-y-2 border-b border-border px-4 pt-3 pb-3">
          {picked.length ? (
            <SelectionBar
              items={picked}
              all={selection.all}
              box={box}
              folder={folder}
              onToggleAll={selection.toggleAll}
              onClear={selection.clear}
              onAction={(action, to) => act(picked, action, to)}
            />
          ) : (
            <div className="flex items-center gap-2">
              <SidebarOpenButton className="-ms-1.5 max-md:-ms-2" />
              <h1 className="truncate text-base font-semibold">{query ? t("results") : name}</h1>
              {!query && folder.unseen > 0 && folder.role !== "trash" && folder.role !== "junk" && <span className="shrink-0 text-xs text-fg-faint">{t("unreadCount", { count: folder.unseen })}</span>}
              <span className="flex-1" />
              <IconButton label={t("refresh")} className="h-8 w-8 text-fg-icon" onClick={() => void refreshAll()} disabled={refreshing}>
                <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              </IconButton>
            </div>
          )}
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
                  selected={item.threadId === threadId || (!!draftId && item.messageId === draftId)}
                  checked={selection.isSelected(item.threadId)}
                  selecting={selection.some}
                  menuOpen={menu?.item.threadId === item.threadId}
                  me={box.address}
                  onOpen={openThread}
                  onSelect={onSelect}
                  onHover={aheadOf}
                  onMenu={openMenu}
                />
              ))}
              {list.loading && <div className="py-3 text-center text-xs text-fg-faint">{t("loading")}</div>}
            </>
          )}
        </div>
        {menu && (
          <ThreadMenu
            key={`${menu.item.threadId}-${menu.at.x}-${menu.at.y}`}
            at={menu.at}
            item={menuMany ? { ...menu.item, unread: menuMany.some((i) => i.unread), starred: menuMany.every((i) => i.starred) } : menu.item}
            many={menuMany?.length ?? 0}
            box={box}
            folder={folder}
            href={mailHref(workspaceId, { box: box.id, f: folder.id, t: menu.item.threadId, q: query || null })}
            onClose={() => setMenu(null)}
            onAction={(action, to) => act(menuMany ?? [menu.item], action, to)}
            onSelect={() => onSelect(menu.item, false)}
            onCompose={(mode) => {
              openThread(menu.item);
              setCompose(mode);
            }}
            onFind={(found) => {
              setTyped(found);
              go({ q: found, t: null });
            }}
          />
        )}
      </section>
      {composing ? (
        <PaneComposer
          key={pane.n}
          id={pane.draft}
          box={box}
          boxes={boxes}
          layout="pane"
          onClose={() => go({ c: null })}
          onSaved={paneSaved}
          onSent={() => go({ c: null })}
          onUndone={sendUndone}
          onDelivered={() => afterSend.current(false)}
        />
      ) : threadId ? (
        <ThreadView
          key={threadId}
          workspaceId={workspaceId}
          box={box}
          folder={folder}
          threadId={threadId}
          first={selected ? { id: selected.messageId, unread: selected.unread } : null}
          starred={!!selected?.starred}
          onAction={(action) => {
            const item = selected ?? { threadId, unread: false, starred: false } as MailThreadItem;
            act([item], action);
          }}
          onBack={() => go({ t: null })}
          onRead={onRead}
          compose={compose}
          onComposeChange={setCompose}
          onUndone={sendUndone}
          onDelivered={() => afterSend.current(true)}
        />
      ) : (
        <div className="hidden min-w-0 flex-1 items-center justify-center text-sm text-fg-faint md:flex">{t("noneOpen")}</div>
      )}
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

