"use client";

import { createReactBlockSpec, type DefaultReactSuggestionItem } from "@blocknote/react";
import { CodeXml, Pencil, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { lazyPart } from "@/components/lazy-part";
import { Button, IconButton } from "@/components/ui";
import { cleanHtmlHeight, cleanHtmlSource, cleanHtmlTitle, HTML_BLOCK, htmlBlockConfig } from "@/lib/html-block";
import { useEmbedHost } from "./database-embed";
import type { PageEditor } from "./embed-blocks";
import { HtmlFrame } from "./html-frame";

/**
 * The HTML block (lib/html-block.ts): a small app that runs in a sandboxed frame (html-frame.tsx).
 * Everyone who can read the page uses it; people who may edit the page open its source, which
 * loads only then (html-source-dialog.tsx), and may have the AI write it.
 */
const HtmlSourceDialog = lazyPart(() => import("./html-source-dialog").then((m) => m.default));

/** A block just added from the slash menu: its source opens as it appears. */
let openNext = false;

export const HtmlBlock = createReactBlockSpec(htmlBlockConfig, {
  // A self-contained widget: clicks and keys inside it are its own.
  meta: { selectable: false },
  render: function HtmlBlockView({ block, editor }) {
    const t = useTranslations("page.htmlBlock");
    const host = useEmbedHost();
    const source = cleanHtmlSource(block.props.source);
    const title = cleanHtmlTitle(block.props.title);
    const editable = Boolean(host?.editable) && editor.isEditable;
    const [dialog, setDialog] = useState<"source" | "ai" | null>(() => {
      if (!openNext || source) return null;
      openNext = false;
      return "source";
    });
    const dialogs =
      host && editable && dialog ? (
        <HtmlSourceDialog editor={editor as unknown as PageEditor} blockId={block.id} pageId={host.pageId} ai={Boolean(host.ai)} focusAi={dialog === "ai"} onClose={() => setDialog(null)} />
      ) : null;

    if (!source.trim()) {
      return (
        <div contentEditable={false} className="my-1 flex w-full flex-wrap items-center gap-2 rounded-lg bg-bg-subtle px-3 py-3 text-sm text-fg-muted" data-html-block={block.id}>
          <CodeXml className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{editable ? t("emptyHint") : t("emptyReadOnly")}</span>
          {editable && (
            <>
              <Button size="sm" onClick={() => setDialog("source")}>
                {t("edit")}
              </Button>
              {host?.ai && (
                <Button size="sm" onClick={() => setDialog("ai")}>
                  <Sparkles className="h-3.5 w-3.5" aria-hidden />
                  {t("makeWithAi")}
                </Button>
              )}
            </>
          )}
          {dialogs}
        </div>
      );
    }
    return (
      <div contentEditable={false} className="group/html relative my-1 w-full" data-html-block={block.id}>
        <HtmlFrame source={source} title={title} height={cleanHtmlHeight(block.props.height)} label={t("label")} />
        {editable && (
          <div className="absolute end-1 top-1 flex gap-0.5 rounded-md border border-border bg-bg p-0.5 opacity-0 shadow-sm focus-within:opacity-100 group-hover/html:opacity-100 [@media(hover:none)]:opacity-100">
            <IconButton label={t("edit")} onClick={() => setDialog("source")}>
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
            {host?.ai && (
              <IconButton label={t("makeWithAi")} onClick={() => setDialog("ai")}>
                <Sparkles className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>
        )}
        {dialogs}
      </div>
    );
  },
  // Copied out of the app, the block is its title: its code isn't text for another document.
  toExternalHTML: ({ block }) => <p>{cleanHtmlTitle(block.props.title)}</p>,
});

/** The "HTML" slash menu entry: adds an empty block whose source opens at once. */
export function useHtmlSlashItem(editor: PageEditor, onPlace: (at: string, block: { type: typeof HTML_BLOCK; props: { source: string } }) => void): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.htmlBlock.slash");
  const host = useEmbedHost();
  return useMemo(() => {
    if (!host?.editable) return [];
    return [
      {
        title: t("title"),
        subtext: t("subtext"),
        aliases: t("aliases").split(" "),
        group: editor.dictionary.slash_menu.table.group,
        icon: <CodeXml size={18} />,
        onItemClick: () => {
          openNext = true;
          onPlace(editor.getTextCursorPosition().block.id, { type: HTML_BLOCK, props: { source: "" } });
        },
      },
    ];
  }, [editor, host, t, onPlace]);
}
