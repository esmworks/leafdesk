"use client";

/**
 * The full-page AI chat (/w/[id]/ai, the sidebar's "Ask AI"): one conversation across the page,
 * `?c=` naming it, while the sidebar lists the person's conversations (ConversationList). A source
 * opens its page with the conversation carried on in the panel beside it.
 */
import { SquarePen } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { useIsOffline } from "@/components/offline/offline-context";
import { SidebarOpenButton } from "@/components/sidebar/sidebar-context";
import { IconButton } from "@/components/ui";
import { chatPath, sourceHref, type ChatSourceView } from "@/lib/ai-chat";
import { useAiChat } from "./chat-panel";
import { ChatThread } from "./chat-thread";
import { useChat } from "./use-chat";

export function ChatPage({ workspaceId, available }: { workspaceId: string; available: boolean }) {
  const t = useTranslations("ai.chat");
  const router = useRouter();
  const requested = useSearchParams().get("c");
  const context = useAiChat();
  const offline = useIsOffline();
  // The conversation the page shows (or null: a new chat), as far as the address is concerned.
  const shown = useRef<string | null | undefined>(undefined);
  const chat = useChat(workspaceId, {
    onConversation: (id) => {
      shown.current = id;
      // Without a navigation: the answer is still streaming in.
      window.history.replaceState(null, "", chatPath(workspaceId, id));
      // A new conversation shows in the sidebar's list right away, not when it's answered.
      if (id) void context?.refreshConversations();
    },
    onAnswered: () => void context?.refreshConversations(),
  });
  const { conversationId, openConversation, newChat } = chat;
  const blocked = offline ? t("offline") : !available ? t("disabled") : null;
  const title = context?.conversations?.find((c) => c.id === conversationId)?.title;

  // Follows the address: a conversation picked in the sidebar, or a new chat.
  useEffect(() => {
    if (requested === shown.current) return;
    shown.current = requested;
    if (!requested) {
      newChat();
      return;
    }
    // One that can't be opened (deleted, or not theirs) leaves a new chat, its error kept in view.
    void openConversation(requested).then((ok) => {
      if (ok || shown.current !== requested) return;
      shown.current = null;
      window.history.replaceState(null, "", chatPath(workspaceId));
    });
    // openConversation and newChat change every render; the address is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, workspaceId]);

  function openSource(source: ChatSourceView) {
    const href = sourceHref(source);
    if (!href) return;
    router.push(href);
    // Beside the page, the conversation goes on; a phone has no room for both.
    if (!window.matchMedia("(max-width: 767px)").matches) context?.openPanel(conversationId);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 px-3 max-md:pl-1.5">
        <SidebarOpenButton className="mr-1 max-md:mr-0" />
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title || t("title")}</h1>
        <IconButton label={t("newChat")} className="h-7 w-7" onClick={() => router.push(chatPath(workspaceId))} disabled={!chat.messages.length && !conversationId}>
          <SquarePen className="h-4 w-4" />
        </IconButton>
      </div>
      <ChatThread chat={chat} blocked={blocked} onSend={(again) => void chat.send(null, again)} onSource={openSource} variant="page" />
    </div>
  );
}
