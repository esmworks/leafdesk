"use client";

/**
 * The sidebar's chat tab: the person's conversations in place of the page tree, newest first under
 * how recent they are (today, yesterday, …), below a new chat.
 * Deleting one or all is in a ⋯ menu so a stray click doesn't lose a conversation. Several are
 * picked with the box that takes a row's dot on hover (shift-click for a range), or all from the
 * heading's menu (where a touch screen starts); the heading then counts them and deletes them
 * together, after asking.
 */
import { ListChecks, Loader2, MoreHorizontal, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { deleteConversationAction } from "@/app/actions/ai";
import { useIsOffline } from "@/components/offline/offline-context";
import { SelectBox, useSelection } from "@/components/selection";
import { useSidebar } from "@/components/sidebar/sidebar-context";
import { cn, IconButton, MenuItem, Popover } from "@/components/ui";
import { chatPath } from "@/lib/ai-chat";
import { byRecency } from "@/lib/chat-recency";
import { useAnswering } from "./answering";
import { useAiChat } from "./chat-panel";

const NONE: { id: string; answering?: true }[] = [];
/** How often the list is asked again while an answer this tab doesn't follow is on its way. */
const ELSEWHERE_MS = 4_000;

export function ConversationList() {
  const t = useTranslations("ai.chat");
  const router = useRouter();
  const current = useSearchParams().get("c");
  const context = useAiChat()!;
  const { workspaceId, conversations, refreshConversations } = context;
  const offline = useIsOffline();
  const answering = useAnswering();
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
  const elsewhere = !offline && (conversations ?? NONE).some((c) => c.answering && !answering.has(c.id));
  useEffect(() => {
    if (!elsewhere) return;
    const timer = setInterval(() => void refreshConversations(), ELSEWHERE_MS);
    return () => clearInterval(timer);
  }, [elsewhere, refreshConversations]);

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

  // Like a page in the sidebar's tree: a dot where a page has its icon, then the title.
  const row = "flex h-7 w-full items-center gap-0.5 rounded-md ps-1 text-start hover:bg-bg-hover";
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

  return (
    <div className="space-y-px">
      <section aria-labelledby="conversations-heading">
        {selection.some ? (
          <div className="flex h-7 items-center gap-0.5 rounded-md ps-1 pe-1">
            <h2 id="conversations-heading" className="sr-only">
              {t("history")}
            </h2>
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
        ) : (
          <div className="group/heading flex h-7 items-center rounded-md pe-1 hover:bg-bg-hover has-[[data-open]]:bg-bg-hover">
            <h2 id="conversations-heading" className="min-w-0 flex-1 truncate px-2 text-xs font-medium text-fg-muted">
              {t("history")}
            </h2>
            {!!conversations?.length &&
              menu(
                t("actionsFor", { name: t("history") }),
                (close) => (
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
                ),
                onHover,
              )}
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
          <p className="px-2 py-1 text-xs text-fg-faint">{t("noHistory")}</p>
        ) : (
          byRecency(conversations).map((group) => (
            <div key={group.recency} role="group" aria-labelledby={`conversations-${group.recency}`}>
              <h3 id={`conversations-${group.recency}`} className="truncate px-2 pt-2.5 pb-1 text-[11px] font-medium text-fg-faint">
                {t(`when.${group.recency}`)}
              </h3>
              <ul className="space-y-px">
                {group.items.map((c) => {
                  const title = c.title || t("untitled");
                  const picked = selection.isSelected(c.id);
                  return (
                    <li key={c.id} className="group group/heading relative">
                      <Link
                        href={chatPath(workspaceId, c.id)}
                        onClick={closeDrawer}
                        aria-current={c.id === current ? "page" : undefined}
                        title={title}
                        className={cn(row, "pe-8", c.id === current && "bg-bg-active font-medium hover:bg-bg-active", picked && "bg-accent/10 hover:bg-accent/15")}
                      >
                        {/* The dot gives way to the selection box (laid over it, outside the link) on hover. A touch
                            screen keeps the dot until a selection starts (⋯ › Select all). */}
                        <span
                          aria-hidden
                          className={cn(
                            "flex h-6 w-6 shrink-0 items-center justify-center",
                            selection.some ? "opacity-0" : "group-hover:opacity-0 group-has-[input:focus-visible]:opacity-0",
                          )}
                        >
                          {/* Only while an answer is being written for it, fading in and out; the place stays empty otherwise. */}
                          {(answering.has(c.id) || c.answering) && <span className="h-1.5 w-1.5 rounded-full bg-fg motion-safe:animate-pulse" />}
                        </span>
                        <span className="flex-1 truncate ps-0.5">{title}</span>
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
          ))
        )}
      </section>
    </div>
  );
}
