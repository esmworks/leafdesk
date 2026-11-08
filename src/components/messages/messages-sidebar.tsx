"use client";

import { AtSign, Bookmark, ChevronRight, Hash, Lock, MessagesSquare, SendHorizontal } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { PanelEmpty, panelHeading, panelIcon, panelMeta, panelRow, panelRowActive, panelSection } from "@/components/sidebar/panel";
import { useSidebar } from "@/components/sidebar/sidebar-context";
import { cn } from "@/components/ui";
import { messagesAt, messagesPath } from "@/lib/messages";
import type { ChannelView, MembershipView } from "@/lib/message-wire";
import { PersonFace } from "./person";
import { channelTitle, holdConnection, unreadOf, useMessages, type MessagesState } from "./store";

/**
 * The Messages tab's panel: the places of Messages (threads, mentions and reactions, saved,
 * drafts), then the person's channels and direct conversations by section (starred, their own
 * sections, channels, direct messages), unread ones in the text's color and weight, mentions
 * counted. A click moves within the Messages page without a round trip (stayInMessages).
 */

const FOLDED_KEY = "leafdesk:messages-folded";

function loadFolded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** A link's click within the Messages page: only the address changes. */
export function stayInMessages(e: React.MouseEvent, href: string) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  if (new URL(href, window.location.href).pathname !== window.location.pathname) return;
  e.preventDefault();
  window.history.pushState(null, "", href);
}

type Row = { channel: ChannelView; member: MembershipView; title: string; unread: number };

