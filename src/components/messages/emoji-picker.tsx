"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { loadEmojiData, searchEmoji, withTone, type EmojiData } from "@/components/icon-picker/emoji-data";
import { loadPickerPreferences } from "@/components/icon-picker/preferences";
import { menuFieldClass } from "@/components/ui";

/** The reactions offered first, before the whole list. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "✅"] as const;

const RECENT_KEY = "leafdesk:messages-recent-emoji";

export function recentEmoji(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string").slice(0, 16) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, 16)));
  } catch {}
}

/** A searchable grid of emoji (the same data as the icon picker), the person's recent ones first. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const t = useTranslations("messages");
  const locale = useLocale();
  const [data, setData] = useState<EmojiData | null>(null);
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState<number | null>(null);
  useEffect(() => {
    let gone = false;
    void loadEmojiData(locale).then((d) => !gone && setData(d));
    void loadPickerPreferences().then((p) => !gone && setTone(p.skinTone));
    return () => {
      gone = true;
    };
  }, [locale]);
  const recent = useMemo(() => recentEmoji(), []);
  const found = useMemo(() => (data && query.trim() ? searchEmoji(data, query, 120) : null), [data, query]);
  const pick = (emoji: string) => {
    rememberEmoji(emoji);
    onPick(emoji);
  };
  const cell = (emoji: string, key?: string) => (
    <button
      key={key ?? emoji}
      type="button"
      title={data?.labels.get(emoji)}
      onClick={() => pick(emoji)}
      className="flex h-8 w-8 items-center justify-center rounded-md text-xl hover:bg-bg-hover"
    >
      {emoji}
    </button>
  );
  return (
    <div className="flex w-[19rem] flex-col gap-1.5 p-1">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("emojiSearch")}
        aria-label={t("emojiSearch")}
        className={menuFieldClass}
        onKeyDown={(e) => {
          if (e.key === "Enter" && found?.[0]) {
            e.preventDefault();
            pick(withTone(found[0], tone));
          }
        }}
      />
      <div className="max-h-64 overflow-y-auto">
        {found ? (
          found.length ? (
            <div className="grid grid-cols-8">{found.map((e) => cell(withTone(e, tone), e.emoji))}</div>
          ) : (
            <p className="px-1 py-2 text-xs text-fg-faint">{t("emojiNone")}</p>
          )
        ) : (
          <>
            <div className="grid grid-cols-8">{[...new Set([...recent, ...QUICK_REACTIONS])].slice(0, 16).map((e) => cell(e))}</div>
            {data?.categories.map((c) => (
              <div key={c.key} className="grid grid-cols-8 border-t border-border/60 pt-1 mt-1">
                {c.emoji.map((e) => cell(withTone(e, tone), e.emoji))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
