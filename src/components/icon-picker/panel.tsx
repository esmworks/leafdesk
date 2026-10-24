"use client";

import { Shuffle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import BuiltinIconDrawing from "@/components/builtin-icon-drawing";
import { cn, IconButton, Input } from "@/components/ui";
import { BUILTIN_ICON_EMOJI, BUILTIN_ICON_NAMES } from "@/lib/builtin-icon-names";
import { indexNames, searchByNames, type NameIndex } from "@/lib/emoji-search";
import { formatBuiltinIcon, ICON_COLORS, readBuiltinIcon, type IconColor } from "@/lib/icon-value";
import { loadEmojiData, searchEmoji, withTone, type EmojiData, type EmojiEntry } from "./emoji-data";
import { loadPickerPreferences, savePickerPreferences } from "./preferences";

/** The categories' messages (page.icon.categories), by their key in public/emoji/emoji.json, with an emoji for each. */
const CATEGORIES: Record<string, { label: string; emoji: string }> = {
  "smileys-emotion": { label: "smileys", emoji: "😀" },
  "people-body": { label: "people", emoji: "👋" },
  "animals-nature": { label: "nature", emoji: "🌿" },
  "food-drink": { label: "food", emoji: "🍔" },
  "travel-places": { label: "travel", emoji: "✈️" },
  activities: { label: "activities", emoji: "⚽" },
  objects: { label: "objects", emoji: "💡" },
  symbols: { label: "symbols", emoji: "🔣" },
  flags: { label: "flags", emoji: "🏁" },
};

const TONE_HANDS = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];

const iconLabel = (name: string) => name.replace(/-/g, " ");

/**
 * The icon picker: emoji by category, or built-in line icons in a color, with search in the
 * interface language, a random pick, and "Remove" while there is an icon. The skin tone and icon
 * color chosen here are remembered for the person (server/icon-preferences.ts).
 */
