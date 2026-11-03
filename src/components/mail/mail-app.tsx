"use client";

import { Bot, Clock, Database, Inbox, Paperclip, RefreshCw, Search, Star } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emptyFolderAction, mailActionAction, refreshMailboxAction, removeSenderRuleAction, setSenderRuleAction } from "@/app/actions/mail";
import { lazyPart } from "@/components/lazy-part";
import { read } from "@/components/read";
import { SelectBox, useSelection } from "@/components/selection";
import { SidebarOpenButton } from "@/components/sidebar/sidebar-context";
import { currentToast, dismissToast, showToast } from "@/components/toast";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogTitle, IconButton } from "@/components/ui";
import {
  ALL_INBOXES,
  STARRED,
  MAIL_MAX_THREADS,
  MAIL_UNDO_SECONDS,
  mailQueryMarks,
  snoozableFrom,
  type MailAction,
  type MailAgentDeed,
  type MailFolderView,
  type MailQueryMarks,
  type MailThreadAgent,
  type MailThreadItem,
  type MailUndoneSend,
} from "@/lib/mail-client";
import type { MailSection, SenderRuleKind } from "@/lib/mail-senders";
import { senderDomain } from "@/lib/sender-domain";
import { highlightParts } from "@/lib/search-highlight";
import { GO_MS, goLetter } from "@/lib/shortcuts";
import type { ComposeMode } from "./compose-start";
import { loadAhead } from "./mail-cache";
import { countUnread, loadMailboxes, mailHref, onCompose, pickOpen, putFolders, putMailbox, useMailboxes, useWhen, type MailOpen } from "./mail-store";
import { MailboxMark, useFolderName } from "./mail-sidebar";
import { SenderMark } from "./sender-mark";

// The open thread and a new message load the first time they show.
const ThreadView = lazyPart(() => import("./thread-view").then((m) => m.ThreadView), <div className="min-w-0 flex-1" />);
const PaneComposer = lazyPart(() => import("./composer").then((m) => m.PaneComposer), <div className="min-w-0 flex-1" />);
const ThreadMenu = lazyPart(() => import("./thread-menu").then((m) => m.ThreadMenu));
const SelectionBar = lazyPart(() => import("./selection-bar").then((m) => m.SelectionBar), <div className="h-8" />);
const SnoozePicker = lazyPart(() => import("./snooze-picker").then((m) => m.SnoozePicker));

/** How often the open folder asks the mail server for new mail while the page is in front; less often while the server tells it (mail-live.ts). */
const REFRESH_MS = 60_000;
const LIVE_REFRESH_MS = 5 * 60_000;
const MOVES: MailAction[] = ["archive", "trash", "junk", "inbox", "move", "snooze", "delete"];
/** Moves that leave a conversation in the starred list: to folders it lists. */
const STAYS_STARRED: MailAction[] = ["archive", "inbox", "move"];
/** g then one of these opens the mailbox's folder of that role, within GO_MS of the g. */
const GO_KEYS: Record<string, MailFolderView["role"]> = { i: "inbox", s: "sent", d: "drafts", a: "archive", t: "trash" };
/** Messages shown in the list are loaded ahead from the top, at most this many. */
const AHEAD_TOP = 8;
const aheadOf = (item: MailThreadItem) => loadAhead([item.messageId]);
/** A thread in the list: its id is its mailbox's, and all inboxes list several mailboxes. */
const itemKey = (item: Pick<MailThreadItem, "mailboxId" | "threadId">) => `${item.mailboxId}|${item.threadId}`;

type List = { items: MailThreadItem[]; next: string | null; loading: boolean; error: string | null };

/** When a snooze ends, as the list and its toast say it: "Nov 2, 8:00 AM". */
const untilText = (locale: string, until: Date | string) => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(until));

/** Text with a search's words marked, inside words too, as the mail search finds them. */
/** What an agent's mark names first: the deed that leaves the person most to look at. */
const DEED_ORDER: MailAgentDeed[] = ["drafted", "summarized", "sorted", "read"];

/** An agent that worked on the thread (agents/run.ts marks): its name and what it did most, all of it on hover. */
function AgentMark({ agent }: { agent: MailThreadAgent }) {
  const t = useTranslations("mail.agentMark");
  const did = DEED_ORDER.filter((d) => agent.did.includes(d));
  const all = did.map((d) => t(`did.${d}`)).join(", ");
  return (
    <span
      title={t("title", { name: agent.name, did: all })}
      data-agent-mark={agent.agentId}
      className="inline-flex max-w-56 items-center gap-1 rounded border border-border bg-bg-subtle px-1.5 py-px text-xs text-fg-muted"
    >
      <Bot className="h-3 w-3 shrink-0 text-fg-icon" aria-hidden />
      {/* The name stays whole up to a point; what it did gives way first. */}
      <span className="max-w-32 shrink-0 truncate">{agent.name}</span>
      {did[0] && (
        <span className="min-w-0 truncate" aria-hidden>
          · {t(`did.${did[0]}`)}
        </span>
      )}
      <span className="sr-only">{all}</span>
    </span>
  );
}

