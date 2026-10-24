"use client";

import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
  type BlockNoteEditor,
  type PartialBlock,
} from "@blocknote/core";
import { createReactBlockSpec, type DefaultReactSuggestionItem } from "@blocknote/react";
import { Database, LayoutDashboard, PanelsTopLeft, Sparkles, SquareArrowOutUpRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { createInlineDatabaseAction } from "@/app/actions/embeds";
import { DASHBOARD_BLOCK } from "@/lib/dashboard";
import {
  DATABASE_BLOCK,
  databaseBlockConfig,
  linkedViewBlockConfig,
  parseLinkedView,
  serializeLinkedView,
  type LinkedView,
} from "@/lib/embed-blocks";
import { CodeBlock } from "./code-block";
import { columnEditorBlockSpecs } from "./columns";
import { contentBlockSpecs, contentInlineSpecs } from "./content-blocks";
import { mentionBlockSpecs, mentionInlineSpecs } from "./mentions";
import { DashboardBlock } from "./dashboard-block";
import { SyncedPageBlock } from "./synced-page";
import { SyncedBlockSpec } from "./synced-block";
import { AgentChatBlock } from "./agent-chat-block";
import { ButtonBlock } from "./button-block";
import { MeetingBlock } from "./meeting-block";
import { DatabaseEmbed, useEmbedHost } from "./database-embed";
import { FileBlock } from "./file-block";
import { webBlockSpecs } from "./web-blocks";
import { textScriptStyleSpecs } from "@/lib/text-scripts";
import { linkedImageSpec } from "@/lib/image-links";

export { DatabasePicker } from "./database-picker";

/**
 * The page editor's schema: BlockNote's blocks plus the database blocks (configs shared with the
 * server in lib/embed-blocks) and the content blocks (content-blocks.tsx, configs shared in
 * lib/content-blocks), mentions and page links (mentions.tsx, configs shared in lib/mentions), and
 * columns (columns.tsx, nodes shared in lib/columns).
 * The database blocks are self-contained widgets: not selectable as text, and
 * every event inside them belongs to the database UI rather than the editor.
 */

const DatabaseBlock = createReactBlockSpec(databaseBlockConfig, {
  meta: { selectable: false },
  render: function DatabaseBlockView({ block }) {
    return block.props.databaseId ? <DatabaseEmbed databaseId={block.props.databaseId} /> : null;
  },
  // Copying the block to another app carries nothing about the database.
  toExternalHTML: () => <div />,
});

const LinkedViewBlock = createReactBlockSpec(linkedViewBlockConfig, {
  meta: { selectable: false },
  render: function LinkedViewBlockView({ block, editor }) {
    const host = useEmbedHost();
    const view = useMemo(() => parseLinkedView(block.props.view), [block.props.view]);
    // The settings live in the block, so they sync, undo and version with the page. Readers who
    // can't edit the page can't change them (the collab server would drop the edit anyway).
    const editable = host?.editable ?? false;
    const linked = useMemo(
      () => ({
        view,
        onChange: editable
          ? (next: LinkedView) => {
              if (editor.getBlock(block.id)) editor.updateBlock(block.id, { props: { view: serializeLinkedView(next) } });
            }
          : undefined,
      }),
      [view, editable, editor, block.id],
    );
    if (!block.props.databaseId) return null;
    return <DatabaseEmbed databaseId={block.props.databaseId} linked={linked} />;
  },
  toExternalHTML: () => <div />,
});

export const pageEditorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    // Images may link to a web address or a page (lib/image-links; editor-files.tsx opens it).
    image: linkedImageSpec(),
    // A language menu and colored code (see code-block.tsx).
    codeBlock: CodeBlock(),
    database: DatabaseBlock(),
    linkedView: LinkedViewBlock(),
    // Widgets over the workspace's databases (see dashboard-block.tsx).
    dashboard: DashboardBlock(),
    ...contentBlockSpecs,
    ...webBlockSpecs,
    ...mentionBlockSpecs,
    // Another page's body, live (see synced-page.tsx).
    syncedPage: SyncedPageBlock(),
    // Blocks kept on one page and shown live on others (see synced-block.tsx).
    syncedBlock: SyncedBlockSpec(),
    // A chat with one of the workspace's agents (see agent-chat-block.tsx).
    agentChat: AgentChatBlock(),
    // A button that does a few things when clicked (see button-block.tsx).
    button: ButtonBlock(),
    // A meeting recorded, transcribed and written up (see meeting-block.tsx).
    meeting: MeetingBlock(),
    // Uploaded PDFs show in place (see file-block.tsx).
    file: FileBlock(),
    // Blocks side by side (see columns.tsx).
    ...columnEditorBlockSpecs,
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, ...contentInlineSpecs, ...mentionInlineSpecs },
  // Superscript and subscript (lib/text-scripts), shared with the server's schema.
  styleSpecs: { ...defaultStyleSpecs, ...textScriptStyleSpecs },
});

export type PageEditor = BlockNoteEditor<
  typeof pageEditorSchema.blockSchema,
  typeof pageEditorSchema.inlineContentSchema,
  typeof pageEditorSchema.styleSchema
