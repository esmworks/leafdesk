"use client";

/**
 * The sidebar of the full-page chat: the person's conversations in place of the page tree, by when
 * they were last added to, with the way back to the pages and to a new chat.
 */
import { ArrowLeft, Loader2, SquarePen, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { deleteConversationAction } from "@/app/actions/ai";
import { useIsOffline } from "@/components/offline/offline-context";
import { useSidebar } from "@/components/sidebar/sidebar-context";
import { cn, IconButton } from "@/components/ui";
import { chatPath, groupConversations } from "@/lib/ai-chat";
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
  return (
    <div className="space-y-px">
      <Link href={context.backPath()} className={row}>
        <ArrowLeft className="h-4 w-4 shrink-0 rtl:-scale-x-100" />
        <span className="flex-1 truncate">{t("backToPages")}</span>
      </Link>
      <Link href={chatPath(workspaceId)} onClick={closeDrawer} className={cn(row, !current && "bg-bg-active font-medium text-fg hover:bg-bg-active")}>
        <SquarePen className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">{t("newChat")}</span>
      </Link>

      {failed && (
        <p role="alert" className="px-2 pt-2 text-xs text-danger">
          {t("deleteFailed")}
        </p>
      )}
      {conversations === null ? (
        !offline && <Loader2 className="mx-2 mt-3 h-3.5 w-3.5 animate-spin text-fg-muted" aria-hidden />
      ) : conversations.length === 0 ? (
        <p className="px-2 pt-3 text-fg-muted">{t("noHistory")}</p>
      ) : (
        <>
          {groupConversations(conversations, new Date()).map(({ group, conversations: list }) => (
            <section key={group} aria-label={t(`groups.${group}`)} className="pt-3">
              <h3 className="px-2 pb-0.5 text-xs font-medium text-fg-faint">{t(`groups.${group}`)}</h3>
              <ul className="space-y-px">
                {list.map((c) => (
                  <li key={c.id} className="group/conversation relative">
                    <Link
                      href={chatPath(workspaceId, c.id)}
                      onClick={closeDrawer}
                      aria-current={c.id === current ? "page" : undefined}
                      title={c.title || t("untitled")}
                      className={cn(row, "pe-8", c.id === current && "bg-bg-active font-medium text-fg hover:bg-bg-active")}
                    >
                      <span className="flex-1 truncate">{c.title || t("untitled")}</span>
                    </Link>
                    <IconButton
                      label={t("deleteConversation")}
                      className="absolute top-0 inset-e-0 h-7 w-7 opacity-0 group-hover/conversation:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60"
                      disabled={offline}
                      onClick={() => void remove(c.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <div className="pt-3">
            <button type="button" className={cn(row, "hover:text-danger disabled:opacity-50")} disabled={offline} onClick={() => void remove("all")}>
              <Trash2 className="h-4 w-4 shrink-0" />
              <span className="flex-1 truncate">{t("deleteAll")}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
