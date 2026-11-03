"use client";

import { cn } from "@/components/ui";

/**
 * The sidebar's rail: a column of icons along its start edge, the places the panel beside it shows
 * (pages, daily notes, chats, mail, agents) and the pages it opens itself (My tasks, Meetings),
 * with the workspace and search above them and the inbox, settings and account below. Every item
 * is the same square, so nothing moves under the pointer; its name is a tooltip. g then a letter
 * opens each (lib/shortcuts.ts RAIL_GO_KEYS), shown on its corner while g waits; a count or a dot
 * on the other corner tells what waits there.
 */
export const railItemClass = cn(
  "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg max-md:h-10 max-md:w-10",
  "disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-muted",
);
export const railSelectedClass = "bg-bg-active text-fg hover:bg-bg-active";
export const railIconClass = "h-[18px] w-[18px]";

const countText = (count: number) => (count > 99 ? "99+" : String(count));

/** A count on a rail item's corner (unread mail, the inbox), ringed in the rail's color so it doesn't blur into the icon. */
export function RailCount({ value, tone, selected }: { value: number; tone: "accent" | "danger"; selected?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -top-0.5 -end-0.5 min-w-3.5 rounded-full px-[3px] text-center text-[9px] leading-3.5 font-semibold text-white tabular-nums ring-2",
        tone === "accent" ? "bg-accent" : "bg-danger",
        selected ? "ring-bg-active" : "ring-bg",
      )}
    >
      {countText(value)}
    </span>
  );
}

/**
 * A dot on a rail item's corner, for something waiting without a number: accent for what waits for
 * the person's decision, the text color for what is new, fading while an answer is written.
 */
export function RailDot({ tone, selected }: { tone: "accent" | "new" | "busy"; selected?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-0.5 end-0.5 h-2 w-2 rounded-full ring-2",
        tone === "accent" ? "bg-accent" : "bg-fg",
        tone === "busy" && "motion-safe:animate-pulse",
        selected ? "ring-bg-active" : "ring-bg",
      )}
    />
  );
}

/** The letter that opens a rail item after g (lib/shortcuts.ts RAIL_GO_KEYS), shown on its corner while g waits for it. */
export function RailKey({ letter }: { letter: string }) {
  return (
    <kbd
      aria-hidden
      className="absolute -bottom-0.5 -end-0.5 min-w-3.5 rounded border border-border bg-bg px-[3px] text-center font-sans text-[9px] leading-3 font-semibold text-fg shadow-sm"
    >
      {letter}
    </kbd>
  );
}

export type RailTab = {
  key: string;
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  disabled?: boolean;
  /** Why it is disabled, in place of the label's tooltip. */
  title?: string;
  /** A count on the icon's corner (unread mail), with its words for screen readers. */
  count?: { value: number; label: string; tone?: "accent" | "danger" };
  /** A dot on its corner (an answer waiting, something new), with its words for screen readers; a count wins over it. */
  dot?: { tone: "accent" | "new" | "busy"; label: string };
  /** The letter that opens it after g (RAIL_GO_KEYS). */
  goKey?: string;
  onClick: () => void;
  /** The pointer rests on it, or leaves it (the hidden panel peeks out with what it shows). */
  onHover?: () => void;
  onLeave?: () => void;
};

/**
 * The rail's places, a vertical tab list: ↑ and ↓ (Home and End) move between them, Enter or Space
 * opens one. Only the selected one is in the Tab order.
 */
export function RailTabs({ label, tabs, goKeys }: { label: string; tabs: RailTab[]; goKeys?: boolean }) {
  const focusable = tabs.find((tab) => tab.selected && !tab.disabled) ?? tabs.find((tab) => !tab.disabled);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]:not(:disabled)")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown" ? items[(at + 1) % items.length]
      : e.key === "ArrowUp" ? items[(at - 1 + items.length) % items.length]
      : e.key === "Home" ? items[0]
      : e.key === "End" ? items.at(-1)
      : undefined;
    if (!next) return;
    e.preventDefault();
    next.focus();
  };
  return (
    <div role="tablist" aria-orientation="vertical" aria-label={label} onKeyDown={onKeyDown} className="flex flex-col items-center gap-1">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={tab.selected}
          aria-label={tab.count ? `${tab.label} · ${tab.count.label}` : tab.dot ? `${tab.label} · ${tab.dot.label}` : tab.label}
          title={tab.title ?? (tab.goKey ? `${tab.label} (G ${tab.goKey})` : tab.label)}
          tabIndex={tab === focusable ? 0 : -1}
          disabled={tab.disabled}
          onClick={tab.onClick}
          onMouseEnter={tab.onHover}
          onMouseLeave={tab.onLeave}
          className={cn(railItemClass, tab.selected && railSelectedClass)}
        >
          {tab.icon}
          {tab.count ? (
            <RailCount value={tab.count.value} tone={tab.count.tone ?? "danger"} selected={tab.selected} />
          ) : (
            tab.dot && <RailDot tone={tab.dot.tone} selected={tab.selected} />
          )}
          {goKeys && tab.goKey && !tab.disabled && <RailKey letter={tab.goKey} />}
        </button>
      ))}
    </div>
  );
}
