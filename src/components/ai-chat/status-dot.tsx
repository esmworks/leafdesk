"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/components/ui";
import type { ConversationStatus } from "@/lib/chat-status";

/**
 * The dot beside a conversation in the chat's lists (lib/chat-status.ts): fading in and out while
 * an answer is being written, steady in the accent color while it waits for the person's decision,
 * steady in the text color for an answer they haven't read. Its words are for screen readers,
 * apart from the dot (whose place may be hidden).
 */
export function StatusDot({ status }: { status: ConversationStatus | null }) {
  if (!status) return null;
  return <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status === "waiting" ? "bg-accent" : "bg-fg", status === "answering" && "motion-safe:animate-pulse")} />;
}

/** What the dot says, for screen readers. */
export function StatusLabel({ status }: { status: ConversationStatus | null }) {
  const t = useTranslations("ai.chat.status");
  if (!status) return null;
  return <span className="sr-only"> {t(status)}</span>;
}
