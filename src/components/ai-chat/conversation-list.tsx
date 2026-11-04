"use client";

/**
 * The sidebar's chat tab: the person's conversations in place of the page tree, newest first under
 * how recent they are (today, yesterday, …), below a new chat.
 * Deleting one or all is in a ⋯ menu so a stray click doesn't lose a conversation. Several are
 * picked with the box that takes a row's dot on hover (shift-click for a range), or all from the
 * heading's menu (where a touch screen starts); the heading then counts them and deletes them
 * together, after asking. A dot says when an answer is being written in one, waits for the
 * person's decision, or came while they were away (lib/chat-status.ts).
 */
import { ListChecks, Loader2, MessageSquare, MoreHorizontal, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { deleteConversationAction } from "@/app/actions/ai";
import { useIsOffline } from "@/components/offline/offline-context";
import { SelectBox, useSelection } from "@/components/selection";
import { panelHeading, PanelEmpty, panelRowActive, panelSection } from "@/components/sidebar/panel";
import { useSidebar } from "@/components/sidebar/sidebar-context";
import { cn, IconButton, MenuItem, Popover } from "@/components/ui";
import { chatPath } from "@/lib/ai-chat";
import { byRecency } from "@/lib/chat-recency";
import { conversationStatus } from "@/lib/chat-status";
import { useAnswering, useWaiting } from "./answering";
import { useAiChat } from "./chat-panel";
import { StatusDot, StatusLabel } from "./status-dot";

const NONE: { id: string; answering?: true; waiting?: true }[] = [];
/** How often the list is asked again while an answer this tab doesn't follow is on its way. */
const ELSEWHERE_MS = 4_000;
/** How often while one this tab doesn't follow waits for a decision (maybe made in another tab). */
const WAITING_ELSEWHERE_MS = 30_000;

/**
 * The sidebar's Chat tab: the person's conversations by recency (lib/chat-recency.ts), each with
 * its status, selected together from the list's ⋯, which sits in the panel's head (`actionsSlot`,
 * an element sidebar.tsx renders there) beside New chat.
 */
export function ConversationList({ actionsSlot }: { actionsSlot?: HTMLElement | null }) {
  const t = useTranslations("ai.chat");
  const router = useRouter();
  const current = useSearchParams().get("c");
  const context = useAiChat()!;
  const { workspaceId, conversations, refreshConversations, shownConversation } = context;
  const offline = useIsOffline();
  const answering = useAnswering();
  const waiting = useWaiting();
  // On a phone the list is a drawer over the chat; only the address's `?c=` changes, so the drawer
  // (which closes when the path does) is closed here.
  const closeDrawer = useSidebar()?.close;
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const selection = useSelection(conversations ?? NONE);

  useEffect(() => {
    if (!offline) void refreshConversations();
  }, [offline, refreshConversations]);
  // Answers this tab doesn't follow (asked before a reload, in another tab, or left on the server
  // when the person moved on): the list is asked again now and then until they're done.
  const elsewhere = offline ? null : (conversations ?? NONE).some((c) => c.answering && !answering.has(c.id)) ? ELSEWHERE_MS : (conversations ?? NONE).some((c) => c.waiting && !answering.has(c.id)) ? WAITING_ELSEWHERE_MS : null;
  useEffect(() => {
    if (!elsewhere) return;
    const timer = setInterval(() => void refreshConversations(), elsewhere);
    return () => clearInterval(timer);
  }, [elsewhere, refreshConversations]);
  // Back in the tab: answers that came, or were decided, meanwhile.
  useEffect(() => {
    if (offline) return;
    const back = () => {
      if (document.visibilityState === "visible") void refreshConversations();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [offline, refreshConversations]);

  /** Deletes conversations; one from its own menu goes at once, more (or all) after asking. */
  async function remove(ids: string[] | "all", ask: boolean) {
    if (ask && !confirm(ids === "all" ? t("confirmDeleteAll") : t("confirmDeleteSelected", { count: ids.length }))) return;
    setBusy(true);
    const result = await deleteConversationAction(workspaceId, ids).finally(() => setBusy(false));
    setFailed(!result.ok);
    if (!result.ok) return;
    // A selection outlives deleting one conversation from its own menu (the hook drops that one).
    if (ask) selection.clear();
    // The page follows the address: the conversation it showed is gone.
    if (ids === "all" || (current && ids.includes(current))) router.replace(chatPath(workspaceId));
    await refreshConversations();
  }

  // Like a page in the sidebar's tree: an icon in a 24 px box (the selection box takes its place), then the title.
  const row = "flex h-7 w-full items-center gap-0.5 rounded-md ps-1 pe-8 text-start text-sm hover:bg-bg-hover";
  /** A ⋯ button opening a menu: two clicks, so nothing goes by accident. */
  const menu = (label: string, items: (close: () => void) => ReactNode, className: string) => (
    <span className={cn("flex", className)}>
      <Popover
        align="end"
        trigger={({ open, toggle }) => (
          <IconButton label={label} aria-expanded={open} onClick={toggle} disabled={offline} className={cn("h-7 w-7 rounded-md", open && "bg-bg-active text-fg")}>
            <MoreHorizontal className="h-4 w-4" />
          </IconButton>
        )}
      >
        {items}
      </Popover>
    </span>
  );
  const deleteItem = (close: () => void, item: string, onDelete: () => void) => (
    <MenuItem
      danger
      icon={<Trash2 className="h-4 w-4" />}
      onClick={() => {
        close();
        onDelete();
      }}
    >
      {item}
    </MenuItem>
  );
  // Shown on hover, and while its menu is open.
  const onHover = "opacity-0 group-hover/heading:opacity-100 focus-within:opacity-100 has-[[data-open]]:opacity-100 pointer-coarse:opacity-100";
  // The list's own actions, in the panel's head while nothing is selected.
  const listActions =
    actionsSlot && !selection.some && !!conversations?.length
      ? createPortal(
          menu(t("actionsFor", { name: t("history") }), (close) => (
            <>
              <MenuItem
                icon={<ListChecks className="h-4 w-4" />}
                onClick={() => {
                  close();
                  selection.toggleAll();
                }}
              >
                {t("selectAll")}
              </MenuItem>
              {deleteItem(close, t("deleteAll"), () => void remove("all", true))}
            </>
          ), ""),
          actionsSlot,
        )
      : null;

  return (
    <section aria-labelledby="conversations-heading">
      <h2 id="conversations-heading" className="sr-only">
        {t("history")}
      </h2>
      {listActions}
      {selection.some && (
        <div className="mb-1 flex h-7 items-center gap-0.5 rounded-md ps-1 pe-1">
          <SelectBox
            checked={selection.all}
            indeterminate={!selection.all}
            label={t("selectAll")}
            visible
            onToggle={selection.toggleAll}
          />
          <span aria-live="polite" className="min-w-0 flex-1 truncate ps-0.5 text-xs font-medium">
            {t("selectedCount", { count: selection.ids.length })}
          </span>
          <IconButton
            label={t("deleteSelected")}
            disabled={offline || busy}
            onClick={() => void remove(selection.ids, true)}
            className="h-7 w-7 rounded-md hover:text-danger disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </IconButton>
          <IconButton label={t("clearSelection")} onClick={selection.clear} className="h-7 w-7 rounded-md">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      )}
      {failed && (
        <p role="alert" className="px-2 py-1 text-xs text-danger">
          {t("deleteFailed")}
        </p>
      )}
      {conversations === null ? (
        !offline && <Loader2 className="mx-2 mt-2 h-3.5 w-3.5 animate-spin text-fg-muted" aria-hidden />
      ) : conversations.length === 0 ? (
        <PanelEmpty>{t("noHistory")}</PanelEmpty>
      ) : (
        <div>
          {byRecency(conversations).map((group) => (
            <div key={group.recency} role="group" aria-labelledby={`conversations-${group.recency}`} className={cn(panelSection, "first:mt-0")}>
              <h3 id={`conversations-${group.recency}`} className={cn(panelHeading, "truncate")}>
                {t(`when.${group.recency}`)}
              </h3>
              <ul className="space-y-px">
                {group.items.map((c) => {
                  const title = c.title || t("untitled");
                  const picked = selection.isSelected(c.id);
                  const status = conversationStatus(c, { answering: answering.has(c.id), waiting: waiting.has(c.id) }, c.id === shownConversation);
                  return (
                    <li key={c.id} className="group group/heading relative">
                      <Link
                        href={chatPath(workspaceId, c.id)}
                        onClick={closeDrawer}
                        aria-current={c.id === current ? "page" : undefined}
                        title={title}
                        className={cn(row, c.id === current && panelRowActive, picked && "bg-accent/10 hover:bg-accent/15")}
                      >
                        {/* The icon gives way to the selection box (laid over it, outside the link) on hover. A touch
                            screen keeps the icon until a selection starts (⋯ › Select all). */}
                        <span
                          aria-hidden
                          className={cn(
                            "flex h-6 w-6 shrink-0 items-center justify-center text-fg-icon",
                            selection.some ? "opacity-0" : "group-hover:opacity-0 group-has-[input:focus-visible]:opacity-0",
                          )}
                        >
                          <MessageSquare className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1 truncate ps-0.5">
                          {title}
                          <StatusLabel status={status} />
                        </span>
                        {/* Only while something goes on in it, or an answer waits to be read. */}
                        <StatusDot status={status} />
                      </Link>
                      <span className={cn("absolute inset-y-0 inset-s-1 flex items-center", !selection.some && "pointer-coarse:hidden")}>
                        <SelectBox
                          checked={picked}
                          label={t("selectConversation", { name: title })}
                          visible={selection.some}
                          onToggle={(range) => selection.toggle(c.id, range)}
                        />
                      </span>
                      {menu(
                        t("actionsFor", { name: title }),
                        (close) => deleteItem(close, t("deleteConversation"), () => void remove([c.id], false)),
                        cn("absolute top-0 inset-e-0", onHover),
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
