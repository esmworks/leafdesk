import { useEffect } from "react";
import { recordPageViewAction } from "@/app/actions/page-views";
import { shouldSendView, VIEW_SEND_DELAY_MS } from "@/lib/page-views";

/** When this tab last sent a view of each page, so reopening it soon after sends nothing. */
const sent = new Map<string, number>();

/**
 * Sends a view of the page (server/page-views.ts) once it has been open VIEW_SEND_DELAY_MS: after
 * its first paint and only for pages someone stays on, not those passed through. Fire-and-forget:
 * the server decides whether it counts, and a failure (offline, signed out) changes nothing.
 * `pageId` null sends none (a page in the trash).
 */
export function useRecordView(pageId: string | null) {
  useEffect(() => {
    if (!pageId) return;
    const timer = setTimeout(() => {
      const now = Date.now();
      if (!shouldSendView(sent.get(pageId), now)) return;
      sent.set(pageId, now);
      recordPageViewAction(pageId).catch(() => {});
    }, VIEW_SEND_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pageId]);
}
