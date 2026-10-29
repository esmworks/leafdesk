"use client";

import { lazyPart } from "@/components/lazy-part";
import type { ChatSourceView } from "@/lib/ai-chat";

/**
 * A chat answer as markdown (answer-markdown.tsx), whose renderer loads with the first chat opened,
 * not with every page; a chat calls `preload()` as it opens, so its messages rarely come first. When
 * they do, the answer holds its place unseen for a moment (`data-show-late`) and only then shows as
 * plain text, so a fast load doesn't flash it.
 */
export const AnswerText = lazyPart<{
  text: string;
  sources: Map<number, ChatSourceView>;
  onSource: (source: ChatSourceView) => void;
}>(
  () => import("./answer-markdown").then((m) => m.default),
  ({ text }) => <p data-show-late className="break-words whitespace-pre-wrap">{text}</p>,
);
