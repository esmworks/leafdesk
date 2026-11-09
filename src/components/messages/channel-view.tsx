"use client";

import { Archive, BellOff, ChevronDown, Hash, Lock, Pin, Search, Star, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SidebarOpenButton } from "@/components/sidebar/sidebar-context";
import { showToast } from "@/components/toast";
import { lazyPart } from "@/components/lazy-part";
import { Button, cn, Popover } from "@/components/ui";
import type { MessageView } from "@/lib/message-wire";
import { CATCH_UP_MIN_UNREAD } from "@/lib/message-catch-up";
import { messagesPath } from "@/lib/messages";
import { CatchUpButton } from "./catch-up-button";
import type { DetailsTab } from "./channel-dialogs";
import { Composer, type ComposerHandle } from "./composer";
import { MessageBody } from "./message-body";
import { MessageList } from "./message-list";
import type { ItemContext } from "./message-item";
import { stayInMessages } from "./messages-sidebar";
import { PersonFace } from "./person";
import { call, channelTitle, messagesState, MessagesError, putMessages, setViewing, useMessages, useView } from "./store";
import { TypingLine } from "./typing-line";

const ChannelDetails = lazyPart(() => import("./channel-dialogs").then((m) => m.ChannelDetails));

/**
 * One channel or direct conversation: its head (name, topic, people, pinned messages, details),
 * the list and the box to write in. A public channel the person isn't in shows read-only with a
 * Join button; an archived one says so.
 */