function Marked({ text, words }: { text: string; words: string[] | undefined }) {
  if (!words?.length) return text;
  return highlightParts(text, words, { anywhere: true }).map((part, i) =>
    part.match ? (
      <mark key={i} className="rounded-[2px] bg-amber-200/70 text-inherit dark:bg-amber-400/30">
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

const ThreadRow = memo(function ThreadRow({
  item,
  href,
  selected,
  checked,
  selecting,
  menuOpen,
  me,
  mailbox,
  marks,
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
  /** The mailbox it came to, named in all inboxes. */
  mailbox: string | null;
  /** The search's words, marked where it looked for them. */
  marks: MailQueryMarks | null;
  onOpen: (item: MailThreadItem) => void;
  /** Selects it or takes it out of the selection; `range` from the last one clicked (Shift). */
  onSelect: (item: MailThreadItem, range: boolean) => void;
  onHover: (item: MailThreadItem) => void;
  onMenu: (item: MailThreadItem, at: { x: number; y: number }) => void;
}) {
  const t = useTranslations("mail");
  const when = useWhen();
  const locale = useLocale();
  // One sender by their whole name; several by first names.
  const senders = item.senders.map((s) => (s.address === me ? t("me") : (item.senders.length > 1 ? s.name?.split(" ")[0] : s.name) || s.address)).join(", ");
  return (
    <div className="group relative">
      <a
        href={href}
        data-thread={itemKey(item)}
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
            "-me-1 mt-3.5 h-2 w-2 shrink-0 rounded-full",
            item.unread ? "bg-accent" : "bg-transparent",
            selecting || checked ? "opacity-0" : "group-hover:opacity-0 group-has-[input:focus-visible]:opacity-0",
          )}
          aria-hidden
        />
        <SenderMark mark={item.mark} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn("truncate text-sm", item.unread && "font-semibold")}>
              <Marked text={senders} words={marks?.senders} />
            </span>
            {item.hasDraft && <span className="shrink-0 text-xs font-medium text-danger">{t("draft")}</span>}
            {item.count > 1 && <span className="text-xs text-fg-muted tabular-nums">{item.count}</span>}
            <span className="flex-1" />
            {item.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-fg-icon" aria-label={t("hasFiles")} />}
            {item.starred && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-amber-500" aria-label={t("starred")} />}
            {mailbox && (
              <span title={mailbox} className="shrink-0">
                <MailboxMark address={mailbox} className="h-3.5 w-3.5 text-[9px]" />
                <span className="sr-only">{mailbox}</span>
              </span>
            )}
            {item.snoozedUntil ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-muted tabular-nums" title={t("snooze.until", { time: when(item.snoozedUntil, true) })}>
                <Clock className="h-3 w-3 text-fg-icon" aria-hidden />
                {untilText(locale, item.snoozedUntil)}
              </span>
            ) : (
              <span className={cn("shrink-0 text-xs tabular-nums", item.unread ? "font-semibold text-fg" : "text-fg-muted")}>{when(item.sentAt)}</span>
            )}
          </div>
          <div className={cn("truncate text-sm", item.unread && "font-semibold")}>
            {item.subject ? <Marked text={item.subject} words={marks?.subject} /> : t("noSubject")}
          </div>
          {item.preview && (
            <div className="truncate text-sm text-fg-muted">
              <Marked text={item.preview} words={marks?.preview} />
            </div>
          )}
          {(item.row || item.agents.length > 0) && (
            <div className="mt-1 flex min-w-0 flex-wrap gap-1">
              {item.row && (
                <span className="inline-flex max-w-48 items-center gap-1 rounded border border-border bg-bg-subtle px-1.5 py-px text-xs text-fg-muted">
                  <Database className="h-3 w-3 shrink-0 text-fg-icon" />
                  <span className="truncate">{item.row.title || t("untitledRow")}</span>
                </span>
              )}
              {item.agents.map((agent) => (
                <AgentMark key={agent.agentId} agent={agent} />
              ))}
            </div>
          )}
        </div>
      </a>
      {/* A touch screen keeps the dot until a selection starts (the menu's Select). */}
      <span className={cn("absolute top-4 inset-s-2", !selecting && "pointer-coarse:hidden")}>
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
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest?.("[data-dialog]"));
};

/** Whether a key press is for the page: not typed into a field, nor with a modifier. */
const forPage = (e: KeyboardEvent) => !(e.metaKey || e.ctrlKey || e.altKey) && !inField(e);

/** The Mail page: a folder's threads beside the open one, with search and keyboard shortcuts. */
/** `ai`: the workspace has AI on, so threads offer a summary and the composer its writer (server/mail-client/ai.ts). */
export function MailApp({ workspaceId, ai }: { workspaceId: string; ai: boolean }) {
  const t = useTranslations("mail");
  const tc = useTranslations("common");
  const folderName = useFolderName();
  const search = useSearchParams();
  const { boxes, error: boxesError } = useMailboxes(workspaceId);
  const { box, folder, all, starred } = pickOpen(boxes, search.get("box"), search.get("f"));
  // The list's folder in the address: none in all inboxes; the starred are of the mailbox or of all.
  const listFolder = starred ? STARRED : all ? null : (folder?.id ?? null);
  // All inboxes name the open thread's mailbox beside it.
  const openIn = all ? search.get("m") : null;
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
  // An inbox (all inboxes too) without a search shows its Focus, or its Other (?s=other): what
  // machines sent, by the person's sender rules (server/mail-client/senders.ts).
  const section: MailSection | null = folder && !starred && !query && (all || folder.role === "inbox") ? (search.get("s") === "other" ? "other" : "focus") : null;
  // Conversations waiting unread in Other, as Focus's first page last said.
  const [otherUnread, setOtherUnread] = useState(0);
  const marks = useMemo(() => mailQueryMarks(query), [query]);
  const [typed, setTyped] = useState(query);
  const [list, setList] = useState<List>({ items: [], next: null, loading: true, error: null });
  const [compose, setCompose] = useState<ComposeMode | null>(null);
  const [menu, setMenu] = useState<{ item: MailThreadItem; at: { x: number; y: number } } | null>(null);
  const openMenu = useCallback((item: MailThreadItem, at: { x: number; y: number }) => setMenu({ item, at }), []);
  // Snoozing asks until when first: from its button, the right-click menu's point, or b.
  const [snoozing, setSnoozing] = useState<{ targets: MailThreadItem[]; at: { x: number; y: number } | Element } | null>(null);
  const locale = useLocale();
  const [refreshing, setRefreshing] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [emptying, setEmptying] = useState<"ask" | "working" | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Moves wait MAIL_UNDO_SECONDS for Undo before the mail server hears of them.
  const pending = useRef(new Map<string, { keys: string[]; run: () => void; timer: ReturnType<typeof setTimeout> }>());
  // The last move while its Undo still can take it back, for ⌘/Ctrl+Z, and the note offering it.
  const lastUndo = useRef<{ undo: () => void; toast: number | undefined } | null>(null);
  // When g was pressed, for g i, g s, g d, g a and g t.
  const goPressed = useRef(0);
  // What the list shows: an answer or an Undo for another mailbox, folder or search is dropped.
  const listKey = box && folder ? `${all ? ALL_INBOXES : box.id}|${listFolder ?? ""}|${section ?? ""}` : null;
  const shownKey = listKey ? `${listKey}|${query}` : null;
  const shown = useRef(shownKey);
  useEffect(() => {
    shown.current = shownKey;
  }, [shownKey]);

  const go = useCallback(
    (open: MailOpen, replace = false) => {
      const href = mailHref(workspaceId, { box: all ? ALL_INBOXES : box?.id, f: listFolder, s: section, t: threadId, m: openIn, q: query || null, ...open });
      // Only the address changes: the page is the same, so the server isn't asked for it again.
      if (replace) window.history.replaceState(null, "", href);
      else window.history.pushState(null, "", href);
    },
    [all, box?.id, listFolder, section, threadId, openIn, query, workspaceId],
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
      const key = shownKey;
      const result = await read(
        "mailThreads",
        all
          ? { mailboxId: ALL_INBOXES, folderId: starred ? STARRED : "", workspaceId, search: query, cursor, section: section ?? undefined }
          : { mailboxId: box.id, folderId: listFolder ?? folder.id, search: query, cursor, section: section ?? undefined },
      ).catch(() => null);
      if (shown.current !== key) return;
      if (!result?.ok) return setList((l) => ({ ...l, loading: false, error: result?.error ?? t("loadFailed") }));
      if (result.data.otherUnread !== undefined) setOtherUnread(result.data.otherUnread);
      const skip = new Set([...pending.current.values()].flatMap((p) => p.keys));
      setList((l) => {
        const fresh = result.data.items.filter((i) => !skip.has(itemKey(i)));
        const had = new Set(l.items.map(itemKey));
        if (cursor) return { items: [...l.items, ...fresh.filter((i) => !had.has(itemKey(i)))], next: result.data.next, loading: false, error: null };
        // A refresh of the first page keeps what was loaded further down.
        const last = fresh[fresh.length - 1];
        const came = new Set(fresh.map(itemKey));
        const older = result.data.next && last ? l.items.filter((o) => o.sentAt < last.sentAt && !came.has(itemKey(o))) : [];
        return { items: [...fresh, ...older], next: older.length ? l.next : result.data.next, loading: false, error: null };
      });
    },
    [all, starred, box, folder, listFolder, section, shownKey, query, workspaceId, t],
  );

  // All inboxes list the mailboxes read so far: another one read lists it too.
  const inboxes = all ? (boxes ?? []).flatMap((b) => b.folders?.filter((f) => f.role === "inbox").map((f) => ({ mailboxId: b.id, folderId: f.id })) ?? []) : [];
  const inboxesKey = inboxes.map((i) => `${i.mailboxId}|${i.folderId}`).join();
  useEffect(() => {
    if (!box?.folders || !folder) return;
    setList({ items: [], next: null, loading: true, error: null });
    void loadPage(null);
    // loadPage follows box, folder and query; new folder counts (a refresh) leave the list as it is.
  }, [listKey, !!box?.folders, query, inboxesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The timer below reads the list as it is then (a search typed since included).
  const loadLatest = useRef(loadPage);
  useEffect(() => {
    loadLatest.current = loadPage;
  }, [loadPage]);

  // New mail: as the folder opens, as the server tells of it, and every REFRESH_MS while the page is in front.
  const changed = useRef<(mailboxId: string, folderId: string) => void>(() => {});
  useEffect(() => {
    if (!box?.folders || !folder) return;
    const checked = all ? inboxes : [{ mailboxId: box.id, folderId: folder.id }];
    const check = (only?: { mailboxId: string; folderId: string }) => {
      if (document.visibilityState !== "visible") return;
      void Promise.all(
        (only ? [only] : checked).map(({ mailboxId, folderId }) =>
          read("mailRefreshFolder", mailboxId, folderId)
            .then((result) => {
              if (!result.ok) return false;
              putFolders(mailboxId, result.data);
              return true;
            })
            // Offline: the next check tries again.
            .catch(() => false),
        ),
      ).then(
        // A star can change in any folder: the starred list is read again for news of any of its mailboxes.
        (done) => done.some(Boolean) && (!only || checked.some((c) => (starred ? c.mailboxId === only.mailboxId : c.folderId === only.folderId))) && void loadLatest.current(null),
      );
    };
    changed.current = (mailboxId, folderId) => check({ mailboxId, folderId });
    const again = () => check();
    again();
    const timer = setInterval(again, streaming ? LIVE_REFRESH_MS : REFRESH_MS);
    document.addEventListener("visibilitychange", again);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", again);
    };
  }, [listKey, !!box?.folders, inboxesKey, streaming]); // eslint-disable-line react-hooks/exhaustive-deps
  const followed = (boxes ?? []).flatMap((b) => (b.folders ? [b.id] : [])).join();
  useEffect(() => {
    if (!followed) return;
    let stop: (() => void) | undefined;
    let gone = false;
    void import("./mail-live").then((m) => {
      if (!gone) stop = m.followMail(followed.split(","), (c) => changed.current(c.mailboxId, c.folderId), setStreaming);
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [followed]);

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
  /** The thread open beside the list (in all inboxes, of the mailbox the address names). */
  const isOpen = useCallback((i: MailThreadItem) => !!threadId && i.threadId === threadId && (!openIn || i.mailboxId === openIn), [threadId, openIn]);
  const selected = items.find(isOpen) ?? null;
  const openKey = selected ? itemKey(selected) : threadId ? `${openIn ?? box?.id}|${threadId}` : null;
  // Conversations picked for the selection bar: Cmd/Ctrl- or Shift-click, x, their boxes.
  const rows = useMemo(() => items.map((i) => ({ id: itemKey(i) })), [items]);
  const selection = useSelection(rows);
  const picked = useMemo(() => {
    const ids = new Set(selection.ids);
    return items.filter((i) => ids.has(itemKey(i)));
  }, [items, selection.ids]);
  // The rows and keys reach the selection through a ref: its functions change on every render.
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  });
  const onSelect = useCallback((item: MailThreadItem, range: boolean) => selectionRef.current.toggle(itemKey(item), range), []);

  // The top of the list, and the threads beside the open one, are loaded ahead.
  useEffect(() => loadAhead(items.slice(0, AHEAD_TOP).map((i) => i.messageId)), [items]);
  useEffect(() => {
    const at = items.findIndex(isOpen);
    if (at >= 0) loadAhead([items[at + 1], items[at + 2], items[at - 1]].map((i) => i?.messageId));
  }, [items, isOpen]);

  const act = useCallback(
    (targets: MailThreadItem[], action: MailAction, to?: MailFolderView, until?: Date) => {
      if (!targets.length) return;
      // Each thread goes to its own mailbox and folder: all inboxes act on several at once.
      const groups = new Map<string, MailThreadItem[]>();
      for (const i of targets) groups.set(`${i.mailboxId}|${i.folderId}`, [...(groups.get(`${i.mailboxId}|${i.folderId}`) ?? []), i]);
      const send = () => {
        for (const group of groups.values()) {
          const { mailboxId, folderId } = group[0];
          const ids = group.map((i) => i.threadId);
          for (let at = 0; at < ids.length; at += MAIL_MAX_THREADS) {
            void mailActionAction({ mailboxId, folderId, threadIds: ids.slice(at, at + MAIL_MAX_THREADS), action, to: to?.id, until: until?.toISOString() }).then((result) => {
              if (!result.ok) {
                showToast({ message: result.error });
                void loadPage(null);
                void loadMailboxes(workspaceId);
              }
            });
          }
        }
      };
      /** Changes the folders' unread counts by what `count` gives for each thread. */
      const countEach = (count: (i: MailThreadItem) => number) => {
        // A search and the starred list threads of every folder: the counts wait for the next refresh then.
        if (query || starred) return;
        for (const group of groups.values()) countUnread(group[0].mailboxId, group[0].folderId, group.reduce((n, i) => n + count(i), 0));
      };
      const touched = new Set(targets.map(itemKey));
      if (!MOVES.includes(action)) {
        const patch = (item: MailThreadItem): Partial<MailThreadItem> =>
          action === "read" ? { unread: false, unseen: 0 } : action === "unread" ? { unread: true, unseen: item.held } : { starred: action === "star" };
        if (action === "read") countEach((i) => -i.unseen);
        if (action === "unread") countEach((i) => i.held - i.unseen);
        setList((l) => ({ ...l, items: l.items.map((i) => (touched.has(itemKey(i)) ? { ...i, ...patch(i) } : i)) }));
        if (action === "unread") for (const key of touched) counted.current.delete(key);
        if (action === "unread" && openKey && touched.has(openKey)) go({ t: null });
        return send();
      }
      // In the starred, a thread archived, back in the inbox or moved stays, named by its new folder (when it is known yet).
      const movedTo =
        starred && STAYS_STARRED.includes(action)
          ? new Map(targets.map((i) => [itemKey(i), action === "move" ? to?.id : boxes?.find((b) => b.id === i.mailboxId)?.folders?.find((f) => f.role === action)?.id]))
          : null;
      const stays = !!movedTo && [...movedTo.values()].every(Boolean);
      // Else out of the list at once, the open one to the next thread left; to the server after the Undo window.
      if (!stays && openKey && touched.has(openKey)) {
        const at = items.findIndex(isOpen);
        const left = (i: MailThreadItem) => !touched.has(itemKey(i));
        const next = items.slice(at + 1).find(left) ?? items.slice(0, Math.max(at, 0)).findLast(left) ?? null;
        go({ t: next?.threadId ?? null, m: all ? next?.mailboxId : null }, true);
      }
      if (stays) setList((l) => ({ ...l, items: l.items.map((i) => (movedTo?.get(itemKey(i)) ? { ...i, folderId: movedTo.get(itemKey(i))! } : i)) }));
      else setList((l) => ({ ...l, items: l.items.filter((i) => !touched.has(itemKey(i))) }));
      countEach((i) => -i.unseen);
      const from = shown.current;
      const key = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.current.delete(key);
        if (lastUndo.current?.undo === undo) lastUndo.current = null;
        send();
      }, MAIL_UNDO_SECONDS * 1000);
      // A refresh within the window leaves out what waits to go (what stays is listed as it is).
      pending.current.set(key, { keys: stays ? [] : [...touched], run: send, timer });
      const count = targets.length;
      const done = action as "archive";
      const undo = () => {
        const waiting = pending.current.get(key);
        if (lastUndo.current?.undo === undo) lastUndo.current = null;
        if (!waiting) return;
        clearTimeout(waiting.timer);
        pending.current.delete(key);
        countEach((i) => i.unseen);
        if (shown.current !== from) return;
        const before = new Map(targets.map((i) => [itemKey(i), i]));
        if (stays) setList((l) => ({ ...l, items: l.items.map((i) => before.get(itemKey(i)) ?? i) }));
        else setList((l) => ({ ...l, items: [...l.items, ...targets].sort((a, b) => b.sentAt.localeCompare(a.sentAt)) }));
      };
      const time = until ? untilText(locale, until) : "";
      showToast({
        message:
          action === "snooze"
            ? t(count > 1 ? "bulk.done.snooze" : "done.snooze", { count, time })
            : count > 1
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
    [all, starred, boxes, items, isOpen, openKey, query, go, loadPage, t, workspaceId, folderName, locale],
  );

  const openThread = useCallback(
    (item: MailThreadItem) => {
      setCompose(null);
      // A draft is written on, not read.
      if (folder?.role === "drafts") go({ c: `d:${item.messageId}`, t: null });
      else go({ t: item.threadId, m: all ? item.mailboxId : null, c: null });
    },
    [go, all, folder?.role],
  );

  /**
   * A sender's mail, an address's or everyone's at a domain, goes to the other section from now on,
   * or the address is blocked: its conversations listed go to the junk. Undo puts the rule back as
   * it was (and the moves back, for a block).
   */
  const sortSender = useCallback(
    async (sender: string, kind: SenderRuleKind) => {
      const result = await setSenderRuleAction({ sender, kind }).catch(() => null);
      if (!result?.ok) return showToast({ message: result?.error ?? tc("genericError") });
      const previous = result.data.previous;
      const restore = () => void (previous ? setSenderRuleAction({ sender, kind: previous }) : removeSenderRuleAction({ sender })).then(() => loadLatest.current(null));
      const from = (i: MailThreadItem) => {
        const address = i.mark.address.toLowerCase();
        return address === sender || (!sender.includes("@") && senderDomain(address) === sender);
      };
      const theirs = items.filter(from);
      if (kind === "block") {
        act(theirs, "junk");
        const moved = lastUndo.current?.undo;
        const undo = () => {
          moved?.();
          restore();
        };
        showToast({ message: t("senders.blocked", { sender }), undo });
        lastUndo.current = { undo, toast: currentToast()?.id };
        return;
      }
      // Out of this section at once; the open one makes way for the next.
      if (section && kind !== section) {
        if (openKey && theirs.some((i) => itemKey(i) === openKey)) go({ t: null }, true);
        setList((l) => ({ ...l, items: l.items.filter((i) => !from(i)) }));
      }
      showToast({ message: t(kind === "other" ? "senders.toOther" : "senders.toFocus", { sender }), undo: restore });
      void loadLatest.current(null);
    },
    [items, act, section, openKey, go, t, tc],
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
  useEffect(() => counted.current.clear(), [openKey]);
  const onRead = useCallback(() => {
    const item = latest.current.find(isOpen);
    if (!item?.unread || counted.current.has(itemKey(item))) return;
    const key = itemKey(item);
    counted.current.add(key);
    if (!query && !starred) countUnread(item.mailboxId, item.folderId, -item.unseen);
    setList((l) => ({ ...l, items: l.items.map((i) => (itemKey(i) === key ? { ...i, unread: false, unseen: 0 } : i)) }));
  }, [isOpen, query, starred]);

  const snoozable = !!folder && snoozableFrom(folder);
  // Keyboard (listed in lib/shortcuts.ts): c new, / search, j/k next/previous, Enter/o open, x
  // select, ⌘A select all, e archive, # trash, ! junk, b snooze, s star, u unread, Shift+I read (the
  // selection's, or the open thread's), r/a/f reply/all/forward, Esc back to the list (or out of the
  // selection first), ⌘Z undo the last move, g then i/s/d/a/t a folder.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (composing || menu || snoozing) return;
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
        const role = GO_KEYS[goLetter(e.key)];
        // In all inboxes, g i goes to them; the other folders are the default mailbox's.
        const to = role && !(all && role === "inbox") && box?.folders?.find((f) => f.role === role);
        if (!role || (!to && !all)) return;
        e.preventDefault();
        setCompose(null);
        go(to ? { box: box!.id, f: to.id, t: null, q: null, c: null } : { f: null, t: null, q: null, c: null });
        return;
      }
      // Left to the page too: the sidebar's g then a letter starts with it (lib/shortcuts.ts railGoPlace).
      if (e.key === "g") {
        goPressed.current = Date.now();
        return;
      }
      const at = items.findIndex((i) => isOpen(i) || (!!draftId && i.messageId === draftId));
      const current = at >= 0 && threadId ? items[at] : null;
      // The moves and flags are the selection's while there is one.
      const targets = picked.length ? picked : current ? [current] : null;
      const move = (to: number) => {
        const target = items[Math.max(0, Math.min(items.length - 1, to))];
        if (!target) return;
        openThread(target);
        listRef.current?.querySelector(`[data-thread="${CSS.escape(itemKey(target))}"]`)?.scrollIntoView({ block: "nearest" });
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
        // From the selection's or the thread's Snooze button, else under the list's top.
        const button = document.querySelector(`[data-mail-snooze="${picked.length ? "selection" : "thread"}"]`);
        if (snoozable) keys.b = () => setSnoozing({ targets, at: button ?? { x: 24, y: listRef.current?.getBoundingClientRect().top ?? 120 } });
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
  }, [items, picked, threadId, isOpen, draftId, all, box, folder?.role, snoozable, act, openThread, onSelect, go, composing, menu, snoozing]);

  // Search as typed, a moment after the last key.
  useEffect(() => {
    if (typed === query) return;
    const timer = setTimeout(() => go({ q: typed.trim() || null, t: null }, true), 350);
    return () => clearTimeout(timer);
  }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshAll() {
    if (!box || refreshing) return;
    setRefreshing(true);
    const results = await Promise.all((all ? (boxes ?? []) : [box]).map((b) => refreshMailboxAction(b.id).catch(() => null)));
    setRefreshing(false);
    for (const result of results) if (result?.ok) putMailbox(result.data);
    if (results.some((result) => result?.ok)) void loadPage(null);
    const failed = results.find((result) => result && !result.ok);
    if (failed && !failed.ok) showToast({ message: failed.error });
  }

  // Emptying the trash or junk: what waits for Undo goes first (a thread moved out of it keeps its move).
  async function emptyOpenFolder() {
    if (!box || !folder || emptying === "working") return;
    const mailboxId = box.id;
    const folderId = folder.id;
    const role = folder.role === "junk" ? "junk" : "trash";
    const from = shown.current;
    setEmptying("working");
    for (const [id, p] of pending.current) {
      clearTimeout(p.timer);
      p.run();
      pending.current.delete(id);
    }
    const result = await emptyFolderAction({ mailboxId, folderId }).catch(() => null);
    setEmptying(null);
    if (!result?.ok) {
      showToast({ message: result?.error ?? tc("genericError") });
      return;
    }
    // Still on the folder emptied: its list and open thread go.
    if (shown.current === from) {
      setList({ items: [], next: null, loading: false, error: null });
      if (threadId) go({ t: null }, true);
    }
    showToast({ message: t(`emptyFolder.${role}Done`) });
    void read("mailRefreshFolder", mailboxId, folderId)
      .then((r) => r.ok && putFolders(mailboxId, r.data))
      .catch(() => {});
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

  const name = starred ? t(all ? "allStarred" : "starred") : all ? t("allInboxes") : folderName(folder);
  // The starred list has no count: it is kept, not read through.
  const unseen = starred ? 0 : all ? (boxes ?? []).reduce((n, b) => n + (b.folders?.find((f) => f.role === "inbox")?.unseen ?? 0), 0) : folder.unseen;
  // In all inboxes a thread's mailbox is its own, and in all inboxes and the starred its folder; elsewhere the page's.
  const boxOf = (item: Pick<MailThreadItem, "mailboxId">) => (all ? boxes.find((b) => b.id === item.mailboxId) : null) ?? box;
  const folderOf = (item: Pick<MailThreadItem, "mailboxId" | "folderId">) => boxOf(item).folders?.find((f) => f.id === item.folderId) ?? folder;
  const hrefOf = (item: MailThreadItem) => mailHref(workspaceId, { box: all ? ALL_INBOXES : box.id, f: listFolder, s: section, t: item.threadId, m: all ? item.mailboxId : null, q: query || null });
  // The open thread's mailbox and folder (in all inboxes, of the mailbox the address names when the list hasn't it).
  const openBox = selected ? boxOf(selected) : (all && boxes.find((b) => b.id === openIn)) || box;
  const openFolder = selected ? folderOf(selected) : (openBox.folders?.find((f) => f.role === "inbox") ?? folder);
  // A right click on one of several selected conversations is for all of them.
  const menuMany = menu && picked.length > 1 && selection.isSelected(itemKey(menu.item)) ? picked : null;
  const openItem = () => selected ?? ({ threadId, mailboxId: openBox.id, folderId: openFolder.id, unread: false, starred: false } as MailThreadItem);
  // Moving to a folder is within one mailbox: a selection across mailboxes moves by role only.
  const pickedBoxes = new Set(picked.map((i) => i.mailboxId));
  return (
    <div className="flex h-full min-h-0">
      <section className={cn("flex w-full min-w-0 shrink-0 flex-col border-e border-border md:w-[400px]", (threadId || composing) && "hidden md:flex")} aria-label={name}>
        <div className="shrink-0 space-y-2 border-b border-border px-4 pt-3 pb-3">
          {picked.length ? (
            <SelectionBar
              items={picked}
              all={selection.all}
              box={boxOf(picked[0])}
              folder={folderOf(picked[0])}
              acrossMailboxes={pickedBoxes.size > 1}
              onToggleAll={selection.toggleAll}
              onClear={selection.clear}
              onAction={(action, to) => act(picked, action, to)}
              onSnooze={(button) => setSnoozing({ targets: picked, at: button })}
            />
          ) : (
            <div className="flex items-center gap-2">
              <SidebarOpenButton className="-ms-1.5 max-md:-ms-2" />
              <h1 className="truncate text-base font-semibold">{query ? t("results") : name}</h1>
              {!query && unseen > 0 && folder.role !== "trash" && folder.role !== "junk" && <span className="shrink-0 text-xs text-fg-faint">{t("unreadCount", { count: unseen })}</span>}
              <span className="flex-1" />
              {!query && (folder.role === "trash" || folder.role === "junk") && (items.length > 0 || folder.total > 0) && (
                <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setEmptying("ask")} disabled={emptying === "working"}>
                  {t(`emptyFolder.${folder.role}`)}
                </Button>
              )}
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
          {section && (
            <div role="tablist" aria-label={t("sections.label")} className="-mb-3 flex gap-4">
              {(["focus", "other"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={section === value}
                  className={cn(
                    "-mb-px flex items-center gap-1.5 border-b-2 py-2 text-sm whitespace-nowrap transition-colors",
                    section === value ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg",
                  )}
                  onClick={() => section !== value && go({ s: value === "other" ? "other" : null, t: null })}
                >
                  {t(`sections.${value}`)}
                  {value === "other" && section === "focus" && otherUnread > 0 && (
                    <span className="text-xs text-fg-faint tabular-nums" aria-label={t("unreadCount", { count: otherUnread })}>
                      {otherUnread}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
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
            <Notice inList>{list.error}</Notice>
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
            <Notice inList>
              {starred && !query ? <Star className="mx-auto mb-2 h-5 w-5 text-fg-icon" /> : <Inbox className="mx-auto mb-2 h-5 w-5 text-fg-icon" />}
              {query ? t("emptySearch") : starred ? t("emptyStarred") : section === "other" ? t("sections.emptyOther") : t("empty")}
            </Notice>
          ) : (
            <>
              {items.map((item) => (
                <ThreadRow
                  key={itemKey(item)}
                  item={item}
                  href={hrefOf(item)}
                  selected={isOpen(item) || (!!draftId && item.messageId === draftId)}
                  checked={selection.isSelected(itemKey(item))}
                  selecting={selection.some}
                  menuOpen={!!menu && itemKey(menu.item) === itemKey(item)}
                  me={boxOf(item).address}
                  mailbox={all ? boxOf(item).address : null}
                  marks={marks}
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
        {(folder.role === "trash" || folder.role === "junk") && (
          <Dialog open={!!emptying} onClose={() => emptying === "ask" && setEmptying(null)} className="max-w-md">
            <DialogBody className="pt-5">
              <div className="space-y-1.5">
                <DialogTitle>{t(`emptyFolder.${folder.role}Title`)}</DialogTitle>
                <p className="text-sm text-fg-muted">{t("emptyFolder.body", { folder: name })}</p>
              </div>
            </DialogBody>
            <DialogFooter>
              {/* Focus in the dialog keeps the list's shortcuts off it. */}
              <Button variant="secondary" onClick={() => setEmptying(null)} disabled={emptying === "working"} autoFocus>
                {tc("cancel")}
              </Button>
              <Button variant="danger" onClick={() => void emptyOpenFolder()} disabled={emptying === "working"}>
                {t("actions.delete")}
              </Button>
            </DialogFooter>
          </Dialog>
        )}
        {menu && (
          <ThreadMenu
            key={`${itemKey(menu.item)}-${menu.at.x}-${menu.at.y}`}
            at={menu.at}
            item={menuMany ? { ...menu.item, unread: menuMany.some((i) => i.unread), starred: menuMany.every((i) => i.starred) } : menu.item}
            many={menuMany?.length ?? 0}
            box={boxOf(menu.item)}
            folder={folderOf(menu.item)}
            acrossMailboxes={!!menuMany && pickedBoxes.size > 1}
            href={hrefOf(menu.item)}
            onClose={() => setMenu(null)}
            onAction={(action, to) => (action === "snooze" ? setSnoozing({ targets: menuMany ?? [menu.item], at: menu.at }) : act(menuMany ?? [menu.item], action, to))}
            onSelect={() => onSelect(menu.item, false)}
            onCompose={(mode) => {
              openThread(menu.item);
              setCompose(mode);
            }}
            onFind={(found) => {
              setTyped(found);
              go({ q: found, t: null });
            }}
            section={section}
            onSender={(sender, kind) => void sortSender(sender, kind)}
          />
        )}
        {snoozing && <SnoozePicker at={snoozing.at} onClose={() => setSnoozing(null)} onPick={(until) => act(snoozing.targets, "snooze", undefined, until)} />}
      </section>
      {composing ? (
        <PaneComposer
          key={pane.n}
          id={pane.draft}
          workspaceId={workspaceId}
          ai={ai}
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
          key={openKey}
          workspaceId={workspaceId}
          ai={ai}
          box={openBox}
          folder={openFolder}
          threadId={threadId}
          first={selected ? { id: selected.messageId, unread: selected.unread } : null}
          starred={!!selected?.starred}
          onAction={(action) => act([openItem()], action)}
          onSnooze={(button) => setSnoozing({ targets: [openItem()], at: button })}
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

/** A message in place of the page, or (`inList`) of the list, under a header that has the sidebar's button already. */
function Notice({ children, inList = false }: { children: React.ReactNode; inList?: boolean }) {
  return (
    <>
      {!inList && (
        <div className="h-0">
          <SidebarOpenButton className="m-2" />
        </div>
      )}
      <div className="mx-auto max-w-sm px-6 py-16 text-center text-sm text-fg-muted">{children}</div>
    </>
  );
}

