"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { BookmarkCard } from "@/components/page/web-card";
import type { MessagePreview } from "@/lib/messages";
import { call } from "./store";

/**
 * The cards of a message's web links (server/messages/link-previews.ts), drawn as bookmarks are.
 * Their images load from the sites themselves without a referrer (components/page/web-card.tsx).
 * The author can take them away; they stay away after an edit.
 */
export function LinkCards({ messageId, previews, own }: { messageId: string; previews: MessagePreview[]; own: boolean }) {
  const t = useTranslations("messages");
  return (
    <div className="group/cards relative mt-1.5 flex max-w-[520px] flex-col gap-1.5">
      {previews.map((p) => (
        <BookmarkCard key={p.url} bookmark={p} />
      ))}
      {own && (
        <button
          type="button"
          onClick={() => void call("hidePreviews", { messageId }).catch(() => {})}
          aria-label={t("removePreviews")}
          title={t("removePreviews")}
          className="absolute -end-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-bg text-fg-muted opacity-0 shadow-sm transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/cards:opacity-100 pointer-coarse:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