export function MessagesSidebar({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("messages");
  const sidebar = useSidebar();
  const params = useSearchParams();
  const at = messagesAt(params);
  useEffect(() => holdConnection(workspaceId), [workspaceId]);
  const s = useMessages((x) => x);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  useEffect(() => setFolded(loadFolded()), []);
  const fold = (key: string) => {
    const next = new Set(folded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFolded(next);
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
    } catch {}
  };

  const rows = useMemo(() => listRows(s, { you: t("you"), someone: t("someone") }), [s, t]);
  const onPick = (e: React.MouseEvent, href: string) => {
    stayInMessages(e, href);
    sidebar?.close();
  };

  if (s.workspaceId !== workspaceId || !s.ready) {
    return s.status === "closed" ? <PanelEmpty className="px-2">{t("closed")}</PanelEmpty> : <PanelEmpty className="px-2">{t("loading")}</PanelEmpty>;
  }

  const threadMentions = [...s.threads.values()].reduce((n, x) => n + x.mentions, 0);
  const threadsUnread = [...s.threads.values()].some((x) => x.following && unreadThread(s, x.threadId));
  const drafts = s.drafts.size + s.scheduled.size;
  const savedOpen = [...s.saved.values()].filter((x) => !x.doneAt).length;

  const place = (key: "threads" | "activity" | "saved" | "drafts", Icon: typeof Hash, label: string, meta?: React.ReactNode, bold?: boolean) => {
    const href = messagesPath(workspaceId, { view: key });
    const active = at.view === key;
    return (
      <Link key={key} href={href} onClick={(e) => onPick(e, href)} aria-current={active ? "page" : undefined} className={cn(panelRow, active && panelRowActive)}>
        <Icon className={panelIcon} />
        <span className={cn("min-w-0 flex-1 truncate", bold && "font-medium text-fg")}>{label}</span>
        {meta}
      </Link>
    );
  };

  const starred = rows.filter((r) => r.member.starred);
  const bySection = new Map<string, Row[]>();
  for (const r of rows) if (!r.member.starred && r.member.sectionId && s.sections.has(r.member.sectionId)) bySection.set(r.member.sectionId, [...(bySection.get(r.member.sectionId) ?? []), r]);
  const rest = rows.filter((r) => !r.member.starred && !(r.member.sectionId && s.sections.has(r.member.sectionId)));
  const channels = rest.filter((r) => r.channel.kind !== "direct");
  const directs = rest.filter((r) => r.channel.kind === "direct");
  const sections = [...s.sections.values()].sort((a, b) => a.position - b.position);

  const block = (key: string, title: string, list: Row[], empty?: React.ReactNode) => {
    const closed = folded.has(key);
    // A folded block still shows what is unread in it.
    const shown = closed ? list.filter((r) => r.unread > 0 || r.member.mentions > 0 || r.channel.id === at.channelId) : list;
    return (
      <div key={key} className={panelSection}>
        <button type="button" onClick={() => fold(key)} aria-expanded={!closed} className={cn(panelHeading, "group w-full gap-1 rounded-md hover:bg-bg-hover max-md:h-9")}>
          <span className="truncate">{title}</span>
          <ChevronRight className={cn("h-3 w-3 shrink-0 opacity-0 transition-transform group-hover:opacity-100", !closed && "rotate-90")} />
        </button>
        {shown.map((r) => (
          <ChannelRow key={r.channel.id} workspaceId={workspaceId} row={r} active={r.channel.id === at.channelId && !at.view} s={s} onPick={onPick} />
        ))}
        {!closed && !list.length && empty}
      </div>
    );
  };

  return (
    <nav aria-label={t("title")} className="pb-3">
      {s.status === "offline" && <p className="px-2 pb-1 text-xs text-fg-faint">{t("reconnecting")}</p>}
      {place("threads", MessagesSquare, t("views.threads"), threadMentions > 0 ? <span className={panelMeta}>{threadMentions}</span> : null, threadsUnread)}
      {place("activity", AtSign, t("views.activity"))}
      {place("saved", Bookmark, t("views.saved"), savedOpen > 0 ? <span className={panelMeta}>{savedOpen}</span> : null)}
      {place("drafts", SendHorizontal, t("views.drafts"), drafts > 0 ? <span className={panelMeta}>{drafts}</span> : null)}
      {starred.length > 0 && block("starred", t("sections.starred"), starred)}
      {sections.map((x) => block(`section:${x.id}`, x.name, bySection.get(x.id) ?? []))}
      {block("channels", t("sections.channels"), channels, <PanelEmpty className="px-2">{t("noChannels")}</PanelEmpty>)}
      {block("direct", t("sections.direct"), directs, <PanelEmpty className="px-2">{t("noDirect")}</PanelEmpty>)}
    </nav>
  );
}

/** Whether a thread has replies the person hasn't read. */
export function unreadThread(s: MessagesState, threadId: string) {
  const root = s.messages.get(threadId);
  const t = s.threads.get(threadId);
  return !!root && !!t && root.lastReplySeq > t.lastReadSeq;
}

/** The person's channels and direct conversations, by name, hidden ones left out unless unread. */
export function listRows(s: MessagesState, words: { you: string; someone: string }): Row[] {
  const rows: Row[] = [];
  for (const [id, member] of s.memberships) {
    const channel = s.channels.get(id);
    if (!channel) continue;
    const unread = unreadOf(s, id);
    if (member.hidden && !unread && !member.mentions) continue;
    if (channel.archivedAt && !unread) continue;
    rows.push({ channel, member, title: channelTitle(s, channel, words), unread });
  }
  // Direct conversations by their latest message, channels by name.
  return rows.sort((a, b) =>
    a.channel.kind === "direct" && b.channel.kind === "direct" ? (b.channel.lastMessageAt ?? "").localeCompare(a.channel.lastMessageAt ?? "") : a.title.localeCompare(b.title),
  );
}

function ChannelRow({ workspaceId, row, active, s, onPick }: { workspaceId: string; row: Row; active: boolean; s: MessagesState; onPick: (e: React.MouseEvent, href: string) => void }) {
  const t = useTranslations("messages");
  const { channel, member, title, unread } = row;
  const href = messagesPath(workspaceId, { channelId: channel.id });
  const lit = unread > 0 && !member.muted;
  const others = channel.people.filter((id) => id !== s.me);
  const draft = s.drafts.has(`${channel.id}\n`);
  return (
    <Link
      href={href}
      onClick={(e) => onPick(e, href)}
      aria-current={active ? "page" : undefined}
      className={cn(panelRow, active && panelRowActive, member.muted && !active && "text-fg-faint")}
    >
      {channel.kind === "direct" ? (
        <PersonFace s={s} userId={others[0] ?? s.me} size="xs" count={others.length > 1 ? others.length : undefined} />
      ) : channel.kind === "private" ? (
        <Lock className={panelIcon} />
      ) : (
        <Hash className={panelIcon} />
      )}
      <span className={cn("min-w-0 flex-1 truncate", lit && "font-semibold text-fg")}>{title}</span>
      {draft && !active && <span className={cn(panelMeta, "sr-only")}>{t("hasDraft")}</span>}
      {member.mentions > 0 || (channel.kind === "direct" && unread > 0 && !member.muted) ? (
        <span aria-label={t("mentionCount", { count: Math.max(member.mentions, channel.kind === "direct" ? unread : 0) })} className="min-w-4 rounded-full bg-danger px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums">
          {Math.max(member.mentions, channel.kind === "direct" ? unread : 0)}
        </span>
      ) : null}
    </Link>
  );
}
