"use client";

/**
 * The full-page AI chat (/w/[id]/ai, the sidebar's "Ask AI"): one conversation across the page,
 * `?c=` naming it, while the sidebar lists the person's conversations (ConversationList). A source
 * opens in the row panel beside the conversation; a database, or any source on a phone, opens as
 * its page, the conversation carried on in the chat panel beside it.
 */
import { SquarePen } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRowPanel } from "@/components/database/row-panel-context";
import { useIsOffline } from "@/components/offline/offline-context";
import { SidebarOpenButton } from "@/components/sidebar/sidebar-context";
import { IconButton } from "@/components/ui";
import { chatPath, sourceHref, type ChatScopeView, type ChatSourceView } from "@/lib/ai-chat";
import { rowFromSearch, withRow } from "@/lib/row-panel";
import { useAiChat } from "./chat-panel";
import { ChatThread } from "./chat-thread";
import { MemoryButton } from "./memory-dialog";
import { ScopePicker } from "./scope-picker";
import { useChat } from "./use-chat";

/** `memory`: the workspace has the chat's memory on (its Memory view is shown). */
export function ChatPage({ workspaceId, available, memory }: { workspaceId: string; available: boolean; memory: boolean }) {
  const t = useTranslations("ai.chat");
  const router = useRouter();
  const requested = useSearchParams().get("c");
  const context = useAiChat();
  const rowPanel = useRowPanel();
  const offline = useIsOffline();
  // The conversation the page shows (or null: a new chat), as far as the address is concerned.
  const shown = useRef<string | null | undefined>(undefined);
  // The whole workspace, or one of the person's teamspaces (no page is open here).
  const [scope, setScope] = useState<ChatScopeView | null>(null);
  const chat = useChat(workspaceId, {
    options: context?.options,
    onConversation: (id) => {
      shown.current = id;
      // Without a navigation: the answer is still streaming in. A source open beside it stays.
      window.history.replaceState(null, "", withRow(chatPath(workspaceId, id), rowFromSearch(window.location.search)));
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

  // The same function while the row panel opens and closes, so the answers' citations stay the
  // same elements and the panel can give focus back to the one that opened it.
  const openSource = useCallback(
    (source: ChatSourceView) => {
      const href = sourceHref(source);
      if (!href || !source.pageId) return;
      if (rowPanel?.available && source.kind !== "database") {
        const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        rowPanel.open(source.pageId, { source: null, trigger }, source.blockId);
        return;
      }
      router.push(href);
      // Beside the page, the conversation goes on; a phone has no room for both.
      if (!window.matchMedia("(max-width: 767px)").matches) context?.openPanel(conversationId);
    },
    [rowPanel, router, context, conversationId],
  );

  return (
    // The row panel steps through the answers' sources here, and gives focus back to one as it closes.
    <div data-row-source className="flex h-full flex-col">
      <div data-window-controls-clear className="flex h-11 shrink-0 items-center gap-1 px-3 max-md:ps-1.5">
        <SidebarOpenButton className="me-1 max-md:me-0" />
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title || t("title")}</h1>
        {memory && <MemoryButton workspaceId={workspaceId} className="h-7 w-7" />}
        <IconButton label={t("newChat")} className="h-7 w-7" onClick={() => router.push(chatPath(workspaceId))} disabled={!chat.messages.length && !conversationId}>
          <SquarePen className="h-4 w-4" />
        </IconButton>
      </div>
      <ChatThread
        chat={chat}
        blocked={blocked}
        onSend={(again) => void chat.send(scope, again)}
        onSource={openSource}
        variant="page"
        voice={context?.voice ?? null}
        footer={<ScopePicker workspaceId={workspaceId} pageId={null} value={scope} onChange={setScope} disabled={chat.running} />}
      />
    </div>
  );
}
