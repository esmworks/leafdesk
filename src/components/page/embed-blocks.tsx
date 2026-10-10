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
import { Database, Search, SquareArrowOutUpRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { listDatabasesAction } from "@/app/actions/databases";
import { createInlineDatabaseAction } from "@/app/actions/embeds";
import { cn, Dialog, PageIcon, pageLabel } from "@/components/ui";
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
import { DatabaseEmbed, useEmbedHost } from "./database-embed";
import { FileBlock } from "./file-block";
import { webBlockSpecs } from "./web-blocks";
import { searchFold } from "@/lib/search-fold";
import { textScriptStyleSpecs } from "@/lib/text-scripts";

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
    // A language menu and colored code (see code-block.tsx).
    codeBlock: CodeBlock(),
    database: DatabaseBlock(),
    linkedView: LinkedViewBlock(),
    ...contentBlockSpecs,
    ...webBlockSpecs,
    ...mentionBlockSpecs,
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
}

/** Slash menu entries for the database blocks, placed after BlockNote's own "Table". */
export function useEmbedSlashItems(
  editor: PageEditor,
  { onCreateError, onPickDatabase }: { onCreateError: (message: string) => void; onPickDatabase: (at: string) => void },
) {
  const t = useTranslations("page.embed");
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
      {
        title: t("slash.linkedView.title"),
        subtext: t("slash.linkedView.subtext"),
        aliases: t("slash.linkedView.aliases").split(" "),
        group,
        icon: <SquareArrowOutUpRight size={18} />,
        onItemClick: () => onPickDatabase(editor.getTextCursorPosition().block.id),
      },
    ];
  }, [editor, host, t, onCreateError, onPickDatabase]);
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

/** Picks the database a new linked view shows: any database of the workspace the user can see. */
export function DatabasePicker({
  open,
  workspaceId,
  onPick,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  onPick: (databaseId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("page.embed.picker");
  const tc = useTranslations("common");
  const [databases, setDatabases] = useState<{ id: string; title: string; icon: string | null }[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFailed(false);
    setDatabases(null);
    listDatabasesAction(workspaceId)
      .then((res) => {
        if (res.ok) setDatabases(res.data);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [open, workspaceId]);

  const matches = useMemo(() => {
    const q = searchFold(query.trim());
    return (databases ?? [])
      .filter((d) => !q || searchFold(pageLabel(d.title, tc("untitled"))).includes(q))
      .slice(0, 50);
  }, [databases, query, tc]);

  return (
    <Dialog open={open} onClose={onClose} className="max-w-md">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="h-4 w-4 text-fg-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search")}
          aria-label={t("title")}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      <div className={cn("max-h-80 overflow-y-auto p-1", !databases && !failed && "opacity-70")}>
        {matches.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onPick(d.id)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover"
          >
            <PageIcon icon={d.icon} kind="database" className="text-sm" />
            <span className="truncate">{pageLabel(d.title, tc("untitled"))}</span>
          </button>
        ))}
        {failed && (
          <p role="alert" className="px-2 py-3 text-sm text-danger">
            {t("failed")}
          </p>
        )}
        {!databases && !failed && <p className="px-2 py-3 text-sm text-fg-muted">{tc("loading")}</p>}
        {databases && !matches.length && <p className="px-2 py-3 text-sm text-fg-muted">{t("empty")}</p>}
      </div>
    </Dialog>
  );
}
