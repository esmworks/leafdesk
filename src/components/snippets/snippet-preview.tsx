"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { useLocale, useTimeZone, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { pageEditorSchema, type PageEditor } from "@/components/page/embed-blocks";
import { useColorScheme } from "@/components/theme/theme-provider";
import { useEditorDictionary } from "@/i18n/blocknote";
import { parseDashboardLine } from "@/lib/dashboard";
import { editorMarkdownToBlocks } from "@/lib/editor-markdown";
import { DATABASE_BLOCK, mapReferenceLines } from "@/lib/embed-blocks";
import { fillPlaceholders, preparePlaceholders } from "@/lib/snippets";
import { browserTimeZone } from "@/lib/time-zone";

type AnyBlock = PageEditor["document"][number];

/**
 * A snippet's Markdown as the blocks it inserts, read-only, with its placeholders filled in as if
 * it went in now. A database or dashboard is only named: it lives on one page.
 */
export default function SnippetPreview({ markdown, me, page }: { markdown: string; me: string; page: string }) {
  const dictionary = useEditorDictionary();
  const te = useTranslations("page.embed");
  const td = useTranslations("page.dashboard");
  const locale = useLocale();
  const timeZone = useTimeZone() ?? browserTimeZone();
  const colorScheme = useColorScheme();
  const editor = useCreateBlockNote({ schema: pageEditorSchema, dictionary }, [dictionary]) as unknown as PageEditor;
  // Typing in the form re-renders often: the blocks follow once it pauses.
  const [text, setText] = useState(markdown);
  useEffect(() => {
    const timer = setTimeout(() => setText(markdown), 250);
    return () => clearTimeout(timer);
  }, [markdown]);
  useEffect(() => {
    let cancelled = false;
    const named = mapReferenceLines(text, (ref) => `*${te(ref.type === DATABASE_BLOCK ? "label" : "linkedLabel")}*`)
      .split("\n")
      .map((line) => (parseDashboardLine(line) ? `*${td("title")}*` : line))
      .join("\n");
    const prepared = preparePlaceholders(named, { now: new Date(), locale, timeZone, me, page }, "preview0");
    void (async () => {
      const blocks = fillPlaceholders((await editorMarkdownToBlocks(editor, prepared.markdown)) as AnyBlock[], prepared.tokens);
      if (cancelled) return;
      const cleaned = prepared.cursor ? fillPlaceholders(blocks, new Map([[prepared.cursor, ""]])) : blocks;
      editor.replaceBlocks(editor.document, (cleaned.length ? cleaned : [{ type: "paragraph" }]) as never);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [editor, text, te, td, locale, timeZone, me, page]);
  return (
    <BlockNoteView
      editor={editor as never}
      theme={colorScheme}
      editable={false}
      sideMenu={false}
      slashMenu={false}
      formattingToolbar={false}
      className="leafdesk-editor snippet-preview"
    />
  );
}
