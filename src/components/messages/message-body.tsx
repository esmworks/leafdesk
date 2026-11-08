"use client";

import { lazyPart } from "@/components/lazy-part";
import { plainText } from "@/lib/message-text";

/**
 * A message's Markdown (message-markdown.tsx), whose renderer loads after the page: the Messages
 * page preloads it as it opens, so messages rarely come first. When they do, a message holds its
 * place unseen for a moment (`data-show-late`) and then shows as plain text.
 */
export const MessageBody = lazyPart<{ body: string; workspaceId: string; edited?: string | null }>(
  () => import("./message-markdown").then((m) => m.default),
  ({ body }) => (
    <div data-show-late className="min-w-0 text-sm leading-relaxed break-words whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
      {plainText(body)}
    </div>
  ),
);
