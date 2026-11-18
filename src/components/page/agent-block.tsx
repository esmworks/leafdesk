"use client";

import { createReactBlockSpec, type DefaultReactSuggestionItem } from "@blocknote/react";
import { Bot } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { lazyPart } from "@/components/lazy-part";
import { Button } from "@/components/ui";
import { AGENT_BLOCK, agentBlockConfig, pageAgentPlace } from "@/lib/agent-block";
import { AgentPicker } from "./agent-chat-block";
import { useEmbedHost } from "./database-embed";
import type { PageEditor } from "./embed-blocks";

/**
 * The "Agent" block (lib/agent-block.ts): one of the workspace's agents in the page, a box to ask
 * it and its latest answer for the reader, who has their own conversation with it for this page.
 * The block holds only the agent; whether the reader may ask is the server's to say. The card's
 * code (and the full chat it opens) is loaded only where such a block is shown.
 */
const AgentCard = lazyPart(() => import("@/components/agent-chat/agent-card").then((m) => m.AgentCard), <div aria-busy="true" className="my-1 h-24 w-full animate-pulse rounded-lg bg-bg-subtle" />);

/** Set by the slash menu: the block it adds opens its agent picker as it appears. */
let pickNext = false;

export const AgentBlock = createReactBlockSpec(agentBlockConfig, {
  // A self-contained widget: clicks and keys inside it are its own.
  meta: { selectable: false },
  render: function AgentBlockView({ block, editor }) {
    const t = useTranslations("page.agentBlock");
    const host = useEmbedHost();
    const { agentId } = block.props;
    const editable = Boolean(host?.editable) && editor.isEditable;
    const [picking, setPicking] = useState(() => {
      if (agentId || !pickNext) return false;
      pickNext = false;
      return true;
    });

    if (!host || !agentId) {
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
                if (editor.getBlock(block.id)) editor.updateBlock(block.id, { props: { agentId: id } });
              }}
            />
          )}
        </div>
      );
    }
    return (
      <div contentEditable={false} className="w-full" data-agent-block={agentId}>
        <AgentCard workspaceId={host.workspaceId} agentId={agentId} place={pageAgentPlace(host.pageId)} />
      </div>
    );
  },
  // Copied out of the app, the block carries nothing.
  toExternalHTML: () => <div />,
});

/** The "Agent" slash menu entry: adds the block, whose agent picker opens at once. */
export function useAgentSlashItem(editor: PageEditor, onPlace: (at: string, block: { type: typeof AGENT_BLOCK; props: { agentId: string } }) => void): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.agentBlock.slash");
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
          pickNext = true;
          onPlace(editor.getTextCursorPosition().block.id, { type: AGENT_BLOCK, props: { agentId: "" } });
        },
      },
    ];
  }, [editor, host, t, onPlace]);
}
