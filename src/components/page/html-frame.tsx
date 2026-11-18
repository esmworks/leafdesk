"use client";

import { useEffect, useRef, useState } from "react";
import { cleanHtmlHeight, clampReportedHeight, DEFAULT_HTML_HEIGHT } from "@/lib/html-block";
import { HTML_FRAME_PATH, HTML_FRAME_SANDBOX, type PageToFrame } from "@/lib/html-frame";

/** A short key for a source: a frame is made again when it changes (its document takes one source only). */
function keyOf(source: string): string {
  let hash = 5381;
  for (let i = 0; i < source.length; i++) hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  return `${source.length}:${hash}`;
}

/** Whether the app is drawn dark now: the theme the person chose, else the system's. */
function appIsDark(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark") return true;
  return theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * An HTML block's app (lib/html-block.ts) running in its frame (lib/html-frame.ts): a sandboxed
 * document of its own, with no access to the app or the network, that is sent the source once it
 * says it is ready and reports its height as the content changes. A message counts only when it
 * comes from this frame's window, and a reported height is clamped. The same component draws the
 * block in the editor, on published pages and in the editor's preview.
 */
export function HtmlFrame({ source, title, height, label, className }: { source: string; title: string; height?: number; label: string; className?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const key = keyOf(source);
  const [reported, setReported] = useState<{ key: string; height: number } | null>(null);
  const latest = useRef(source);
  latest.current = source;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target) return;
      const message = event.data as { leafdeskHtml?: unknown; height?: unknown } | null;
      if (!message || typeof message !== "object") return;
      if (message.leafdeskHtml === "ready") {
        const reply: PageToFrame = { leafdeskHtml: "source", source: latest.current, scheme: appIsDark() ? "dark" : "light" };
        // The frame's origin is opaque (the sandbox), so no origin can be named; it holds nothing secret.
        target.postMessage(reply, "*");
      } else if (message.leafdeskHtml === "height") {
        const next = clampReportedHeight(message.height);
        if (next !== null) setReported((current) => (current?.height === next && current.key === key ? current : { key, height: next }));
      }
    };
    globalThis.addEventListener("message", onMessage);
    return () => globalThis.removeEventListener("message", onMessage);
  }, [key]);

  const fixed = cleanHtmlHeight(height);
  const shown = fixed || (reported?.key === key ? reported.height : DEFAULT_HTML_HEIGHT);
  return (
    <iframe
      key={key}
      ref={frame}
      src={HTML_FRAME_PATH}
      title={title ? `${label}: ${title}` : label}
      sandbox={HTML_FRAME_SANDBOX}
      allow=""
      referrerPolicy="no-referrer"
      loading="lazy"
      style={{ height: shown }}
      className={className ?? "block w-full rounded-md border-0"}
    />
  );
}
