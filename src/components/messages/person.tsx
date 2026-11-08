"use client";

import { Bot } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";
import { cn } from "@/components/ui";
import { textOn, userColor } from "@/lib/presence";
import type { View } from "./store";

const DOT = { xs: "h-2 w-2", sm: "h-2.5 w-2.5", md: "h-2.5 w-2.5", lg: "h-3 w-3" } as const;

/**
 * A person's face in Messages: their picture or initial in their color, with a dot for whether
 * they are here (filled: active; ringed: away; none: offline). An agent shows the robot. A group
 * conversation shows how many are in it instead of a dot.
 */
export function PersonFace({ s, userId, size = "md", count, presence = true }: { s: Pick<View, "people" | "presence">; userId: string; size?: "xs" | "sm" | "md" | "lg"; count?: number; presence?: boolean }) {
  const person = s.people.get(userId);
  const name = person?.name || person?.email || "?";
  const color = userColor(userId);
  const state = s.presence[userId] ?? "offline";
  return (
    <span className="relative inline-flex shrink-0">
      {person?.agent ? (
        <span className={cn("flex items-center justify-center rounded-full bg-bg-active text-fg-muted", size === "xs" ? "h-5 w-5" : size === "sm" ? "h-6 w-6" : size === "md" ? "h-7 w-7" : "h-9 w-9")}>
          <Bot className={size === "xs" ? "h-3 w-3" : "h-4 w-4"} />
        </span>
      ) : (
        <UserAvatar name={name} image={person?.image} size={size} colors="" style={{ background: color, color: textOn(color) }} />
      )}
      {count ? (
        <span className="absolute -end-1 -bottom-1 min-w-3.5 rounded-full bg-bg px-0.5 text-center text-[9px] leading-3.5 font-semibold text-fg-muted ring-1 ring-border tabular-nums">{count}</span>
      ) : (
        presence &&
        !person?.agent &&
        state !== "offline" && (
          <span
            aria-hidden
            className={cn("absolute -end-0.5 -bottom-0.5 rounded-full ring-2 ring-bg", DOT[size], state === "active" ? "bg-accent" : "border-2 border-fg-faint bg-bg")}
          />
        )
      )}
    </span>
  );
}