export default function IconPickerPanel({ icon, onChange }: { icon: string | null; onChange: (icon: string | null) => void }) {
  const t = useTranslations("page.icon");
  const tColor = useTranslations("database.colors");
  const locale = useLocale();
  const current = readBuiltinIcon(icon);
  const [tab, setTab] = useState<"emoji" | "icons">(current ? "icons" : "emoji");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<EmojiData | null>(null);
  const [failed, setFailed] = useState(false);
  const [category, setCategory] = useState(0);
  const [tone, setTone] = useState<number | null>(null);
  const [tonesOpen, setTonesOpen] = useState(false);
  const [color, setColor] = useState<IconColor | null>(current?.color ?? null);
  const hasBuiltin = !!current;
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    loadEmojiData(locale).then(
      (loaded) => live && setData(loaded),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [locale]);

  useEffect(() => {
    let live = true;
    void loadPickerPreferences().then((p) => {
      if (!live) return;
      setTone(p.skinTone);
      if (!hasBuiltin) setColor(p.iconColor);
    });
    return () => {
      live = false;
    };
  }, [hasBuiltin]);

  // Built-in icons are found by their English names and by the names of an emoji meaning the same.
  const iconIndex = useMemo(() => {
    const index = new Map<string, NameIndex>();
    for (const name of BUILTIN_ICON_NAMES) {
      const emoji = BUILTIN_ICON_EMOJI.get(name);
      const emojiNames = emoji && data ? data.names.get(emoji) : undefined;
      index.set(name, indexNames([iconLabel(name), ...(emojiNames?.words ?? [])].join("|")));
    }
    return index;
  }, [data]);

  const pickEmoji = (entry: EmojiEntry) => onChange(withTone(entry, tone));
  const pickIcon = (name: string) => onChange(formatBuiltinIcon(name, color));
  const random = () => {
    if (tab === "icons") pickIcon(BUILTIN_ICON_NAMES[Math.floor(Math.random() * BUILTIN_ICON_NAMES.length)]);
    else if (data) pickEmoji(data.all[Math.floor(Math.random() * data.all.length)]);
  };
  const chooseTone = (next: number | null) => {
    setTone(next);
    setTonesOpen(false);
    savePickerPreferences({ skinTone: next });
  };
  const chooseColor = (next: IconColor | null) => {
    setColor(next);
    savePickerPreferences({ iconColor: next });
  };

  const searching = query.trim() !== "";
  const emojiShown = !data ? [] : searching ? searchEmoji(data, query) : (data.categories[category]?.emoji ?? []);
  const iconsShown = searching ? searchByNames(BUILTIN_ICON_NAMES, (name) => iconIndex.get(name), query, 400) : BUILTIN_ICON_NAMES;
  const first = () => {
    if (tab === "icons" && iconsShown[0]) pickIcon(iconsShown[0]);
    if (tab === "emoji" && emojiShown[0]) pickEmoji(emojiShown[0]);
  };

  const cell = "flex h-9 w-9 items-center justify-center rounded-md hover:bg-bg-hover focus-visible:bg-bg-hover";
  return (
    <div className="flex w-[21.5rem] max-w-[calc(100vw-1.5rem)] flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2">
        {(["emoji", "icons"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setTab(key);
              setTonesOpen(false);
            }}
            aria-pressed={tab === key}
            className={cn(
              "-mb-px border-b-2 px-2 py-2 text-sm",
              tab === key ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            {t(key === "emoji" ? "emojiTab" : "iconsTab")}
          </button>
        ))}
        <span className="flex-1" />
        {icon && (
          <button type="button" onClick={() => onChange(null)} className="rounded px-2 py-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg">
            {t("remove")}
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 p-2">
        {tonesOpen ? (
          <div className="flex flex-1 items-center gap-0.5" role="group" aria-label={t("skinTone")}>
            {TONE_HANDS.map((hand, i) => (
              <button
                key={hand}
                type="button"
                title={t(`tones.${i}` as "tones.0")}
                aria-label={t(`tones.${i}` as "tones.0")}
                aria-pressed={(tone ?? 0) === i}
                onClick={() => chooseTone(i || null)}
                className={cn(cell, "text-xl", (tone ?? 0) === i && "bg-bg-active")}
              >
                {hand}
              </button>
            ))}
          </div>
        ) : (
          <Input
            autoFocus
            value={query}
            placeholder={t(tab === "emoji" ? "searchEmoji" : "searchIcons")}
            aria-label={t(tab === "emoji" ? "searchEmoji" : "searchIcons")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                first();
              }
            }}
            className="h-8 flex-1"
          />
        )}
        <IconButton label={t("random")} onClick={random} className="h-8 w-8 shrink-0">
          <Shuffle className="h-4 w-4" />
        </IconButton>
        {tab === "emoji" && (
          <IconButton
            label={t("skinTone")}
            aria-expanded={tonesOpen}
            onClick={() => setTonesOpen(!tonesOpen)}
            className="h-8 w-8 shrink-0 text-lg"
          >
            {TONE_HANDS[tone ?? 0]}
          </IconButton>
        )}
      </div>
      {tab === "icons" && (
        <div className="flex items-center gap-1 px-2 pb-2" role="group" aria-label={t("color")}>
          {([null, ...ICON_COLORS] as const).map((c) => (
            <button
              key={c ?? "default"}
              type="button"
              title={c ? tColor(c) : t("textColor")}
              aria-label={c ? tColor(c) : t("textColor")}
              aria-pressed={color === c}
              onClick={() => chooseColor(c)}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md hover:bg-bg-hover",
                color === c && "bg-bg-active ring-1 ring-border",
              )}
            >
              <span className={cn("h-4 w-4 rounded-[4px]", c ? `icon-${c}` : "text-fg")} style={{ background: "currentColor" }} />
            </button>
          ))}
        </div>
      )}
      {tab === "emoji" && !searching && data && (
        <div className="flex items-center justify-between px-2 pb-1" role="tablist" aria-label={t("categoriesLabel")}>
          {data.categories.map((c, i) => {
            const meta = CATEGORIES[c.key];
            const label = meta ? t(`categories.${meta.label}` as "categories.smileys") : c.key;
            return (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={category === i}
                title={label}
                aria-label={label}
                onClick={() => {
                  setCategory(i);
                  body.current?.scrollTo({ top: 0 });
                }}
                className={cn("flex h-8 w-8 items-center justify-center rounded-md text-base hover:bg-bg-hover", category === i ? "bg-bg-active" : "opacity-70")}
              >
                {meta?.emoji ?? "•"}
              </button>
            );
          })}
        </div>
      )}
      <div ref={body} className="h-64 overflow-y-auto px-2 pb-2">
        {tab === "emoji" ? (
          !data ? (
            <p className="px-1 py-6 text-center text-sm text-fg-faint">{failed ? t("loadFailed") : t("loading")}</p>
          ) : (
            <>
              {!searching && data.categories[category] && (
                <div className="sticky top-0 bg-bg px-1 pt-1 pb-1 text-xs text-fg-muted">
                  {t(`categories.${CATEGORIES[data.categories[category].key]?.label ?? "symbols"}` as "categories.smileys")}
                </div>
              )}
              {emojiShown.length ? (
                <div className="grid grid-cols-9">
                  {emojiShown.map((entry) => {
                    const shown = withTone(entry, tone);
                    const label = data.labels.get(entry.emoji) ?? "";
                    return (
                      <button
                        key={entry.emoji}
                        type="button"
                        title={label}
                        aria-label={label}
                        onClick={() => pickEmoji(entry)}
                        className={cn(cell, "text-[1.35rem] leading-none", (icon === shown || icon === entry.emoji) && "bg-bg-active")}
                      >
                        {shown}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="px-1 py-6 text-center text-sm text-fg-faint">{t("noMatches")}</p>
              )}
            </>
          )
        ) : iconsShown.length ? (
          <div className={cn("grid grid-cols-9 text-xl", color ? `icon-${color}` : "text-fg-muted")}>
            {iconsShown.map((name) => (
              <button
                key={name}
                type="button"
                title={iconLabel(name)}
                aria-label={iconLabel(name)}
                onClick={() => pickIcon(name)}
                className={cn(cell, current?.name === name && "bg-bg-active")}
              >
                <BuiltinIconDrawing name={name} />
              </button>
            ))}
          </div>
        ) : (
          <p className="px-1 py-6 text-center text-sm text-fg-faint">{t("noMatches")}</p>
        )}
      </div>
    </div>
  );
}
