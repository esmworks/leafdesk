"use client";

import { Bell, BellOff, Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { Composer, type ComposerHandle } from "./composer";
import { continues } from "./message-list";
import { MessageItem, pendingView, type ItemContext } from "./message-item";
import { call, channelTitle, loadThread, markThreadRead, messagesState, useMessages, useView } from "./store";
import { TypingLine } from "./typing-line";

/**
 * A thread beside the channel: its first message, the replies under it and a box to answer, with
 * whether the person follows it. Read while it is open in a focused tab.
 */
export function ThreadPanel({ threadId, ctx, close, highlightId }: { threadId: string; ctx: ItemContext; close: () => void; highlightId: string | null }) {
  const t = useTranslations("messages");
  const view = useView();
  const root = useMessages((s) => s.messages.get(threadId));
  const replyIds = useMessages((s) => s.replies.get(threadId));
  const messages = useMessages((s) => s.messages);
  const pendingAll = useMessages((s) => s.pending);
  const thread = useMessages((s) => s.threads.get(threadId));
  const status = useMessages((s) => s.status);
  const [failed, setFailed] = useState(false);
  const [editingId, setEditing] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const atEnd = useRef(true);

  useEffect(() => {
    setFailed(false);
    atEnd.current = true;
    void loadThread(threadId).catch(() => setFailed(true));
    requestAnimationFrame(() => composer.current?.focus());
  }, [threadId]);
  // Back after a lost connection: the replies again (sync brings changes, not a list it never had).
  useEffect(() => {
    if (status === "open") void loadThread(threadId).catch(() => {});
  }, [status, threadId]);

  const pending = useMemo(() => [...pendingAll.values()].filter((p) => p.threadId === threadId), [pendingAll, threadId]);
  const replies = useMemo(() => {
    // Replies that came live are in `messages` before the list is loaded again: take both.
    const ids = new Set(replyIds ?? []);
    for (const m of messages.values()) if (m.threadId === threadId) ids.add(m.id);
    const list = [...ids].flatMap((id) => (messages.get(id) ? [messages.get(id)!] : [])).sort((a, b) => a.seq - b.seq);
    const known = new Set(list.map((m) => m.id));
    return [...list.map((m) => ({ m, p: undefined })), ...pending.filter((p) => !known.has(p.id)).map((p) => ({ m: pendingView(p, view.me), p }))];
  }, [replyIds, messages, threadId, pending, view.me]);

  const lastSeq = replies.reduce((n, r) => (r.p ? n : Math.max(n, r.m.seq)), 0);
  useEffect(() => {
    const read = () => {
      if (document.visibilityState === "visible" && document.hasFocus() && lastSeq) markThreadRead(threadId, lastSeq);
    };
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [threadId, lastSeq]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (highlightId) {
      const row = el.querySelector<HTMLElement>(`[data-message-id="${highlightId}"]`);
      if (row) {
        el.scrollTop = row.offsetTop - el.clientHeight / 3;
        return;
      }
    }
    if (atEnd.current) el.scrollTop = el.scrollHeight;
  }, [replies.length, highlightId]);

  const channel = root ? view.channels.get(root.channelId) : undefined;
  const following = thread?.following ?? false;
  const threadCtx = useMemo<ItemContext>(() => ({ ...ctx, inThread: true }), [ctx]);
  const editLast = () => {
    const mine = [...replies].reverse().find((r) => !r.p && r.m.authorId === view.me && !r.m.deletedAt && r.m.kind === "message");
    if (mine) setEditing(mine.m.id);
  };

  return (
    <aside aria-label={t("thread")} className="flex h-full min-h-0 w-full flex-col border-border bg-bg md:w-[26rem] md:shrink-0 md:border-s">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-fg">{t("thread")}</h2>
          {channel && <p className="truncate text-xs text-fg-muted">{channelTitle(view, channel, { you: t("you"), someone: t("someone") })}</p>}
        </div>
        {root && (
          <button
            type="button"
            onClick={() => void call("follow", { threadId, following: !following }).catch(() => {})}
            title={following ? t("unfollowThread") : t("followThread")}
            aria-pressed={following}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            {following ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
            {following ? t("unfollowThread") : t("followThread")}
          </button>
        )}
        <button type="button" onClick={close} aria-label={t("closeThread")} title={t("closeThread")} className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2"
      >
        {!root ? (
          <div className="flex justify-center py-10 text-fg-faint">{failed ? <p className="text-sm text-fg-muted">{t("threadMissing")}</p> : <Loader2 className="h-5 w-5 animate-spin" />}</div>
        ) : (
          <>
            <div className="pt-2">
              <MessageItem m={root} continued={false} ctx={threadCtx} editing={editingId === root.id} setEditing={setEditing} highlighted={root.id === highlightId} />
            </div>
            <div className="flex items-center gap-2 px-4 py-2">
              <span className="text-xs text-fg-muted">{t("replies", { count: root.replyCount })}</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            {replies.map((r, i) => (
              <MessageItem
                key={r.m.id}
                m={r.m}
                continued={continues(replies[i - 1]?.m, r.m)}
                ctx={threadCtx}
                pending={r.p}
                highlighted={r.m.id === highlightId}
                editing={editingId === r.m.id}
                setEditing={setEditing}
              />
            ))}
          </>
        )}
      </div>
      {root && channel && (
        <div className={cn("shrink-0 px-3 pb-3")}>
          <TypingLine channelId={root.channelId} threadId={threadId} />
          <Composer
            ref={composer}
            workspaceId={ctx.workspaceId}
            channelId={root.channelId}
            threadId={threadId}
            placeholder={t("replyPlaceholder")}
            disabled={!ctx.writes ? (channel.archivedAt ? t("archivedNotice") : t("readOnlyNotice")) : null}
            onEditLast={editLast}
            onSent={() => {
              atEnd.current = true;
              requestAnimationFrame(() => {
                if (box.current) box.current.scrollTop = box.current.scrollHeight;
              });
            }}
          />
        </div>
      )}
    </aside>
  );
}

/** Whether the message is a reply shown only in its thread. */
export const onlyInThread = (id: string) => {
  const m = messagesState().messages.get(id);
  return !!m?.threadId && !m.alsoInChannel;
};
