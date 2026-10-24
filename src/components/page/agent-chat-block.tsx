"use client";

import { createReactBlockSpec, type DefaultReactSuggestionItem } from "@blocknote/react";
import { Bot, Search } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { chatAgentsAction } from "@/app/actions/agent-chat";
import { IconGlyph } from "@/components/builtin-icon";
import { Button, cn, Dialog } from "@/components/ui";
import { AGENT_CHAT_BLOCK, agentChatBlockConfig, agentLinkRef, newChatId } from "@/lib/agent-chat";
import { searchFold } from "@/lib/search-fold";
import { useEmbedHost } from "./database-embed";
import type { PageEditor } from "./embed-blocks";

/**
 * The "Agent chat" block (lib/agent-chat.ts): a chat with one of the workspace's agents inside the
 * page, each reader with their own conversations. The block holds only the agent and its chat id;
 * whether the reader may chat, and how, is the server's to say. The chat itself is loaded only
 * where such a block is shown.
 */
const AgentChat = dynamic(() => import("@/components/agent-chat/agent-chat").then((m) => m.AgentChat), {
  ssr: false,
  loading: () => <div aria-busy="true" className="my-1 h-24 w-full animate-pulse rounded-lg bg-bg-subtle" />,
});

/** A block just added from the slash menu, whose picker opens as it appears. */
let pickFor: string | null = null;

export const AgentChatBlock = createReactBlockSpec(agentChatBlockConfig, {
  // A self-contained widget: clicks and keys inside it are its own.
  meta: { selectable: false },
  render: function AgentChatBlockView({ block, editor }) {
    const t = useTranslations("page.agentChat");
    const host = useEmbedHost();
    const { agentId, chatId } = block.props;
    const editable = Boolean(host?.editable) && editor.isEditable;
    const [picking, setPicking] = useState(() => {
      if (!chatId || pickFor !== chatId) return false;
      pickFor = null;
      return true;
    });
    // A block written in Markdown without a chat id gets one from the first person who may edit it.
    useEffect(() => {
      if (editable && agentId && !chatId && editor.getBlock(block.id)) editor.updateBlock(block.id, { props: { chatId: newChatId() } });
    }, [editable, agentId, chatId, editor, block.id]);

    if (!host || !agentId || !chatId) {
      return (
        <div contentEditable={false} className="my-1 flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-fg-muted">
          <Bot className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{!host ? t("label") : editable && !agentId ? t("noAgent") : t("noAgentReadOnly")}</span>
          {host && editable && !agentId && (
            <Button size="sm" onClick={() => setPicking(true)}>
              {t("choose")}
            </Button>
          )}
          {host && (
            <AgentPicker
              open={picking}
              workspaceId={host.workspaceId}
              onClose={() => setPicking(false)}
              onPick={(id) => {
                setPicking(false);
                if (editor.getBlock(block.id)) editor.updateBlock(block.id, { props: { agentId: id, chatId: chatId || newChatId() } });
              }}
            />
          )}
        </div>
      );
    }
    return (
      <div contentEditable={false} className="w-full" data-agent-chat={chatId}>
        <AgentChat workspaceId={host.workspaceId} agentId={agentId} place={{ chatId, pageId: host.pageId }} variant="block" />
      </div>
    );
  },
  // Copied out of the app, a chat carries nothing.
  toExternalHTML: () => <div />,
});

/** The "Agent chat" slash menu entry: adds the block, whose agent picker opens at once. */
export function useAgentChatSlashItem(editor: PageEditor, onPlace: (at: string, block: { type: typeof AGENT_CHAT_BLOCK; props: { agentId: string; chatId: string } }) => void): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.agentChat.slash");
  const host = useEmbedHost();
  return useMemo(() => {
    if (!host?.editable) return [];
    return [
      {
        title: t("title"),
        subtext: t("subtext"),
        aliases: t("aliases").split(" "),
        group: editor.dictionary.slash_menu.table.group,
        icon: <Bot size={18} />,
        onItemClick: () => {
          const chatId = newChatId();
          pickFor = chatId;
          onPlace(editor.getTextCursorPosition().block.id, { type: AGENT_CHAT_BLOCK, props: { agentId: "", chatId } });
        },
      },
    ];
  }, [editor, host, t, onPlace]);
}

/**
 * Paste: a link to one of this workspace's agents (its settings), alone in an empty paragraph,
 * becomes a chat with it. Returns undefined for every other paste.
 */
export function pasteAgentChat(event: ClipboardEvent, editor: PageEditor, workspaceId: string | null): boolean | undefined {
  if (!workspaceId) return undefined;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  const ref = agentLinkRef(text, window.location.origin);
  if (!ref || ref.workspaceId !== workspaceId) return undefined;
  const current = editor.getTextCursorPosition().block;
  const empty = current.type === "paragraph" && Array.isArray(current.content) && current.content.length === 0;
  if (!empty) return undefined;
  const placed = editor.updateBlock(current, { type: AGENT_CHAT_BLOCK, props: { agentId: ref.agentId, chatId: newChatId() } });
  const next = editor.getNextBlock(placed);
  editor.setTextCursorPosition(next ?? editor.insertBlocks([{ type: "paragraph" }], placed, "after")[0], "start");
  return true;
}

/** Picks one of the workspace's agents for a chat block. */
function AgentPicker({ open, workspaceId, onPick, onClose }: { open: boolean; workspaceId: string; onPick: (agentId: string) => void; onClose: () => void }) {
  const t = useTranslations("page.agentChat.picker");
  const tc = useTranslations("common");
  const [agents, setAgents] = useState<{ id: string; name: string; icon: string | null; description: string; enabled: boolean }[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFailed(false);
    setAgents(null);
    chatAgentsAction(workspaceId)
      .then((res) => (res.ok ? setAgents(res.data) : setFailed(true)))
      .catch(() => setFailed(true));
  }, [open, workspaceId]);

  const matches = useMemo(() => {
    const q = searchFold(query.trim());
    return (agents ?? []).filter((a) => !q || searchFold(a.name).includes(q)).slice(0, 50);
  }, [agents, query]);

  return (
    <Dialog open={open} onClose={onClose} className="max-w-md">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="h-4 w-4 text-fg-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={t("search")}
          aria-label={t("search")}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      <div className={cn("max-h-80 overflow-y-auto p-1", !agents && !failed && "opacity-70")}>
        {matches.map((a) => (
          <button key={a.id} type="button" onClick={() => onPick(a.id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center">{a.icon ? <IconGlyph icon={a.icon} /> : <Bot className="h-4 w-4 text-fg-muted" aria-hidden />}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{a.name}</span>
              {a.description && <span className="block truncate text-xs text-fg-muted">{a.description}</span>}
            </span>
            {!a.enabled && <span className="shrink-0 text-xs text-fg-muted">{t("paused")}</span>}
          </button>
        ))}
        {failed && (
          <p role="alert" className="px-2 py-3 text-sm text-danger">
            {t("failed")}
          </p>
        )}
        {!agents && !failed && <p className="px-2 py-3 text-sm text-fg-muted">{tc("loading")}</p>}
        {agents && !matches.length && <p className="px-2 py-3 text-sm text-fg-muted">{t("empty")}</p>}
      </div>
    </Dialog>
  );
}