>;
type PageBlockInput = PartialBlock<
  typeof pageEditorSchema.blockSchema,
  typeof pageEditorSchema.inlineContentSchema,
  typeof pageEditorSchema.styleSchema
>;

/**
 * Puts a database block where the slash menu was opened: in place of the block when it is empty
 * (the "/" the menu leaves behind aside), after it otherwise, with a paragraph to keep typing in.
 * `at` may have gone meanwhile (the block is added after a server round trip): then at the end.
 * Returns the block placed, for the next one to go after it.
 */
export function placeEmbedBlock(editor: PageEditor, at: string, block: PageBlockInput) {
  const current = editor.getBlock(at);
  let placed;
  if (!current) {
    placed = editor.insertBlocks([block], editor.document[editor.document.length - 1], "after")[0];
  } else {
    const content = current.content;
    const empty =
      Array.isArray(content) &&
      (content.length === 0 || (content.length === 1 && content[0].type === "text" && content[0].text.trim() === "/"));
    placed = empty && current.type === "paragraph" ? editor.updateBlock(current, block) : editor.insertBlocks([block], current, "after")[0];
  }
  const next = editor.getNextBlock(placed);
  const after = next ?? editor.insertBlocks([{ type: "paragraph" }], placed, "after")[0];
  editor.setTextCursorPosition(after, "start");
  return placed;
}

/**
 * Slash menu entries for the database blocks, placed after BlockNote's own "Table". `onBuild`, when
 * the page may use AI: "Build databases with AI" (components/workspace/build-with-ai-dialog.tsx).
 */
export function useEmbedSlashItems(
  editor: PageEditor,
  {
    onCreateError,
    onPickDatabase,
    onDashboard,
    onBuild,
  }: { onCreateError: (message: string) => void; onPickDatabase: (at: string) => void; onDashboard?: () => void; onBuild?: (at: string) => void },
) {
  const t = useTranslations("page.embed");
  const tBuild = useTranslations("build.slash");
  const host = useEmbedHost();
  return useMemo(() => {
    if (!host?.editable) return () => [] as DefaultReactSuggestionItem[];
    const group = editor.dictionary.slash_menu.table.group;
    let creating = false;
    return (): DefaultReactSuggestionItem[] => [
      {
        title: t("slash.database.title"),
        subtext: t("slash.database.subtext"),
        aliases: t("slash.database.aliases").split(" "),
        group,
        icon: <Database size={18} />,
        onItemClick: () => {
          if (creating) return;
          creating = true;
          const at = editor.getTextCursorPosition().block.id;
          // The database exists before the block does, so every block points at a real database.
          void createInlineDatabaseAction(host.pageId)
            .then((res) => {
              if (res.ok) placeEmbedBlock(editor, at, { type: DATABASE_BLOCK, props: { databaseId: res.data.id } });
              else onCreateError(t("createFailed", { error: res.error }));
            })
            .catch(() => onCreateError(t("createFailed", { error: "" })))
            .finally(() => {
              creating = false;
            });
        },
      },
      ...(onBuild
        ? [
            {
              title: tBuild("title"),
              subtext: tBuild("subtext"),
              aliases: tBuild("aliases").split(" "),
              group,
              icon: <Sparkles size={18} />,
              onItemClick: () => onBuild(editor.getTextCursorPosition().block.id),
            },
          ]
        : []),
      {
        title: t("slash.linkedView.title"),
        subtext: t("slash.linkedView.subtext"),
        aliases: t("slash.linkedView.aliases").split(" "),
        group,
        icon: <SquareArrowOutUpRight size={18} />,
        onItemClick: () => onPickDatabase(editor.getTextCursorPosition().block.id),
      },
      {
        title: t("slash.dashboard.title"),
        subtext: t("slash.dashboard.subtext"),
        aliases: t("slash.dashboard.aliases").split(" "),
        group,
        icon: <LayoutDashboard size={18} />,
        // Empty: its "Add widget" button picks the first database.
        onItemClick: () => {
          placeEmbedBlock(editor, editor.getTextCursorPosition().block.id, { type: DASHBOARD_BLOCK, props: { widgets: "" } });
          onDashboard?.();
        },
      },
      {
        title: t("slash.databaseTabs.title"),
        subtext: t("slash.databaseTabs.subtext"),
        aliases: t("slash.databaseTabs.aliases").split(" "),
        group,
        icon: <PanelsTopLeft size={18} />,
        // A dashboard shown as tabs (lib/dashboard): its "Add tab" button picks the first database.
        onItemClick: () => placeEmbedBlock(editor, editor.getTextCursorPosition().block.id, { type: DASHBOARD_BLOCK, props: { widgets: "", layout: "tabs" } }),
      },
    ];
  }, [editor, host, t, tBuild, onCreateError, onPickDatabase, onDashboard, onBuild]);
}

/** Inserts each extra item after the last item of its group (e.g. BlockNote's "Advanced"), in order. */
export function withEmbedItems(items: DefaultReactSuggestionItem[], extras: DefaultReactSuggestionItem[]) {
  let out = items;
  for (const extra of extras) {
    let at = -1;
    out.forEach((item, i) => {
      if (item.group === extra.group) at = i;
    });
    out = at < 0 ? [...out, extra] : [...out.slice(0, at + 1), extra, ...out.slice(at + 1)];
  }
  return out;
}
