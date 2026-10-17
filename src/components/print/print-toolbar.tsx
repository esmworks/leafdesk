"use client";

import { ArrowLeft, Printer } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, Switch } from "@/components/ui";
import { printPath } from "@/lib/print";

/** Longest wait for images, fonts and diagrams before printing anyway. */
const READY_TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves once what the printout shows has loaded: web fonts, every image (loaded or failed)
 * and every Mermaid diagram (drawn or failed, see PublishedMermaid), or after READY_TIMEOUT_MS.
 * Lazy images are made eager first, as the browser won't load those below the fold for print.
 */
async function whenReady(root: HTMLElement) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (const img of root.querySelectorAll("img")) img.loading = "eager";
  // Toggles print open: a closed one would hide what it holds.
  for (const details of root.querySelectorAll("details")) details.open = true;
  await Promise.race([document.fonts?.ready, sleep(READY_TIMEOUT_MS)]);
  while (Date.now() < deadline) {
    const images = [...root.querySelectorAll("img")];
    const waiting = images.some((img) => !img.complete) || root.querySelector('[data-leafdesk-mermaid="pending"]');
    if (!waiting) break;
    await sleep(100);
  }
  // Decoded before the dialog takes its snapshot of the page. A page that isn't being drawn (a
  // background tab) may never finish decoding, so this waits a moment at most.
  const decoded = Promise.all([...root.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)));
  await Promise.race([decoded, sleep(Math.min(2_000, Math.max(0, deadline - Date.now())))]);
}

/**
 * The print view's bar (not printed): back to the page, "Include subpages" and the print button.
 * With `auto` (the page menu's "Export as PDF") the print dialog opens by itself once everything
 * has loaded; `data-print-ready` on <html> says when that is (for tests).
 */
export function PrintToolbar({
  workspaceId,
  pageId,
  subpages,
  canIncludeSubpages,
  auto,
}: {
  workspaceId: string;
  pageId: string;
  subpages: boolean;
  canIncludeSubpages: boolean;
  auto: boolean;
}) {
  const t = useTranslations("page.print");
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const wantPrint = useRef(auto);

  useEffect(() => {
    let cancelled = false;
    const root = document.querySelector<HTMLElement>("[data-print-view]") ?? document.body;
    setReady(false);
    delete document.documentElement.dataset.printReady;
    void whenReady(root).then(() => {
      if (cancelled) return;
      setReady(true);
      document.documentElement.dataset.printReady = "1";
      if (!wantPrint.current) return;
      wantPrint.current = false;
      // Reloading the page shouldn't open the dialog again.
      window.history.replaceState(window.history.state, "", printPath(pageId, { subpages }));
      window.print();
    });
    return () => {
      cancelled = true;
    };
  }, [pageId, subpages]);

  const print = () => {
    if (ready) window.print();
    else wantPrint.current = true;
  };

  return (
    <div className="sticky top-0 z-20 border-b border-border bg-bg/90 backdrop-blur print:hidden">
      <div className="mx-auto flex min-h-11 max-w-[900px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-1.5 sm:px-[54px]">
        <Link
          href={`/w/${workspaceId}/p/${pageId}`}
          className="-ms-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />
          {t("back")}
        </Link>
        <div className="ms-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          {canIncludeSubpages && (
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              <Switch
                checked={subpages}
                label={t("includeSubpages")}
                onChange={(next) => router.replace(printPath(pageId, { subpages: next }))}
              />
              <span aria-hidden>{t("includeSubpages")}</span>
            </label>
          )}
          <Button variant="primary" onClick={print} title={t("hint")}>
            <Printer className="h-4 w-4" />
            {t("print")}
          </Button>
        </div>
      </div>
      {!ready && (
        <p role="status" className="mx-auto max-w-[900px] px-4 pb-1.5 text-xs text-fg-faint sm:px-[54px]">
          {t("preparing")}
        </p>
      )}
    </div>
  );
}
