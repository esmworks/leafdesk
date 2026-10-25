"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { cn } from "@/components/ui";

/** Most thumbnails a comment shows before the rest fold into a "+N" tile. */
const SHOWN = 4;

/**
 * The images attached to a comment (lib/comments CommentImages): one shows larger, several as
 * thumbnails, and more than four fold into a tile that shows the rest. Each opens in a new tab;
 * `onRemove` (in the comment box) takes one out.
 */
export function CommentImageGallery({ urls, onRemove }: { urls: string[]; onRemove?: (url: string) => void }) {
  const t = useTranslations("page.comments");
  const [open, setOpen] = useState(false);
  if (!urls.length) return null;
  const folds = urls.length > SHOWN;
  const shown = folds && !open ? urls.slice(0, SHOWN - 1) : urls;
  const one = urls.length === 1;
  return (
    <div className="comment-images flex flex-wrap items-start gap-1.5 py-1" contentEditable={false}>
      {shown.map((url, i) => (
        <span key={url} className="group/image relative">
          <a href={url} target="_blank" rel="noopener noreferrer" className="block">
            <img
              src={url}
              alt={t("imageAlt", { number: i + 1 })}
              loading="lazy"
              draggable={false}
              className={cn("rounded-md border border-border bg-bg-subtle object-cover", one ? "max-h-48 max-w-full" : "h-20 w-20")}
            />
          </a>
          {onRemove && (
            <button
              type="button"
              aria-label={t("removeImage")}
              title={t("removeImage")}
              onClick={() => onRemove(url)}
              className="absolute top-1 inset-e-1 flex h-5 w-5 items-center justify-center rounded-full bg-bg/90 text-fg-muted shadow-sm hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {folds && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className={cn(
            "flex items-center justify-center rounded-md border border-border bg-bg-subtle text-sm font-medium text-fg-muted hover:text-fg",
            open ? "h-8 px-2" : "h-20 w-20",
          )}
        >
          {open ? t("fewerImages") : t("moreImages", { count: urls.length - shown.length })}
        </button>
      )}
    </div>
  );
}
