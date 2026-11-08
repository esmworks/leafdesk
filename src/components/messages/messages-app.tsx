"use client";

import { Hash, Loader2, MessagesSquare } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { lazyPart } from "@/components/lazy-part";
import { PlaceTopBar } from "@/components/place-top-bar";
import { Button } from "@/components/ui";
import { messagesAt, messagesPath } from "@/lib/messages";
import { ChannelView } from "./channel-view";
import { MessageBody } from "./message-body";
import type { ItemContext } from "./message-item";
import { listRows } from "./messages-sidebar";
import { call, holdConnection, messagesState, unreadSummary, useMessages } from "./store";

// What opens now and then loads when it first shows, keeping the page's first load to a channel.
const CreateChannelDialog = lazyPart(() => import("./channel-dialogs").then((m) => m.CreateChannelDialog));
const NewDirectDialog = lazyPart(() => import("./channel-dialogs").then((m) => m.NewDirectDialog));
const ForwardDialog = lazyPart(() => import("./channel-dialogs").then((m) => m.ForwardDialog));
const BrowseChannels = lazyPart(() => import("./channel-dialogs").then((m) => m.BrowseChannels));
const MessagesViewPage = lazyPart(() => import("./message-views").then((m) => m.MessagesViewPage));
const Switcher = lazyPart(() => import("./switcher").then((m) => m.Switcher));
const ThreadPanel = lazyPart(() => import("./thread-panel").then((m) => m.ThreadPanel), <div className="w-full shrink-0 border-border md:w-[26rem] md:border-s" />);

const LAST_KEY = "leafdesk:messages-last";

function remembered(workspaceId: string): string | null {
  try {
    return (JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Record<string, string>)[workspaceId] ?? null;
  } catch {
    return null;
  }
}

function remember(workspaceId: string, channelId: string) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Record<string, string>;
    all[workspaceId] = channelId;
    localStorage.setItem(LAST_KEY, JSON.stringify(all));
  } catch {}
}

const go = (href: string, replace = false) => (replace ? window.history.replaceState(null, "", href) : window.history.pushState(null, "", href));

/** Events other parts of the workspace send the Messages page (the sidebar's head, the search box's commands). */
export const MESSAGES_COMMAND = "leafdesk:messages-command";
export type MessagesCommand = "newChannel" | "newDirect" | "switch";

/**
 * The Messages place: one channel or conversation with its thread beside it, or one of the other
 * views (threads, activity, saved, drafts, search, browsing channels). Everything is in the query
 * (lib/messages.ts `messagesPath`), moved with `history.pushState`, so going between channels never
 * waits for the server; the store (store.ts) has what the socket brought.
 */
