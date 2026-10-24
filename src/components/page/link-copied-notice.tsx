"use client";

import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BLOCK_LINK_COPIED_EVENT } from "./editor-shortcuts";

/** How long "Link copied" stays. */
const SHOWN_MS = 1800;

/**
 * "Link copied" for a moment at the bottom of the window, after a link to a block was copied
 * (Alt+Shift+L or the block menu, see editor-shortcuts.ts). Screen readers hear it too.
 */
export function LinkCopiedNotice() {
  const t = useTranslations("page.header");
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const onCopied = () => setShown((n) => n + 1);
    window.addEventListener(BLOCK_LINK_COPIED_EVENT, onCopied);
    return () => window.removeEventListener(BLOCK_LINK_COPIED_EVENT, onCopied);
  }, []);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(0), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center print:hidden">
      {shown > 0 && (
        <span className="flex items-center gap-1.5 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg shadow-lg">
          <Check className="h-4 w-4 text-accent" aria-hidden />
          {t("linkCopied")}
        </span>
      )}
    </div>
  );
}
