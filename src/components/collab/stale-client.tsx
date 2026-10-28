"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, cn, DialogBody, DialogFooter, dialogShadow } from "@/components/ui";
import { isStale, onStale } from "./freshness";

/**
 * Covers the app once this tab turns out to run another build than the server (see lib/build-id):
 * its pages no longer load or sync, and nothing behind it can be typed into. No automatic reload:
 * the last edits may still be on their way into this browser's offline copy, and offline a reload
 * would bring back the same cached build. The edits made here are kept and sent after the reload.
 */
export function StaleClientScreen() {
  const t = useTranslations("offline.stale");
  const stale = useSyncExternalStore(onStale, isStale, () => false);
  const [online, setOnline] = useState(true);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!stale) return;
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    // Out of the editor, so keys typed now don't go into a page that can't be saved any more.
    button.current?.focus();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [stale]);

  if (!stale) return null;
  return (
    <div data-window-shade className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 p-4 pt-[18vh]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="stale-client-title"
        aria-describedby="stale-client-body"
        data-dialog
        className={cn("w-full max-w-md overflow-hidden rounded-xl border border-border bg-bg", dialogShadow)}
      >
        <DialogBody className="pt-5">
          <div className="space-y-1.5">
            {/* Not DialogTitle: outside Dialog it has no id to give, and this one keeps its own. */}
            <h2 id="stale-client-title" className="text-base leading-6 font-semibold text-fg">
              {t("title")}
            </h2>
            <p id="stale-client-body" className="text-sm text-fg-muted">
              {online ? t("body") : t("offlineBody")}
            </p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button ref={button} variant="primary" onClick={() => window.location.reload()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("reload")}
          </Button>
        </DialogFooter>
      </div>
    </div>
  );
}