export function ChannelView({
  workspaceId,
  channelId,
  highlightId,
  openThread,
  forward,
  owner,
  ai,
}: {
  workspaceId: string;
  channelId: string;
  highlightId: string | null;
  openThread: (threadId: string, messageId?: string) => void;
  forward: (messageId: string) => void;
  /** The person owns the workspace (deletes others' messages anywhere). */
  owner: boolean;
  /** The workspace has AI: offer to catch up on what the person missed. */
  ai: boolean;
}) {
  const t = useTranslations("messages");
  const view = useView();
  const channel = useMessages((s) => s.channels.get(channelId));
  const member = useMessages((s) => s.memberships.get(channelId));
  const viewers = useMessages((s) => s.viewers.get(channelId));
  const ready = useMessages((s) => s.ready);
  const [editingId, setEditing] = useState<string | null>(null);
  const [details, setDetails] = useState<DetailsTab | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const toEnd = useRef<(() => void) | null>(null);
  const [missing, setMissing] = useState(false);
  // What the person hadn't read when the channel opened, kept while it stays open (reading marks
  // messages read as they show): a catch-up sums up the messages after it.
  const [unreadSince, setUnreadSince] = useState<{ channelId: string; seq: number | null } | null>(null);

  // The server sends this channel's messages to this tab while it is open, member or not.
  useEffect(() => {
    setViewing(channelId);
    return () => setViewing(null);
  }, [channelId]);
  useEffect(() => {
    setEditing(null);
    setMissing(false);
    requestAnimationFrame(() => composer.current?.focus());
  }, [channelId]);
  useEffect(() => {
    if (!ready || !member || !channel || unreadSince?.channelId === channelId) return;
    setUnreadSince({ channelId, seq: member.unread >= CATCH_UP_MIN_UNREAD && member.lastReadSeq < channel.lastSeq ? member.lastReadSeq : null });
  }, [ready, member, channel, channelId, unreadSince]);
  const catchUpSince = unreadSince?.channelId === channelId ? unreadSince.seq : null;
  // A public channel the person isn't in, opened by its link: the server knows it.
  useEffect(() => {
    if (!ready || channel) return;
    void call("browse", { query: "" }).then(
      (list) => {
        const found = (list as { id: string }[]).find((c) => c.id === channelId);
        if (!found) setMissing(true);
      },
      () => setMissing(true),
    );
  }, [ready, channel, channelId]);

  const writes = !!member && !!channel && !channel.archivedAt && (channel.posting === "everyone" || member.role === "admin" || owner);
  // Polls take votes from everyone in the channel, even where only its admins post.
  const votes = !!member && !!channel && !channel.archivedAt;
  const ctx = useMemo<ItemContext>(
    () => ({ workspaceId, openThread, forward, moderates: owner || member?.role === "admin", writes, votes }),
    [workspaceId, openThread, forward, owner, member?.role, writes, votes],
  );

  // ↑ in an empty box: the person's last message in the list, if it is loaded.
  const editLast = useCallback(() => {
    const s = messagesState();
    const ids = s.timelines.get(channelId)?.ids ?? [];
    for (let i = ids.length - 1; i >= Math.max(0, ids.length - 50); i--) {
      const m = s.messages.get(ids[i]);
      // A poll's question stays as people voted on it: ↑ edits the message before it.
      if (m && m.authorId === s.me && m.kind === "message" && !m.deletedAt && !m.poll) {
        setEditing(m.id);
        document.querySelector(`[data-message-id="${m.id}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }
    }
  }, [channelId]);

  if (!channel) {
    return (
      <div className="flex flex-1 flex-col">
        <Head>
          <span className="text-sm text-fg-muted">{missing ? t("channelMissing") : t("loading")}</span>
        </Head>
      </div>
    );
  }

  const title = channelTitle(view, channel, { you: t("you"), someone: t("someone") });
  const others = channel.people.filter((id) => id !== view.me);
  const direct = channel.kind === "direct";
  const watching = (viewers ?? []).filter((id) => id !== view.me);

  const join = () =>
    void call("join", { channelId }).catch((error) => showToast({ message: t(`errors.${error instanceof MessagesError ? (error.code as "internal") : "internal"}`) }));
  const toggleStar = () => void call("prefs", { channelId, starred: !member?.starred }).catch(() => {});

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", details && "max-md:hidden")}>
        <Head>
          <button
            type="button"
            onClick={() => setDetails("about")}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-start hover:bg-bg-hover"
            title={t("channelDetails")}
          >
            {direct ? (
              <PersonFace s={view} userId={others[0] ?? view.me} size="xs" count={others.length > 1 ? others.length : undefined} />
            ) : channel.kind === "private" ? (
              <Lock className="h-4 w-4 shrink-0 text-fg-icon" />
            ) : (
              <Hash className="h-4 w-4 shrink-0 text-fg-icon" />
            )}
            <h1 className="truncate text-sm font-semibold text-fg">{title}</h1>
            {member?.muted && <BellOff className="h-3.5 w-3.5 shrink-0 text-fg-faint" aria-label={t("muted")} />}
            {channel.archivedAt && <Archive className="h-3.5 w-3.5 shrink-0 text-fg-faint" aria-label={t("archived")} />}
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          </button>
          {member && (
            <button
              type="button"
              onClick={toggleStar}
              aria-pressed={member.starred}
              aria-label={member.starred ? t("unstar") : t("star")}
              title={member.starred ? t("unstar") : t("star")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <Star className={cn("h-4 w-4", member.starred && "fill-current text-fg")} />
            </button>
          )}
          {channel.topic && !direct && (
            <button type="button" onClick={() => setDetails("about")} className="hidden min-w-0 flex-1 truncate text-start text-xs text-fg-muted hover:text-fg md:block" title={channel.topic}>
              {channel.topic}
            </button>
          )}
          <span className="flex-1" />
          {watching.length > 0 && (
            <span className="hidden items-center -space-x-1.5 md:flex rtl:space-x-reverse" title={t("viewingNow", { people: watching.map((id) => view.people.get(id)?.name ?? t("someone")).join(", ") })}>
              {watching.slice(0, 4).map((id) => (
                <PersonFace key={id} s={view} userId={id} size="xs" presence={false} />
              ))}
            </span>
          )}
          {!direct && (
            <button
              type="button"
              onClick={() => setDetails("people")}
              title={t("people")}
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-fg-muted tabular-nums hover:bg-bg-hover hover:text-fg"
            >
              <Users className="h-4 w-4" />
              {channel.memberCount}
            </button>
          )}
          {ai && catchUpSince !== null && <CatchUpButton target={{ channelId, since: catchUpSince }} workspaceId={workspaceId} openThread={openThread} />}
          <PinnedButton channelId={channelId} workspaceId={workspaceId} openThread={openThread} />
          <a
            href={messagesPath(workspaceId, { view: "search", query: direct ? "" : `in:#${channel.name ?? ""} ` })}
            onClick={(e) => stayInMessages(e, messagesPath(workspaceId, { view: "search", query: direct ? "" : `in:#${channel.name ?? ""} ` }))}
            aria-label={t("searchIn")}
            title={t("searchIn")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <Search className="h-4 w-4" />
          </a>
        </Head>
        <div className="flex min-h-0 flex-1 flex-col">
          <MessageList key={channelId} channelId={channelId} ctx={ctx} highlightId={highlightId} editingId={editingId} setEditing={setEditing} bottomRef={toEnd} />
        </div>
        <div className="shrink-0 px-4 pb-4">
          <TypingLine channelId={channelId} threadId={null} />
          {!member && !channel.archivedAt ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
              <p className="min-w-0 text-sm text-fg-muted">{t("previewing", { name: title })}</p>
              <Button variant="primary" onClick={join}>
                {t("join")}
              </Button>
            </div>
          ) : (
            <Composer
              key={channelId}
              ref={composer}
              workspaceId={workspaceId}
              channelId={channelId}
              placeholder={direct ? t("placeholderDirect", { name: title }) : t("placeholder", { name: title })}
              disabled={channel.archivedAt ? t("archivedNotice") : !writes ? t("adminsOnlyNotice") : null}
              onEditLast={editLast}
              onSent={() => toEnd.current?.()}
            />
          )}
        </div>
      </div>
      {details && <ChannelDetails workspaceId={workspaceId} channelId={channelId} tab={details} setTab={setDetails} close={() => setDetails(null)} owner={owner} />}
    </div>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <header data-window-controls-clear className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3 max-md:ps-1.5">
      <SidebarOpenButton className="me-1 max-md:me-0" />
      {children}
    </header>
  );
}

function PinnedButton({ channelId, workspaceId, openThread }: { channelId: string; workspaceId: string; openThread: (threadId: string, messageId?: string) => void }) {
  const t = useTranslations("messages");
  const view = useView();
  const [list, setList] = useState<MessageView[] | null>(null);
  const load = () =>
    void call<MessageView[]>("pinned", { channelId }).then(
      (found) => {
        putMessages(found);
        setList(found);
      },
      () => setList([]),
    );
  return (
    <Popover
      align="end"
      className="w-96 max-w-[calc(100vw-2rem)] p-0"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={() => {
            if (!open) load();
            toggle();
          }}
          aria-label={t("pinnedMessages")}
          title={t("pinnedMessages")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <Pin className="h-4 w-4" />
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-[60vh] overflow-y-auto p-1">
          <p className="px-2 py-1.5 text-xs font-medium text-fg-muted">{t("pinnedMessages")}</p>
          {list === null ? (
            <p className="px-2 py-3 text-sm text-fg-faint">{t("loading")}</p>
          ) : list.length === 0 ? (
            <p className="px-2 py-3 text-sm text-fg-faint">{t("noPinned")}</p>
          ) : (
            list.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  close();
                  if (m.threadId && !m.alsoInChannel) openThread(m.threadId, m.id);
                  else window.history.pushState(null, "", messagesPath(workspaceId, { channelId, messageId: m.id }));
                }}
                className="block w-full rounded-md px-2 py-1.5 text-start hover:bg-bg-hover"
              >
                <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                  {m.authorId && <PersonFace s={view} userId={m.authorId} size="xs" presence={false} />}
                  <span className="font-medium text-fg">{view.people.get(m.authorId ?? "")?.name ?? t("someone")}</span>
                  <span>{new Date(m.createdAt).toLocaleDateString()}</span>
                </span>
                <span className="mt-0.5 line-clamp-3 block">
                  <MessageBody body={m.body} workspaceId={workspaceId} />
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </Popover>
  );
}
