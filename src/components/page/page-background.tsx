"use client";

import { useTranslations } from "next-intl";
import { cn, Popover } from "@/components/ui";
import { BACKGROUND_COLORS, type PageBackground } from "@/lib/page-background";

/** Choose a page's background color, or remove it. */
export function BackgroundPicker({
  background,
  onChange,
  children,
}: {
  background: PageBackground | null;
  onChange: (background: PageBackground | null) => void;
  children: (toggle: () => void) => React.ReactNode;
}) {
  const t = useTranslations("page.background");

  return (
    <Popover trigger={({ toggle }) => <>{children(toggle)}</>} className="w-72 p-2">
      {(close) => {
        const choose = (next: PageBackground | null) => {
          onChange(next);
          close();
        };
        return (
          <div className="space-y-2 font-sans">
            <div>
              <p className="mb-1.5 px-0.5 text-xs font-medium text-fg-muted">{t("colors")}</p>
              <div className="grid grid-cols-7 gap-1.5">
                {BACKGROUND_COLORS.map((color) => {
                  const active = background?.color === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      aria-label={t(`colorNames.${color}`)}
                      aria-pressed={active}
                      title={t(`colorNames.${color}`)}
                      onClick={() => choose({ kind: "color", color })}
                      // The swatch shows the stronger option color so the light tints tell apart.
                      className={cn(
                        `opt-${color}`,
                        "h-7 rounded-md border border-border ring-offset-2 ring-offset-bg hover:opacity-85",
                        active && "ring-2 ring-accent",
                      )}
                    />
                  );
                })}
              </div>
            </div>
            {background && (
              <button
                type="button"
                onClick={() => choose(null)}
                className="w-full rounded px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-bg-hover"
              >
                {t("remove")}
              </button>
            )}
          </div>
        );
      }}
    </Popover>
  );
}