export function MessagesApp({ workspaceId, owner, ai }: { workspaceId: string; owner: boolean; /** The workspace has AI (catch up). */ ai: boolean }) {
  const t = useTranslations("messages");
  const params = useSearchParams();
  const at = messagesAt(params);
  const ready = useMessages((s) => s.ready && s.workspaceId === workspaceId);
  const status = useMessages((s) => s.status);
  const closedReason = useMessages((s) => s.closedReason);
  const [forwarding, setForwarding] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [directing, setDirecting] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => holdConnection(workspaceId), [workspaceId]);
  // Messages' Markdown loads beside the socket, so it is there when they come.
  useEffect(() => void MessageBody.preload(), []);

  // Nothing asked for: the conversation open last, else the first one listed.
  useEffect(() => {
    if (!ready || at.channelId || at.view) return;
    const s = messagesState();
    const last = remembered(workspaceId);
    const pick = last && s.memberships.has(last) ? last : listRows(s, { you: "", someone: "" })[0]?.channel.id;
    if (pick) go(messagesPath(workspaceId, { channelId: pick }), true);
  }, [ready, at.channelId, at.view, workspaceId]);
  useEffect(() => {
    if (at.channelId) remember(workspaceId, at.channelId);
  }, [at.channelId, workspaceId]);

  // The tab's title counts what waits for the person.
  const unread = useMessages((s) => unreadSummary(s).count);
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = unread ? `(${unread}) ${base}` : base;
    return () => {
      document.title = document.title.replace(/^\(\d+\) /, "");
    };
  }, [unread]);

  const openThread = useCallback(
    (threadId: string, messageId?: string) => {
      const m = messagesState().messages.get(threadId);
      go(messagesPath(workspaceId, { channelId: m?.channelId ?? at.channelId, threadId, messageId: messageId ?? null }));
    },
    [workspaceId, at.channelId],
  );
  const closeThread = useCallback(() => go(messagesPath(workspaceId, { channelId: at.channelId })), [workspaceId, at.channelId]);

  // Commands from outside the page, and the page's own keys.
  useEffect(() => {
    const onCommand = (e: Event) => {
      const command = (e as CustomEvent<MessagesCommand>).detail;
      if (command === "newChannel") setCreating(true);
      else if (command === "newDirect") setDirecting(true);
      else if (command === "switch") setSwitching(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = e.metaKey || e.ctrlKey;
      // Mod+Shift+K: jump to a conversation.
      if (mod && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitching(true);
        return;
      }
      // Alt+↑/↓: the conversation before or after in the list; with Shift, the unread ones only.
      if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const s = messagesState();
        const rows = listRows(s, { you: "", someone: "" }).filter((r) => !e.shiftKey || r.unread > 0 || r.member.mentions > 0 || r.channel.id === at.channelId);
        const here = rows.findIndex((r) => r.channel.id === at.channelId);
        const next = rows[(here + (e.key === "ArrowDown" ? 1 : rows.length - 1) + rows.length) % rows.length];
        if (next && next.channel.id !== at.channelId) {
          e.preventDefault();
          go(messagesPath(workspaceId, { channelId: next.channel.id }));
        }
        return;
      }
      // Shift+Esc: everything read.
      if (e.key === "Escape" && e.shiftKey && !mod) {
        e.preventDefault();
        void call("readAll").catch(() => {});
      }
    };
    window.addEventListener(MESSAGES_COMMAND, onCommand);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(MESSAGES_COMMAND, onCommand);
      window.removeEventListener("keydown", onKey);
    };
  }, [at.channelId, workspaceId]);

  const forward = useCallback((id: string) => setForwarding(id), []);
  const threadCtx = useThreadContext(workspaceId, at.threadId ?? null, owner, openThread, forward);

  const dialogs = (
    <>
      <CreateChannelDialog workspaceId={workspaceId} open={creating} close={() => setCreating(false)} />
      <NewDirectDialog workspaceId={workspaceId} open={directing} close={() => setDirecting(false)} />
      <ForwardDialog workspaceId={workspaceId} messageId={forwarding} close={() => setForwarding(null)} />
      {switching && <Switcher workspaceId={workspaceId} close={() => setSwitching(false)} />}
    </>
  );

  if (closedReason) {
    return (
      <Shell title={t("title")}>
        <p className="mx-auto max-w-md px-6 py-20 text-center text-sm text-fg-muted">{t(`closedReason.${closedReason}`)}</p>
      </Shell>
    );
  }
  if (!ready) {
    return (
      <Shell title={t("title")}>
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-faint">
          <Loader2 className="h-4 w-4 animate-spin" />
          {status === "offline" ? t("reconnecting") : t("loading")}
        </div>
      </Shell>
    );
  }

  if (at.view === "browse") {
    return (
      <Shell title={t("views.browse")}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <BrowseChannels workspaceId={workspaceId} create={() => setCreating(true)} />
        </div>
        {dialogs}
      </Shell>
    );
  }
  if (at.view) {
    return (
      <Shell title={t(`views.${at.view}`)}>
        <MessagesViewPage view={at.view} workspaceId={workspaceId} query={at.query ?? ""} forward={forward} owner={owner} />
        {dialogs}
      </Shell>
    );
  }
  if (!at.channelId) {
    return (
      <Shell title={t("title")}>
        <div className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center px-6 py-16 text-center">
          <MessagesSquare className="h-8 w-8 text-fg-icon" />
          <h1 className="mt-3 text-lg font-semibold text-fg">{t("emptyTitle")}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t("emptyText")}</p>
          <div className="mt-5 flex gap-2">
            <Button variant="secondary" onClick={() => go(messagesPath(workspaceId, { view: "browse" }))}>
              <Hash className="h-4 w-4" />
              {t("browseChannels")}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t("newChannel")}
            </Button>
          </div>
        </div>
        {dialogs}
      </Shell>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className={at.threadId ? "flex min-h-0 min-w-0 flex-1 max-md:hidden" : "flex min-h-0 min-w-0 flex-1"}>
        <ChannelView workspaceId={workspaceId} channelId={at.channelId} highlightId={at.threadId ? null : at.messageId ?? null} openThread={openThread} forward={forward} owner={owner} ai={ai} />
      </div>
      {at.threadId && <ThreadPanel key={at.threadId} threadId={at.threadId} ctx={threadCtx} close={closeThread} highlightId={at.messageId ?? null} ai={ai} />}
      {dialogs}
    </div>
  );
}

/** What messages in an open thread may do: as in its channel. */
function useThreadContext(workspaceId: string, threadId: string | null, owner: boolean, openThread: ItemContext["openThread"], forward: (id: string) => void): ItemContext {
  const root = useMessages((s) => (threadId ? s.messages.get(threadId) : undefined));
  const channel = useMessages((s) => (root ? s.channels.get(root.channelId) : undefined));
  const member = useMessages((s) => (root ? s.memberships.get(root.channelId) : undefined));
  const writes = !!member && !!channel && !channel.archivedAt;
  return useMemo(() => ({ workspaceId, openThread, forward, moderates: owner || member?.role === "admin", writes }), [workspaceId, openThread, forward, owner, member?.role, writes]);
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PlaceTopBar icon={<MessagesSquare />} title={title} />
      {children}
    </div>
  );
}
