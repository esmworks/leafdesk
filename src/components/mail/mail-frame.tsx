"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A message's HTML, cleaned on the server (server/mail-client/html.ts), in a frame of its own: its
 * styles stay inside, nothing in it runs (the sandbox has no scripts), and its own content policy
 * lets it load only the images it carries, or images from anywhere once the reader asked for them.
 * Same-origin without scripts, so the page can measure it to show it whole; links open in a new tab.
 */
export function MailFrame({ html, images, title }: { html: string; images: boolean; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const policy = `default-src 'none'; img-src data:${images ? " https: http:" : ""}; style-src 'unsafe-inline'; font-src data:`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base target="_blank"><style>
    html{color-scheme:light}body{display:flow-root;margin:0;padding:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1f2328;background:#fff;overflow-wrap:anywhere}
    img{max-width:100%;height:auto}[data-blocked]{display:none!important}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:2px solid #d0d7de;color:#57606a}
  </style></head><body>${html.replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "")}</body></html>`;
  const styles = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
  const srcDoc = styles ? doc.replace("</head>", `${styles}</head>`) : doc;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const measure = () => {
      const page = frame.contentDocument?.documentElement;
      // Rounded up: scrollHeight rounds a height like 734.4 down, and Chromium scrolls the frame
      // for the fraction left over.
      if (page) setHeight(Math.min(20000, Math.max(60, page.scrollHeight, Math.ceil(page.getBoundingClientRect().height))));
    };
    const resize = new ResizeObserver(measure);
    resize.observe(frame);
    const loaded = () => {
      measure();
      // Images without a size that come in late grow the message: followed as it grows.
      const body = frame.contentDocument?.body;
      if (body) resize.observe(body);
    };
    frame.addEventListener("load", loaded);
    // Fonts arrive after load too: measure again for a few seconds.
    const timer = setInterval(measure, 400);
    const stop = setTimeout(() => clearInterval(timer), 4000);
    return () => {
      frame.removeEventListener("load", loaded);
      clearInterval(timer);
      clearTimeout(stop);
      resize.disconnect();
    };
  }, [srcDoc]);

  // On the white page the message reads as part of it, with no box. In the dark theme it keeps its
  // white page as a card: mail is written for white. Nothing in the frame's own box (no border, no
  // padding), or it would come out of the measured height and the message would scroll inside it.
  return (
    <div className="overflow-hidden bg-white dark:rounded-md dark:p-4">
      <iframe
        ref={ref}
        title={title}
        srcDoc={srcDoc}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="block w-full"
        style={{ height }}
      />
    </div>
  );
}
