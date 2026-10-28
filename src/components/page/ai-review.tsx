"use client";

import { Check, Sparkles, Undo2, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { decidePageReviewAction, getPageReviewAction } from "@/app/actions/pages";
import { Button, cn, dialogShadow, IconButton } from "@/components/ui";
import { AI_EDIT_EVENT, COLLAB_FRAGMENT } from "@/lib/collab-constants";
import type { PageReview } from "@/server/page-review";
import { BlockChanges, useActorLabels } from "./history-diff";
import type { PageDoc } from "./use-page-doc";

/** How long the body has to rest after a change before the review is looked up again. */
const REFRESH_DELAY_MS = 800;

/**
 * The AI changes to the page waiting for review (server/page-review.ts): a bar above the body with
 * how many there are, and a panel to keep or undo them one by one. Looked up when the page opens,
 * when an AI write tells open pages about itself (AI_EDIT_EVENT), and while it shows, after every
 * change of the body: an edit by anyone ends the review.
 */
export function AiReviewBar({ pageId, pageDoc, enabled }: { pageId: string; pageDoc: PageDoc | null; enabled: boolean }) {
  const t = useTranslations("page.review");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [review, setReview] = useState<PageReview | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"stale" | "failed" | null>(null);
  // Answers to earlier lookups that come back late are dropped.
  const asked = useRef(0);
  const shown = enabled ? review : null;

  const refresh = useCallback(async () => {
    const n = ++asked.current;
    try {
      const next = await getPageReviewAction(pageId);
      if (n === asked.current) setReview(next);
    } catch {
      // Offline or a failed lookup: the bar stays as it was until the next change.
    }
  }, [pageId]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const provider = pageDoc?.provider;
  useEffect(() => {
    if (!provider || !enabled) return;
    const onStateless = ({ payload }: { payload: string }) => {
      if (payload === AI_EDIT_EVENT) void refresh();
    };
    provider.on("stateless", onStateless);
    return () => void provider.off("stateless", onStateless);
  }, [provider, enabled, refresh]);

  const doc = pageDoc?.doc;
  const reviewing = shown !== null;
  useEffect(() => {
    if (!doc || !reviewing) return;
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_DELAY_MS);
    };
    fragment.observeDeep(onChange);
    return () => {
      clearTimeout(timer);
      fragment.unobserveDeep(onChange);
    };
  }, [doc, reviewing, refresh]);

  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  const actors = useActorLabels(shown?.actors ?? []);
  if (!shown) return null;
  const count = shown.ids.filter(Boolean).length;

  async function decide(changeId: string | null, decision: "keep" | "undo") {
    if (!shown || busy) return;
    setBusy(true);
    setNotice(null);
    asked.current++;
    try {
      const result = await decidePageReviewAction(pageId, shown.version, changeId, decision);
      setReview(result.review);
      if (result.stale) setNotice("stale");
    } catch {
      setNotice("failed");
    } finally {
      setBusy(false);
    }
  }

  const allButtons = (
    <>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide(null, "keep")}>
        <Check className="h-3.5 w-3.5" /> {t("keepAll")}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide(null, "undo")}>
        <Undo2 className="h-3.5 w-3.5" /> {t("undoAll")}
      </Button>
    </>
  );

  return (
    <>
      <div
        role="region"
        aria-label={t("title")}
        className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-bg-subtle px-3 py-1.5 font-sans text-sm"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-accent" />
          <span className="min-w-0">
            <span className="font-medium">{t("bar", { count })}</span>
            {actors.length > 0 && <span className="text-fg-muted"> · {t("by", { names: format.list(actors) })}</span>}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            {t("open")}
          </Button>
          {allButtons}
        </span>
        {notice && !open && <p className="w-full text-xs text-fg-muted">{t(notice)}</p>}
      </div>
      {open && (
        <div
          data-window-shade
          className="fixed inset-0 z-40 flex bg-black/30"
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("title")}
            className={cn("flex h-full w-full flex-col overflow-hidden bg-bg font-sans md:m-auto md:h-[80vh] md:max-w-3xl md:rounded-xl md:border md:border-border", dialogShadow)}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
              <div className="min-w-0">
                <h2 className="text-sm font-medium">{t("title")}</h2>
                <p className="mt-0.5 text-xs text-fg-muted">
                  {t("bar", { count })}
                  {actors.length > 0 && ` · ${t("by", { names: format.list(actors) })}`}
                </p>
              </div>
              <IconButton label={tc("close")} onClick={() => setOpen(false)} autoFocus>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
            <div className="flex-1 space-y-0.5 overflow-y-auto px-4 py-4 leading-relaxed md:px-8">
              <BlockChanges
                key={`${shown.version}:${count}`}
                changes={shown.changes}
                actions={(index) => {
                  const id = shown.ids[index];
                  if (!id) return null;
                  return (
                    <span className="flex shrink-0 gap-0.5">
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide(id, "keep")}>
                        {t("keep")}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide(id, "undo")}>
                        {t("undo")}
                      </Button>
                    </span>
                  );
                }}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
              <p className="min-w-0 flex-1 text-xs text-fg-muted">{notice ? t(notice) : t("hint")}</p>
              <span className="flex shrink-0 gap-1">{allButtons}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
