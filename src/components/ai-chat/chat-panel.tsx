"use client";

/**
 * The AI chat (#41): questions about the workspace, answered from the pages the person can open,
 * with citations that link to them (and scroll to the passage). Two ways to ask: the panel beside a
 * page (opened from the page's header; it stays open while the person moves between pages) and the
 * full-page chat at /w/[id]/ai (the sidebar's "Ask AI"), where the sidebar lists the conversations.
 * Conversations are kept on the server for this person only. Needs the server and AI on in the
 * workspace, and says so otherwise.
 */
import { History, Loader2, Maximize2, SquarePen, Trash2, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listConversationsAction } from "@/app/actions/ai";
import { MemoryButton } from "./memory-dialog";
import { useIsOffline } from "@/components/offline/offline-context";
import { FOCUS_BLOCK_EVENT } from "@/components/page/block-focus";
import { cn, IconButton, MenuItem, MenuSeparator, Popover } from "@/components/ui";
import { chatPath, isChatPath, sourceHref, type ChatSourceView, type ConversationSummary } from "@/lib/ai-chat";
import { ChatThread } from "./chat-thread";
import { useChat } from "./use-chat";

type ChatContext = {
  workspaceId: string;
  /** AI is on in the workspace (otherwise the chat explains why it can't answer). */
  available: boolean;
  /** The panel beside the page. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Opens the panel, showing this conversation (or a new chat). */
  openPanel: (conversationId?: string | null) => void;
  /** The person's conversations in the workspace, newest first; null until first asked for. */
  conversations: ConversationSummary[] | null;
  refreshConversations: () => Promise<void>;
  /** The last page visited outside the full-page chat, where "back to pages" goes. */
  backPath: () => string;
};
const Context = createContext<ChatContext | null>(null);

/** The chat for the sidebar, page headers and the full-page chat; null when the server has no AI provider. */
export function useAiChat() {
  return useContext(Context);
}

/**
 * Holds the chat for a workspace's pages. `available`: AI is on in the workspace (the chat explains
 * when it isn't); `memory`: so is the chat's memory (its Memory view is shown). Only rendered when
 * the server has an AI provider.
 */
