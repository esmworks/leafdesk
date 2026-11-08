"use client";

import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MessageView } from "@/lib/message-wire";
import { cn } from "@/components/ui";
import { MessageItem, pendingView, type ItemContext } from "./message-item";
import { PersonFace } from "./person";
import { inMainList, loadHistory, markRead, messagesState, useMessages, useView, type Pending } from "./store";

/** Messages of one person this close together show as one group, under one name. */
const GROUP_MS = 5 * 60_000;
/** Within this many pixels of the end, the list counts as at the end and follows new messages. */
const AT_END_PX = 80;
/** Within this many pixels of an edge, the next page loads. */
const LOAD_PX = 600;

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function dayLabel(date: Date, locale: string, words: { today: string; yesterday: string }) {
  const now = new Date();
  if (sameDay(date, now)) return words.today;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return words.yesterday;
  return date.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

type Line = { kind: "day"; key: string; label: string } | { kind: "unread"; key: string } | { kind: "message"; key: string; m: MessageView; continued: boolean; pending?: Pending; readers?: string[] };

/** Whether a message follows the one before it under the same name. */
export function continues(prev: MessageView | undefined, m: MessageView): boolean {
  if (!prev || prev.kind !== "message" || m.kind !== "message") return false;
  if (prev.authorId !== m.authorId || !!prev.data?.importedFrom !== !!m.data?.importedFrom) return false;
  if (prev.data?.importedFrom && prev.data.importedFrom.name !== m.data?.importedFrom?.name) return false;
  if (m.data?.forward) return false;
  return new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_MS;
}

/**
 * A channel's main list: loads what is around the first unread message (or the one asked for)
 * and more as it scrolls either way, keeps its place when older messages come in above, follows
 * new ones while at the end, and marks the channel read while it is seen there. Days are divided,
 * a line marks where new messages started when it opened, and in small conversations faces show
 * how far each person read.
 */
export function MessageList({
  channelId,
  ctx,
  highlightId,
  editingId,
  setEditing,
  bottomRef,
}: {
  channelId: string;
  ctx: ItemContext;
  highlightId: string | null;
  editingId: string | null;
  setEditing: (id: string | null) => void;
  /** Called with a function that scrolls to the end, for the box below to call after sending. */
  bottomRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const t = useTranslations("messages");
  const locale = useLocale();
  const view = useView();
  const timeline = useMessages((s) => s.timelines.get(channelId));
  const messages = useMessages((s) => s.messages);
  const pendingAll = useMessages((s) => s.pending);
  const channel = useMessages((s) => s.channels.get(channelId));
  const member = useMessages((s) => s.memberships.get(channelId));
  const reads = useMessages((s) => s.reads.get(channelId));
  const status = useMessages((s) => s.status);
  const box = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState<"before" | "after" | "first" | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [failed, setFailed] = useState(false);
  // Where new messages began when the channel opened: kept while it stays open, so reading doesn't move the line.
  const [unreadFrom, setUnreadFrom] = useState<number | null>(null);
  const [unreadAbove, setUnreadAbove] = useState(false);
  const opened = useRef<string | null>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const followEnd = useRef(true);
  const scrolledTo = useRef<string | null>(null);

  // First load: around the message asked for, else around the first unread one, else the newest.
  useEffect(() => {
    if (opened.current === channelId) return;
    opened.current = channelId;
    const m = messagesState().memberships.get(channelId);
    const c = messagesState().channels.get(channelId);
    setUnreadFrom(m && c && m.lastReadSeq < c.lastSeq ? m.lastReadSeq : null);
    followEnd.current = !highlightId;
    scrolledTo.current = null;
    setFailed(false);
    const line = messagesState().timelines.get(channelId);
    const wantsAround = highlightId && !line?.ids.includes(highlightId) && !messagesState().messages.get(highlightId)?.threadId;
    const hasUnread = m && c && m.lastReadSeq < c.lastSeq && (c.lastSeq - m.lastReadSeq > 30 || !line);
    if (line && !wantsAround && !(hasUnread && line.hasAfter)) return;
    setLoading("first");
    void loadHistory(channelId, wantsAround ? { around: highlightId } : hasUnread && c.lastSeq - m.lastReadSeq > 30 ? { around: "unread" } : {})
      .catch(() => setFailed(true))
      .finally(() => setLoading(null));
  }, [channelId, highlightId]);

  // A connection back after being away: the newest part again, unless older pages are being read.
  useEffect(() => {
    if (status !== "open" || !opened.current) return;
    const line = messagesState().timelines.get(channelId);
    if (line && !line.hasAfter && followEnd.current) void loadHistory(channelId, { after: true }).catch(() => {});
  }, [status, channelId]);

  const pending = useMemo(() => [...pendingAll.values()].filter((p) => p.channelId === channelId && (!p.threadId || p.alsoInChannel)), [pendingAll, channelId]);

  const lines = useMemo<Line[]>(() => {
    const out: Line[] = [];
    const shown: MessageView[] = [];
    for (const id of timeline?.ids ?? []) {
      const m = messages.get(id);
      if (m && inMainList(m)) shown.push(m);
    }
    // Sent messages the server already has are in the list; the others come after it.
    const known = new Set(shown.map((m) => m.id));
    const extra = timeline?.hasAfter ? [] : pending.filter((p) => !known.has(p.id));
    // Who read up to where: each face under the last message it read.
    const readAt = new Map<string, string[]>();
    if (reads && channel && channel.memberCount <= 20) {
      for (const [userId, seq] of reads) {
        if (userId === view.me) continue;
        let last: MessageView | undefined;
        for (const m of shown) if (m.seq <= seq) last = m;
        if (last) readAt.set(last.id, [...(readAt.get(last.id) ?? []), userId]);
      }
    }
    let prev: MessageView | undefined;
    let unreadShown = false;
    const all: { m: MessageView; pending?: Pending }[] = [...shown.map((m) => ({ m })), ...extra.map((p) => ({ m: pendingView(p, view.me), pending: p }))];
    for (const { m, pending: p } of all) {
      const day = new Date(m.createdAt);
      let divided = false;
      if (!prev || !sameDay(new Date(prev.createdAt), day)) {
        out.push({ kind: "day", key: `day:${m.id}`, label: dayLabel(day, locale, { today: t("today"), yesterday: t("yesterday") }) });
        divided = true;
      }
      if (!unreadShown && unreadFrom !== null && !p && m.seq > unreadFrom && m.authorId !== view.me) {
        out.push({ kind: "unread", key: "unread" });
        unreadShown = true;
        divided = true;
      }
      out.push({ kind: "message", key: m.id, m, continued: !divided && continues(prev, m), pending: p, readers: readAt.get(m.id) });
      prev = m;
    }
    return out;
  }, [timeline, messages, pending, reads, channel, view.me, unreadFrom, locale, t]);
  // The lines by day, each day a section of its own (its label sticks only within it).
  const days = useMemo(() => {
    const out: { key: string; label: string | null; rows: Line[] }[] = [];
    for (const line of lines) {
      if (line.kind === "day") out.push({ key: line.key, label: line.label, rows: [] });
      else {
        if (!out.length) out.push({ key: "start", label: null, rows: [] });
        out[out.length - 1].rows.push(line);
      }
    }
    return out;
  }, [lines]);

  const toEnd = useCallback((smooth?: boolean) => {
    const el = box.current;
    if (!el) return;
    followEnd.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  useEffect(() => {
    if (!bottomRef) return;
    bottomRef.current = () => {
      if (messagesState().timelines.get(channelId)?.hasAfter) {
        // The newest messages aren't loaded: load them, then go there.
        void loadHistory(channelId).then(() => requestAnimationFrame(() => toEnd()));
      } else requestAnimationFrame(() => toEnd());
    };
    return () => {
      bottomRef.current = null;
    };
  }, [bottomRef, channelId, toEnd]);

  // Before a page of older messages comes in above, remember where the first message seen sits.
  const remember = () => {
    const el = box.current;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLElement>("[data-message-id]");
    for (const row of rows) {
      const top = row.offsetTop - el.scrollTop;
      if (top >= 0) {
        anchor.current = { id: row.dataset.messageId!, top };
        return;
      }
    }
  };

  // After the list changed: keep the remembered message where it was, or follow the end, or show the one asked for.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (anchor.current) {
      const row = el.querySelector<HTMLElement>(`[data-message-id="${anchor.current.id}"]`);
      if (row) el.scrollTop = row.offsetTop - anchor.current.top;
      anchor.current = null;
      return;
    }
    if (highlightId && scrolledTo.current !== highlightId) {
      const row = el.querySelector<HTMLElement>(`[data-message-id="${highlightId}"]`);
      if (row) {
        scrolledTo.current = highlightId;
        followEnd.current = false;
        el.scrollTop = row.offsetTop - el.clientHeight / 3;
        return;
      }
    }
    if (!scrolledTo.current && unreadFrom !== null && !highlightId) {
      const line = el.querySelector<HTMLElement>("[data-unread-line]");
      if (line) {
        scrolledTo.current = "unread";
        // The first unread message near the top, unless everything fits.
        const top = line.offsetTop - 48;
        if (el.scrollHeight - top > el.clientHeight) {
          followEnd.current = false;
          el.scrollTop = top;
          return;
        }
      }
    }
    if (followEnd.current) el.scrollTop = el.scrollHeight;
  }, [lines, highlightId, unreadFrom]);

  // Images and other late content grow rows: stay at the end while following it.
  useEffect(() => {
    const el = box.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (followEnd.current && !anchor.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  // Read while seen: at the end, in a focused, shown tab.
  const lastSeq = channel?.lastSeq ?? 0;
  const lastLoadedSeq = timeline?.ids.length ? (messages.get(timeline.ids.at(-1)!)?.seq ?? 0) : 0;
  useEffect(() => {
    if (!member) return;
    const read = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const line = messagesState().timelines.get(channelId);
      const el = box.current;
      if (!el || !line) return;
      const end = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX;
      if (end && !line.hasAfter) markRead(channelId, Math.max(lastSeq, lastLoadedSeq));
      else if (lastLoadedSeq) {
        // Not at the end: read as far as the last message seen.
        const rows = el.querySelectorAll<HTMLElement>("[data-seq]");
        let seen = 0;
        for (const row of rows) if (row.offsetTop + row.offsetHeight <= el.scrollTop + el.clientHeight) seen = Math.max(seen, Number(row.dataset.seq) || 0);
        if (seen && seen < Number.MAX_SAFE_INTEGER && seen > (messagesState().memberships.get(channelId)?.lastReadSeq ?? 0)) markRead(channelId, seen);
      }
    };
    read();
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    const el = box.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(read, 400);
    };
    el?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
      el?.removeEventListener("scroll", onScroll);
    };
  }, [channelId, member, lastSeq, lastLoadedSeq]);

  const onScroll = () => {
    const el = box.current;
    if (!el || !timeline) return;
    const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
    const end = fromEnd < AT_END_PX;
    followEnd.current = end && !timeline.hasAfter;
    if (end !== atEnd) setAtEnd(end);
    const line = el.querySelector<HTMLElement>("[data-unread-line]");
    setUnreadAbove(!!line && line.offsetTop < el.scrollTop);
    if (loading) return;
    if (el.scrollTop < LOAD_PX && timeline.hasBefore) {
      setLoading("before");
      remember();
      void loadHistory(channelId, { before: true })
        .catch(() => {
          anchor.current = null;
        })
        .finally(() => setLoading(null));
    } else if (fromEnd < LOAD_PX && timeline.hasAfter) {
      setLoading("after");
      void loadHistory(channelId, { after: true })
        .catch(() => {})
        .finally(() => setLoading(null));
    }
  };

  const jumpToUnread = () => {
    const el = box.current;
    const line = el?.querySelector<HTMLElement>("[data-unread-line]");
    if (el && line) el.scrollTo({ top: line.offsetTop - 48, behavior: "smooth" });
    else if (unreadFrom !== null) {
      scrolledTo.current = null;
      void loadHistory(channelId, { around: "unread" });
    }
  };

  const jumpToEnd = () => {
    if (timeline?.hasAfter) {
      setLoading("first");
      void loadHistory(channelId)
        .then(() => requestAnimationFrame(() => toEnd()))
        .finally(() => setLoading(null));
    } else toEnd(true);
  };

  const newCount = member && channel ? Math.max(0, channel.lastSeq - member.lastReadSeq) : 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {unreadAbove && unreadFrom !== null && (
        <button
          type="button"
          onClick={jumpToUnread}
          className="absolute start-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-border bg-bg px-3 py-1 text-xs font-medium text-fg shadow-sm hover:bg-bg-hover rtl:translate-x-1/2"
        >
          <ArrowUp className="h-3.5 w-3.5" />
          {t("jumpToUnread")}
        </button>
      )}
      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]" role="log" aria-live="polite" aria-relevant="additions" aria-label={t("messageList")}>
        <div className="flex min-h-full flex-col justify-end pb-3">
          {loading === "first" && !timeline && (
            <div className="flex flex-1 items-center justify-center py-10 text-fg-faint">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          {failed && !timeline && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-sm text-fg-muted">
              {t("loadFailed")}
              <button
                type="button"
                onClick={() => {
                  setFailed(false);
                  opened.current = null;
                  setLoading("first");
                  void loadHistory(channelId)
                    .catch(() => setFailed(true))
                    .finally(() => setLoading(null));
                }}
                className="text-accent hover:underline"
              >
                {t("retry")}
              </button>
            </div>
          )}
          {timeline && !timeline.hasBefore && channel && <ChannelStart channelId={channelId} />}
          {timeline?.hasBefore && (
            <div className="flex justify-center py-3 text-fg-faint">{loading === "before" ? <Loader2 className="h-4 w-4 animate-spin" /> : <span className="h-4" />}</div>
          )}
          {days.map((day) => (
            // A day's label holds to the top only while its own messages scroll by; its line stays
            // where it is, so neither draws over the messages under it.
            <section key={day.key} className="relative">
              {day.label && (
                <>
                  <div aria-hidden className="absolute inset-x-4 top-[15px] h-px bg-border" />
                  <div className="pointer-events-none sticky top-0 z-[1] flex justify-center px-4 py-1.5">
                    <span className="pointer-events-auto rounded-md border border-border bg-bg px-2 text-xs font-medium text-fg-muted">{day.label}</span>
                  </div>
                </>
              )}
              {day.rows.map((line) =>
                line.kind === "unread" ? (
                  <div key={line.key} data-unread-line className="flex items-center gap-2 px-4 py-1">
                    <span className="h-px flex-1 bg-danger/60" />
                    <span className="text-xs font-semibold text-danger">{t("newMessages")}</span>
                  </div>
                ) : line.kind === "message" ? (
                  <div key={line.key} className="[contain-intrinsic-size:auto_48px] [content-visibility:auto]">
                    <MessageItem m={line.m} continued={line.continued} ctx={ctx} highlighted={line.m.id === highlightId} pending={line.pending} editing={editingId === line.m.id} setEditing={setEditing} />
                    {line.readers && line.readers.length > 0 && (
                      <div className="flex justify-end gap-0.5 px-4 pb-0.5" title={t("readBy", { people: line.readers.map((id) => view.people.get(id)?.name ?? t("someone")).join(", ") })}>
                        {line.readers.slice(0, 8).map((id) => (
                          <PersonFace key={id} s={view} userId={id} size="xs" presence={false} />
                        ))}
                      </div>
                    )}
                  </div>
                ) : null,
              )}
            </section>
          ))}
          {loading === "after" && (
            <div className="flex justify-center py-3 text-fg-faint">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
        </div>
      </div>
      {(!atEnd || timeline?.hasAfter) && timeline && (
        <button
          type="button"
          onClick={jumpToEnd}
          className="absolute end-4 bottom-3 z-10 flex items-center gap-1.5 rounded-md border border-border bg-bg px-3 py-1 text-xs font-medium text-fg shadow-sm hover:bg-bg-hover"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          {newCount > 0 && !followEnd.current ? t("newCount", { count: newCount }) : t("jumpToLatest")}
        </button>
      )}
    </div>
  );
}

/** The top of a channel's list: what it is and who made it when. */
function ChannelStart({ channelId }: { channelId: string }) {
  const t = useTranslations("messages");
  const locale = useLocale();
  const view = useView();
  const channel = view.channels.get(channelId);
  if (!channel) return null;
  const others = channel.people.filter((id) => id !== view.me);
  const creator = channel.createdBy ? view.people.get(channel.createdBy)?.name : null;
  const when = new Date(channel.createdAt).toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
  return (
    <div className="px-4 pt-8 pb-4">
      {channel.kind === "direct" ? (
        <>
          <div className="mb-3 flex -space-x-2 rtl:space-x-reverse">
            {(others.length ? others : [view.me]).slice(0, 5).map((id) => (
              <PersonFace key={id} s={view} userId={id} size="lg" presence={false} />
            ))}
          </div>
          <p className="text-sm text-fg-muted">
            {others.length === 0
              ? t("startSelf")
              : t("startDirect", { people: others.map((id) => view.people.get(id)?.name ?? t("someone")).join(", ") })}
          </p>
        </>
      ) : (
        <>
          <h2 className="text-xl font-semibold text-fg">{t("startChannelTitle", { name: channel.name ?? "" })}</h2>
          <p className={cn("mt-1 text-sm text-fg-muted")}>
            {creator ? t("startChannel", { person: creator, when }) : t("startChannelNoOne", { when })}
            {channel.description && <span className="mt-1 block text-fg">{channel.description}</span>}
          </p>
        </>
      )}
    </div>
  );
}
