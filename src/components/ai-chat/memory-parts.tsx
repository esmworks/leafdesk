"use client";

/** What the Memory page's list and its panel both draw: a note's kind color and who kept it. */
import { UserAvatar } from "@/components/user-avatar";
import { cn } from "@/components/ui";
import type { MemoryCategory, MemoryView } from "@/lib/ai-chat";
import { appLogo } from "@/lib/app-logos";
import { textOn, userColor } from "@/lib/presence";

/** A note as the page shows it: a shared one's last editor, their id and picture. */
export type Note = MemoryView & { by?: string | null; byId?: string | null; byImage?: string | null };

/** Each kind's label color (globals.css `.opt-*`). */
export const KIND_COLOR: Record<MemoryCategory, string> = { profile: "opt-blue", preference: "opt-purple", work: "opt-green", other: "opt-gray" };

/**
 * Who kept a note, as its row shows them: `app` for a connected app (its logo when it is a known
 * one), else a person (their picture). `colorKey` picks the color of the initial shown without one.
 */
export type AuthorCardProps = { name: string; image: string | null; role: string; colorKey: string; app: boolean };

/** The face of who kept a note: an app's logo, a person's picture, or an initial in their color. */
export function Face({ card, size = "xs" }: { card: AuthorCardProps; size?: "xs" | "lg" }) {
  const logo = card.app ? appLogo(card.name) : null;
  if (logo) {
    return <img src={logo} alt="" aria-hidden className={cn("shrink-0 rounded-md bg-white object-contain", size === "xs" ? "h-5 w-5" : "h-9 w-9 rounded-lg")} />;
  }
  const color = userColor(card.colorKey);
  return (
    <UserAvatar
      name={card.name}
      image={card.app ? null : card.image}
      size={size}
      colors=""
      // An app is a rounded square, a person a circle.
      className={card.app ? (size === "xs" ? "rounded-md" : "rounded-lg") : undefined}
      style={{ background: color, color: textOn(color) }}
    />
  );
}

/**
 * Who kept a note, shown over its name while the pointer rests there (inside a `group/author`):
 * their picture, name and what they are to the note. Only for pointers; the name is beside it.
 */
export function AuthorCard({ below = false, ...card }: AuthorCardProps & { below?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none invisible absolute end-0 z-30 flex w-64 items-center gap-3 rounded-lg border border-border bg-bg p-3 text-start opacity-0 shadow-lg transition-opacity group-hover/author:visible group-hover/author:opacity-100 group-hover/author:delay-300",
        below ? "top-full mt-1.5 inset-s-0 end-auto" : "bottom-full mb-1.5",
      )}
    >
      <Face card={card} size="lg" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg">{card.name}</span>
        <span className="block truncate text-xs text-fg-muted">{card.role}</span>
      </span>
    </span>
  );
}

