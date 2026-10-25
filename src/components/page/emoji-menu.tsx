"use client";

import { GridSuggestionMenuController, type DefaultReactGridSuggestionItem } from "@blocknote/react";
import type { BlockNoteEditor } from "@blocknote/core";
import { useLocale } from "next-intl";
import { useCallback } from "react";
import { loadEmojiData, searchEmoji, withTone } from "@/components/icon-picker/emoji-data";
import { loadPickerPreferences } from "@/components/icon-picker/preferences";

/**
 * The ":" menu: emoji found by their names in the interface language (and in English), in the skin
 * tone the person last picked in the icon picker. Uses the icon picker's data, fetched when first typed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function EmojiMenu({ editor }: { editor: BlockNoteEditor<any, any, any> }) {
  const locale = useLocale();
  const getItems = useCallback(
    async (query: string): Promise<DefaultReactGridSuggestionItem[]> => {
      const [data, preferences] = await Promise.all([loadEmojiData(locale), loadPickerPreferences()]);
      const found = query.trim() === "" ? data.all.slice(0, 100) : searchEmoji(data, query, 100);
      return found.map((entry) => {
        const emoji = withTone(entry, preferences.skinTone);
        return { id: emoji, onItemClick: () => editor.insertInlineContent(emoji + " ") };
      });
    },
    [editor, locale],
  );
  return <GridSuggestionMenuController triggerCharacter=":" columns={10} minQueryLength={2} getItems={getItems} />;
}
