"use client";

import type { DefaultReactSuggestionItem } from "@blocknote/react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { BLOCK_COLORS, colorAliases, type BlockColor } from "@/lib/block-colors";
import type { PageEditor } from "./embed-blocks";

/** Whether the block under the cursor takes `prop` (paragraphs, headings, lists, quotes… do; code and images don't). */
function blockTakes(editor: PageEditor, prop: "textColor" | "backgroundColor") {
  const { block } = editor.getTextCursorPosition();
  const spec = editor.schema.blockSchema[block.type];
  return Boolean(spec && prop in spec.propSchema);
}

/** The editor's "A" color swatch, colored by its own palette (the formatting toolbar's). */
function Swatch({ text, background }: { text?: BlockColor; background?: BlockColor }) {
  return (
    <div
      className="bn-color-icon"
      data-text-color={text ?? "default"}
      data-background-color={background ?? "default"}
      style={{ width: 18, height: 18, lineHeight: "18px", fontSize: 13, textAlign: "center", borderRadius: 4 }}
    >
      A
    </div>
  );
}

/**
 * Slash menu entries that color the current block's text or background, one per color of the
 * editor's palette and one to go back to the default, in a "Colors" group at the end. Found by the
 * color's name in the interface language (and its English name).
 */
export function useColorSlashItems(editor: PageEditor) {
  const t = useTranslations("page.blocks.colors");
  return useMemo(() => {
    const names = editor.dictionary.color_picker.colors;
    const group = t("group");
    const textWords = t("textAliases").split(" ");
    const backgroundWords = t("backgroundAliases").split(" ");
    const apply = (prop: "textColor" | "backgroundColor", color: BlockColor) => {
      const { block } = editor.getTextCursorPosition();
      editor.updateBlock(block, { props: { [prop]: color } });
    };
    const text: DefaultReactSuggestionItem[] = BLOCK_COLORS.map((color) => ({
      title: color === "default" ? t("textDefault") : t("text", { color: names[color] }),
      aliases: colorAliases(color, names[color], textWords),
      group,
      icon: <Swatch text={color} />,
      onItemClick: () => apply("textColor", color),
    }));
    const background: DefaultReactSuggestionItem[] = BLOCK_COLORS.map((color) => ({
      title: color === "default" ? t("backgroundDefault") : t("background", { color: names[color] }),
      aliases: colorAliases(color, names[color], backgroundWords),
      group,
      icon: <Swatch background={color} />,
      onItemClick: () => apply("backgroundColor", color),
    }));
    // Read when the menu asks for its items: only blocks that take a color get them.
    return () => [...(blockTakes(editor, "textColor") ? text : []), ...(blockTakes(editor, "backgroundColor") ? background : [])];
  }, [editor, t]);
}
