"use client";

import { ChevronLeft, ChevronRight, Download, ExternalLink, Maximize, X, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { useDirection } from "@/components/direction";
import { trapFocus } from "@/components/trap-focus";
import { cn } from "@/components/ui";
import { knownFormat, probeResult, viewerFormat } from "@/lib/file-viewer";
import { formatBytes, isSafeInline } from "@/lib/files";
import { ImageStage, MAX_ZOOM, MIN_ZOOM, type ZoomControl } from "./image-stage";
import { FilePreview } from "./previews";
import type { ViewerFile } from "./index";

/**
 * The file viewer: an overlay over the whole window showing one uploaded file at a time, with the
 * other files of the same page or value a key or a swipe away. Images fit the screen and can be
 * zoomed and moved; PDFs, workbooks, Word documents, video, audio and text of every kind show in
 * their own previews (./previews.tsx); anything else shows its name, size and type with a download.
 *
 * Keys: ← and → go to the previous and next file (mirrored right to left), Esc closes, + − and 0
 * zoom an image. Focus stays inside while it is open and goes back where it was when it closes.
 *
 * What a file is comes from the file route itself: a one-byte range request answers with its
 * stored type, size and name (blocks keep only a URL and a name). An image, video, audio or PDF
 * whose kind the page already knows (a files value's stored type, an image block) shows without
 * waiting for that answer, which then fills in the details; anything else waits for it.
 */

export type Probe = { status: "loading" } | { status: "missing" } | { status: "ready"; size: number | null; type: string; name: string | null };

/** The file's stored type, size and name, from a one-byte range request (see lib/file-viewer probeResult). */
function useProbe(url: string): Probe {
  // Kept with the URL it answers for: the next file reads as loading until its own answer comes.
  const [probe, setProbe] = useState<{ url: string; probe: Probe } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { headers: { Range: "bytes=0-0" }, signal: controller.signal })
      .then((res) => {
        const result = probeResult(res.status, res.headers);
        // Only the headers are wanted.
        void res.body?.cancel().catch(() => {});
        setProbe({ url, probe: result ? { status: "ready", ...result } : { status: "missing" } });
      })
      .catch(() => {
        if (!controller.signal.aborted) setProbe({ url, probe: { status: "missing" } });
      });
    return () => controller.abort();
  }, [url]);
  return probe?.url === url ? probe.probe : { status: "loading" };
}

/** Keys with a meaning of their own where focus is: the viewer leaves them alone there. */
function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, video, audio, [contenteditable=true], [role=tablist], [role=slider]"));
}

const stop = (event: SyntheticEvent) => event.stopPropagation();

