"use client";

import { Ban } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn, Popover } from "@/components/ui";
import {
  BACKGROUND_COLORS,
  BACKGROUND_PATTERNS,
  pageBackground,
  type BackgroundColor,
  type BackgroundPattern,
  type PageBackground,
} from "@/lib/page-background";

const SWATCH = "flex h-7 items-center justify-center rounded-md border border-border ring-offset-2 ring-offset-bg hover:opacity-85";

/** Choose a page's background color and pattern, or remove them. Stays open so both can be tried. */
export function BackgroundPicker({
  background,
  onChange,
  align,
  children,
}: {
  background: PageBackground | null;
  onChange: (background: PageBackground | null) => void;
  /** "end" opens the picker leftwards, for a trigger near the right edge. */
  align?: "start" | "end";
  children: (toggle: () => void) => React.ReactNode;
}) {
  const t = useTranslations("page.background");
  const color = background?.color ?? null;
  const pattern = background?.pattern ?? null;
  const set = (nextColor: BackgroundColor | null, nextPattern: BackgroundPattern | null) => {
    if (nextColor !== color || nextPattern !== pattern) onChange(pageBackground(nextColor, nextPattern));
  };

  const none = (active: boolean, onClick: () => void) => (
    <button
      type="button"
      aria-label={t("none")}
      aria-pressed={active}
      title={t("none")}
      onClick={onClick}
      className={cn(SWATCH, "bg-bg text-fg-faint", active && "ring-2 ring-accent")}
    >
      <Ban className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <Popover trigger={({ toggle }) => <>{children(toggle)}</>} align={align} className="w-72 p-2">
      {(close) => (
        <div className="space-y-3 font-sans">
          <div>
            <p className="mb-1.5 px-0.5 text-xs font-medium text-fg-muted">{t("colors")}</p>
            <div className="grid grid-cols-9 gap-1.5">
              {none(!color, () => set(null, pattern))}
              {BACKGROUND_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={t(`colorNames.${c}`)}
                  aria-pressed={color === c}
                  title={t(`colorNames.${c}`)}
                  onClick={() => set(c, pattern)}
                  // The swatch shows the stronger option color so the light tints tell apart.
                  className={cn(c === "black" ? "bg-[#0e0f10]" : `opt-${c}`, SWATCH, color === c && "ring-2 ring-accent")}
                />
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 px-0.5 text-xs font-medium text-fg-muted">{t("patterns")}</p>
            <div className="grid grid-cols-5 gap-1.5">
              {none(!pattern, () => set(color, null))}
              {BACKGROUND_PATTERNS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-label={t(`patternNames.${p}`)}
                  aria-pressed={pattern === p}
                  title={t(`patternNames.${p}`)}
                  onClick={() => set(color, p)}
                  // Drawn like the page's own pattern, so it shows in the page's colors.
                  className={cn(`page-pattern page-pattern-${p}`, SWATCH, "h-9 overflow-hidden bg-bg", pattern === p && "ring-2 ring-accent")}
                />
              ))}
            </div>
          </div>
          {background && (
            <button
              type="button"
              onClick={() => {
                onChange(null);
                close();
              }}
              className="w-full rounded px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-bg-hover"
            >
              {t("remove")}
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}
