"use client";

/**
 * The sidebar of the full-page chat: the person's conversations in place of the page tree, newest
 * first. The way back to the pages and a new chat are above it, where Home is on other pages.
 * Deleting, one or all, is in a ⋯ menu so a stray click doesn't lose a conversation.
 */
import { Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { deleteConversationAction } from "@/app/actions/ai";
import { useIsOffline } from "@/components/offline/offline-context";
import { useSidebar } from "@/components/sidebar/sidebar-context";
import { cn, IconButton, MenuItem, Popover } from "@/components/ui";
import { chatPath } from "@/lib/ai-chat";
import { useAiChat } from "./chat-panel";

export function ConversationList() {
  const t = useTranslations("ai.chat");
  const router = useRouter();
  const current = useSearchParams().get("c");
  const context = useAiChat()!;
  const { workspaceId, conversations, refreshConversations } = context;
  const offline = useIsOffline();
  // On a phone the list is a drawer over the chat; only the address's `?c=` changes, so the drawer
  // (which closes when the path does) is closed here.
  const closeDrawer = useSidebar()?.close;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!offline) void refreshConversations();
  }, [offline, refreshConversations]);

  async function remove(id: string | "all") {
    if (id === "all" && !confirm(t("confirmDeleteAll"))) return;
    const result = await deleteConversationAction(workspaceId, id);
    setFailed(!result.ok);
    if (!result.ok) return;
    // The page follows the address: the conversation it showed is gone.
    if (id === "all" || id === current) router.replace(chatPath(workspaceId));
    await refreshConversations();
  }

  const row = "flex h-7 w-full items-center gap-2 rounded-md px-2 text-start text-fg-muted hover:bg-bg-hover hover:text-fg";
  /** A ⋯ button opening a menu with one destructive item: two clicks, so nothing goes by accident. */
  const deleteMenu = (label: string, item: string, onDelete: () => void, className: string) => (
    <span className={cn("flex", className)}>
      <Popover
        align="end"
        trigger={({ open, toggle }) => (
          <IconButton label={label} aria-expanded={open} onClick={toggle} disabled={offline} className={cn("h-7 w-7 rounded-md", open && "bg-bg-active text-fg")}>
            <MoreHorizontal className="h-4 w-4" />
          </IconButton>
        )}
      >
        {(close) => (
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
        )}
      </Popover>
    </span>
  );
  // Shown on hover, and while its menu is open.
  const onHover = "opacity-0 group-hover/heading:opacity-100 focus-within:opacity-100 has-[[data-open]]:opacity-100 pointer-coarse:opacity-100";

  return (
    <div className="space-y-px">
      <section aria-labelledby="conversations-heading">
        <div className="group/heading flex h-7 items-center rounded-md pe-1 hover:bg-bg-hover has-[[data-open]]:bg-bg-hover">
          <h2 id="conversations-heading" className="min-w-0 flex-1 truncate px-2 text-xs font-medium text-fg-muted">
            {t("history")}
          </h2>
          {!!conversations?.length && deleteMenu(t("actionsFor", { name: t("history") }), t("deleteAll"), () => void remove("all"), onHover)}
        </div>
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
          <ul className="space-y-px">
            {conversations.map((c) => (
              <li key={c.id} className="group/heading relative">
                <Link
                  href={chatPath(workspaceId, c.id)}
                  onClick={closeDrawer}
                  aria-current={c.id === current ? "page" : undefined}
                  title={c.title || t("untitled")}
                  className={cn(row, "pe-8", c.id === current && "bg-bg-active font-medium text-fg hover:bg-bg-active")}
                >
                  <span className="flex-1 truncate">{c.title || t("untitled")}</span>
                </Link>
                {deleteMenu(t("actionsFor", { name: c.title || t("untitled") }), t("deleteConversation"), () => void remove(c.id), cn("absolute top-0 inset-e-0", onHover))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