export default function FileViewer({ files, start, onClose }: { files: ViewerFile[]; start: number; onClose: () => void }) {
  const t = useTranslations("page.viewer");
  const dir = useDirection();
  const [index, setIndex] = useState(start);
  const file = files[index] ?? files[0];
  const probe = useProbe(file.url);
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const zoom = useRef<ZoomControl | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);

  const count = files.length;
  const go = useCallback((step: number) => setIndex((i) => (count ? (i + step + count) % count : 0)), [count]);

  const name = (probe.status === "ready" && probe.name) || file.name || t("untitled");
  const type = probe.status === "ready" ? probe.type : (file.type ?? "");
  // Before the answer, only what the page knows decides; once it comes, the stored type does.
  const format = probe.status === "ready" ? viewerFormat(name, type || file.type) : probe.status === "loading" ? knownFormat(file.name, file.type, file.shows) : null;
  const isImage = format?.kind === "image";

  // Focus moves in on open and back to where it was on close; the page behind doesn't scroll.
  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    box.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = overflow;
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      trapFocus(event, box.current);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || ownsKeys(event.target)) return;
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    if ((event.key === back || event.key === forward) && count > 1) {
      event.preventDefault();
      go(event.key === forward ? 1 : -1);
    } else if (isImage && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      zoom.current?.zoomBy(1.25);
    } else if (isImage && (event.key === "-" || event.key === "_")) {
      event.preventDefault();
      zoom.current?.zoomBy(0.8);
    } else if (isImage && event.key === "0") {
      event.preventDefault();
      zoom.current?.reset();
    }
  };

  // Keys and presses inside the viewer stop at it, natively: the page's own listeners on the
  // document (a popover's outside click, a panel's Escape, the editor's shortcuts) never see them.
  const keys = useRef(onKeyDown);
  keys.current = onKeyDown;
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      keys.current(event);
    };
    const onPress = (event: MouseEvent) => event.stopPropagation();
    element.addEventListener("keydown", onKey);
    element.addEventListener("mousedown", onPress);
    return () => {
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("mousedown", onPress);
    };
  }, []);

  const details = probe.status === "ready" ? [type || t("unknownType"), probe.size != null ? formatBytes(probe.size) : null].filter(Boolean).join(" · ") : "";
  // Only where the browser shows the same thing: a .ts stored as video/mp2t is code here, not a video.
  const opensInBrowser = probe.status === "ready" && format != null && isSafeInline(type) && ["image", "video", "audio", "pdf"].includes(format.kind);
  const headerButton =
    "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40";
  const Previous = dir === "rtl" ? ChevronRight : ChevronLeft;
  const Next = dir === "rtl" ? ChevronLeft : ChevronRight;

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      // Nothing behind the viewer (a table cell, the editor) acts on what happens in it: React
      // passes events up through the portal to whoever opened it.
      onClick={stop}
      onPointerDown={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onDragStart={stop}
      className="fixed inset-0 z-[100] flex flex-col bg-neutral-950 text-white outline-none"
      data-file-viewer=""
    >
      <div className="flex h-14 shrink-0 items-center gap-1 ps-4 pe-2 sm:gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-sm font-medium" title={name}>
            {name}
          </h2>
          <p className="truncate text-xs text-white/60">
            {details}
            {count > 1 && <span className="sm:hidden">{details ? " · " : ""}{t("counter", { index: index + 1, count })}</span>}
          </p>
        </div>
        {count > 1 && <span className="hidden shrink-0 px-2 text-xs text-white/60 tabular-nums sm:inline">{t("counter", { index: index + 1, count })}</span>}
        {isImage && (
          <div className="hidden items-center sm:flex" role="group" aria-label={t("zoom")}>
            <button type="button" className={headerButton} aria-label={t("zoomOut")} title={t("zoomOut")} disabled={zoomLevel <= MIN_ZOOM} onClick={() => zoom.current?.zoomBy(0.8)}>
              <ZoomOut className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              className="h-9 min-w-14 rounded-md px-1 text-xs text-white/80 tabular-nums hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
              title={t("zoomReset")}
              aria-label={t("zoomResetLevel", { percent: Math.round(zoomLevel * 100) })}
              onClick={() => zoom.current?.reset()}
            >
              {Math.round(zoomLevel * 100)}%
            </button>
            <button type="button" className={headerButton} aria-label={t("zoomIn")} title={t("zoomIn")} disabled={zoomLevel >= MAX_ZOOM} onClick={() => zoom.current?.zoomBy(1.25)}>
              <ZoomIn className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}
        <a href={file.url} download={name} className={headerButton} aria-label={t("download")} title={t("download")}>
          <Download className="h-4 w-4" aria-hidden />
        </a>
        {opensInBrowser && (
          <a href={file.url} target="_blank" rel="noopener" className={headerButton} aria-label={t("openInNewTab")} title={t("openInNewTab")}>
            <ExternalLink className="h-4 w-4" aria-hidden />
          </a>
        )}
        <button type="button" className={headerButton} aria-label={t("close")} title={t("close")} onClick={onClose}>
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-stretch">
        {count > 1 && (
          <button
            type="button"
            className="absolute start-2 top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md bg-black/40 text-white/90 transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-2 focus-visible:outline-white sm:inline-flex"
            aria-label={t("previous")}
            title={t("previous")}
            onClick={() => go(-1)}
          >
            <Previous className="h-6 w-6" aria-hidden />
          </button>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-0 pb-0 sm:px-16 sm:pb-4">
          {probe.status === "missing" ? (
            <Message>{t("unavailable")}</Message>
          ) : !format ? (
            <Message role="status">{t("loading")}</Message>
          ) : format.kind === "image" ? (
            <ImageStage
              key={file.url}
              url={file.url}
              name={name}
              svg={type === "image/svg+xml" || /\.svg$/i.test(name)}
              control={zoom}
              onZoom={setZoomLevel}
              onSwipe={count > 1 ? (step) => go(dir === "rtl" ? -step : step) : undefined}
              failed={<Message>{t("imageFailed")}</Message>}
            />
          ) : (
            <FilePreview key={file.url} file={file} name={name} format={format} size={probe.status === "ready" ? probe.size : null} type={type} />
          )}
        </div>
        {count > 1 && (
          <button
            type="button"
            className="absolute end-2 top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md bg-black/40 text-white/90 transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-2 focus-visible:outline-white sm:inline-flex"
            aria-label={t("next")}
            title={t("next")}
            onClick={() => go(1)}
          >
            <Next className="h-6 w-6" aria-hidden />
          </button>
        )}
      </div>

      {/* On small screens the arrows sit under the file, where a thumb reaches them. */}
      {count > 1 && (
        <div className="flex h-14 shrink-0 items-center justify-between px-2 sm:hidden">
          <button type="button" className={cn(headerButton, "h-11 w-11")} aria-label={t("previous")} onClick={() => go(-1)}>
            <Previous className="h-6 w-6" aria-hidden />
          </button>
          {isImage && (
            <button type="button" className={cn(headerButton, "h-11 w-11")} aria-label={t("zoomReset")} onClick={() => zoom.current?.reset()}>
              <Maximize className="h-5 w-5" aria-hidden />
            </button>
          )}
          <button type="button" className={cn(headerButton, "h-11 w-11")} aria-label={t("next")} onClick={() => go(1)}>
            <Next className="h-6 w-6" aria-hidden />
          </button>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {count > 1 ? t("announce", { name, index: index + 1, count }) : ""}
      </p>
    </div>,
    document.body,
  );
}

/** A note in the middle of the viewer: loading, or why there's nothing to show. */
export function Message({ children, role }: { children: React.ReactNode; role?: "status" }) {
  return (
    <div role={role} className="m-auto max-w-md px-6 text-center text-sm text-white/75">
      {children}
    </div>
  );
}