export function AiChatProvider({
  workspaceId,
  available,
  memory,
  children,
}: {
  workspaceId: string;
  available: boolean;
  memory: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const onChatPage = isChatPath(pathname, workspaceId);
  const [open, setOpen] = useState(false);
  // The panel starts over (with this conversation) each time it's opened for one.
  const [panel, setPanel] = useState<{ key: number; conversationId: string | null }>({ key: 0, conversationId: null });
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const lastPage = useRef(`/w/${workspaceId}`);
  useEffect(() => {
    if (!onChatPage) lastPage.current = pathname;
    // The chat moved to the full page: the panel doesn't come back with the pages.
    else setOpen(false);
  }, [onChatPage, pathname]);

  const refreshConversations = useCallback(async () => {
    const result = await listConversationsAction(workspaceId);
    setConversations(result.ok ? result.data : []);
  }, [workspaceId]);
  const openPanel = useCallback((conversationId?: string | null) => {
    setPanel((p) => ({ key: p.key + 1, conversationId: conversationId ?? null }));
    setOpen(true);
  }, []);
  const backPath = useCallback(() => lastPage.current, []);

  const value = useMemo(
    () => ({ workspaceId, available, open, setOpen, openPanel, conversations, refreshConversations, backPath }),
    [workspaceId, available, open, openPanel, conversations, refreshConversations, backPath],
  );
  return (
    <Context.Provider value={value}>
      {children}
      {/* The full-page chat replaces the panel while it's shown. */}
      {open && !onChatPage && (
        <ChatPanel
          key={panel.key}
          workspaceId={workspaceId}
          available={available}
          memory={memory}
          initialConversation={panel.conversationId}
          onClose={() => setOpen(false)}
        />
      )}
    </Context.Provider>
  );
}

function ChatPanel({
  workspaceId,
  available,
  memory,
  initialConversation,
  onClose,
}: {
  workspaceId: string;
  available: boolean;
  memory: boolean;
  initialConversation: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("ai.chat");
  const router = useRouter();
  const pathname = usePathname();
  const context = useAiChat()!;
  const { conversations, refreshConversations } = context;
  const currentPageId = /\/p\/([\w-]+)/.exec(pathname)?.[1] ?? null;
  const offline = useIsOffline();
  const [scope, setScope] = useState<"workspace" | "page">("workspace");
  const chat = useChat(workspaceId, { onAnswered: () => void refreshConversations() });
  const { conversationId, messages, running } = chat;
  const blocked = offline ? t("offline") : !available ? t("disabled") : null;
  const pageScope = scope === "page" && currentPageId ? currentPageId : null;

  const openConversation = chat.openConversation;
  useEffect(() => {
    if (initialConversation) void openConversation(initialConversation);
    // Only when the panel opens for a conversation (it's keyed by each opening).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not an Escape that closed something in it (a menu, editing a question).
      if (e.key === "Escape" && !e.defaultPrevented && !running) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  async function remove(id: string | "all") {
    if (await chat.remove(id)) await refreshConversations();
  }

  function openSource(source: ChatSourceView) {
    const href = sourceHref(source);
    if (!href || !source.pageId) return;
    if (source.pageId === currentPageId) {
      if (source.blockId) window.dispatchEvent(new CustomEvent(FOCUS_BLOCK_EVENT, { detail: { blockId: source.blockId } }));
      return;
    }
    router.push(href);
    // On a phone the panel covers the page.
    if (window.matchMedia("(max-width: 767px)").matches) onClose();
  }

  return (
    <aside
      aria-label={t("title")}
      className="fixed inset-y-0 inset-e-0 z-40 flex w-full flex-col border-s border-border bg-bg shadow-xl md:w-[400px]"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
        <h2 className="flex-1 truncate text-sm font-semibold">{t("title")}</h2>
        <Popover
          align="end"
          className="w-72"
          trigger={({ toggle }) => (
            <IconButton
              label={t("history")}
              className="h-7 w-7"
              onClick={() => {
                void refreshConversations();
                toggle();
              }}
              disabled={offline}
            >
              <History className="h-4 w-4" />
            </IconButton>
          )}
        >
          {(close) => (
            <div className="max-h-80 overflow-y-auto">
              {conversations === null ? (
                <p className="px-2 py-1.5 text-sm text-fg-muted">
                  <Loader2 className="inline h-3.5 w-3.5 animate-spin" />
                </p>
              ) : conversations.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-fg-muted">{t("noHistory")}</p>
              ) : (
                <>
                  {conversations.map((c) => (
                    <div key={c.id} className={cn("group flex items-center gap-1 rounded", c.id === conversationId && "bg-bg-hover")}>
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover"
                        onClick={() => {
                          close();
                          void chat.openConversation(c.id);
                        }}
                      >
                        {c.title || t("untitled")}
                      </button>
                      <IconButton label={t("deleteConversation")} className="h-7 w-7 opacity-60 group-hover:opacity-100" onClick={() => void remove(c.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                  ))}
                  <MenuSeparator />
                  <MenuItem
                    icon={<Trash2 className="h-4 w-4" />}
                    danger
                    onClick={() => {
                      close();
                      void remove("all");
                    }}
                  >
                    {t("deleteAll")}
                  </MenuItem>
                </>
              )}
            </div>
          )}
        </Popover>
        {memory && <MemoryButton workspaceId={workspaceId} className="h-7 w-7" />}
        <IconButton label={t("newChat")} className="h-7 w-7" onClick={chat.newChat} disabled={!messages.length && !conversationId}>
          <SquarePen className="h-4 w-4" />
        </IconButton>
        {/* Leaving mid-answer would stop it. */}
        <IconButton
          label={t("expand")}
          className="h-7 w-7 max-md:hidden"
          disabled={running}
          onClick={() => {
            onClose();
            router.push(chatPath(workspaceId, conversationId));
          }}
        >
          <Maximize2 className="h-4 w-4" />
        </IconButton>
        <IconButton label={t("close")} className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      <ChatThread
        chat={chat}
        blocked={blocked}
        onSend={(again) => void chat.send(pageScope, again)}
        onSource={openSource}
        variant="panel"
        footer={
          <div className="mt-2 flex items-center gap-2 text-xs text-fg-muted">
            <label htmlFor="ai-chat-scope">{t("scope")}</label>
            <select
              id="ai-chat-scope"
              value={pageScope ? "page" : "workspace"}
              onChange={(e) => setScope(e.target.value === "page" ? "page" : "workspace")}
              disabled={running}
              className="h-6 min-w-0 flex-1 rounded border border-border bg-bg px-1 text-xs text-fg"
            >
              <option value="workspace">{t("scopeWorkspace")}</option>
              <option value="page" disabled={!currentPageId}>
                {t("scopePage")}
              </option>
            </select>
          </div>
        }
      />
    </aside>
  );
}
