"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** The tallest a message is shown whole; a longer one scrolls in its frame. */
const MAX_HEIGHT = 20000;
/** The most a message built for a wider column is shrunk to be laid out closer to that column. */
const DESIGN_SCALE = 0.7;
/** Elements a message's column is built of. */
const COLUMNS = "table, td, div, center, section, article, header, footer, main";

/**
 * The widest column a message asks for (a `max-width: 600px` box that gives way on a phone), at
 * most 800 pixels; 0 when none does.
 */
function designedWidth(doc: Document) {
  let widest = 0;
  for (const el of doc.querySelectorAll<HTMLElement>(COLUMNS)) {
    const max = /^(\d+(?:\.\d+)?)px$/.exec(getComputedStyle(el).maxWidth);
    if (max) widest = Math.max(widest, Number(max[1]));
  }
  return Math.min(widest, 800);
}

/**
 * A message's HTML, cleaned on the server (server/mail-client/html.ts), in a frame of its own: its
 * styles stay inside, nothing in it runs (the sandbox has no scripts), and its own content policy
 * lets it load only the images it carries, or images from anywhere once the reader asked for them.
 * Same-origin without scripts, so the page can measure it to show it whole; links open in a new tab.
 * A `plain` message (server/mail-client/plain-html.ts) is drawn in the page's colors instead of on
 * its white page.
 */
export function MailFrame({ html, images, title, plain = false }: { html: string; images: boolean; title: string; plain?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(120);
  const [pageCss, setPageCss] = useState<string | null>(null);
  // The page's colors, read before the first paint (the frame waits for them) and again when the
  // theme or contrast changes: <html data-theme>, data-contrast or the system's. The frame's own
  // scheme matches the page's, or the browser paints it opaque.
  useLayoutEffect(() => {
    const el = box.current;
    if (!plain || !el) return;
    const read = () => {
      const page = getComputedStyle(el);
      const token = (name: string) => page.getPropertyValue(name).trim();
      setPageCss(
        `html{color-scheme:${page.colorScheme}}body{color:${page.color};background:transparent}` +
          `body *{color:inherit!important;background-color:transparent!important}` +
          `body blockquote{color:${token("--fg-muted")}!important;border-left-color:${token("--border")}!important}` +
          `body a,body a *{color:${token("--accent")}!important}`,
      );
    };
    read();
    const attributes = new MutationObserver(read);
    attributes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-contrast"] });
    const queries = ["(prefers-color-scheme: dark)", "(prefers-contrast: more)"].map((q) => matchMedia(q));
    for (const query of queries) query.addEventListener("change", read);
    return () => {
      attributes.disconnect();
      for (const query of queries) query.removeEventListener("change", read);
    };
  }, [plain]);
  const shownCss = plain ? pageCss : null;
  const policy = `default-src 'none'; img-src data:${images ? " https: http:" : ""}; style-src 'unsafe-inline'; font-src data:`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base target="_blank"><style>
    html{color-scheme:light}body{display:flow-root;margin:0;padding:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1f2328;background:#fff;overflow-wrap:anywhere}
    img{max-width:100%;height:auto}[data-blocked]{display:none!important}pre{white-space:pre-wrap}blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:2px solid #d0d7de;color:#57606a}
  </style></head><body>${html.replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "")}</body></html>`;
  const styles = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
  // The page's colors come after the message's own styles, so they win.
  const srcDoc = doc.replace("</head>", `${styles}${shownCss ? `<style>${shownCss}</style>` : ""}</head>`);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    // Read once the message is in (a plain one asks for none), not from a half-loaded document.
    let designed: number | null = plain ? 0 : null;
    const measure = () => {
      // The body, not the page: the page is never shorter than the frame, so a short message would
      // keep the frame's first height. Rounded up: scrollHeight rounds a height like 734.4 down, and
      // Chromium scrolls the frame for the fraction left over.
      const body = frame.contentDocument?.body;
      if (!body) return;
      // A message laid out wider than the frame (a fixed 600px table on a phone) is drawn at its own
      // width and shrunk to fit, as a whole, rather than cut off at the edge or squeezed into a
      // column a word wide. One built for a wider column that gives way (max-width) is laid out
      // closer to that column, shrunk by at most DESIGN_SCALE: squeezed to a phone, its own margins
      // and large type leave a few words a line. Measured each time at the frame's width, so a
      // wider frame (a turned phone) shows it larger again.
      body.style.width = "";
      body.style.transform = "";
      const room = frame.contentDocument!.documentElement.clientWidth;
      designed ??= designedWidth(frame.contentDocument!);
      const wanted = Math.min(designed, room / DESIGN_SCALE);
      if (wanted > room + 1) body.style.width = `${wanted}px`;
      const natural = body.scrollWidth;
      const scale = natural > room + 1 ? room / natural : 1;
      if (scale < 1) {
        body.style.width = `${natural}px`;
        body.style.transformOrigin = "0 0";
        body.style.transform = `scale(${scale})`;
      }
      const whole = Math.ceil(Math.max(24, body.scrollHeight, body.getBoundingClientRect().height / scale) * scale);
      setHeight(Math.min(MAX_HEIGHT, whole));
      // Shown whole, it has nothing to scroll: a scrollbar would only narrow it, and pictures as
      // wide as the frame would shrink, take the scrollbar away, grow back and bring it again.
      frame.contentDocument!.documentElement.style.overflowY = whole > MAX_HEIGHT ? "auto" : "hidden";
    };
    const resize = new ResizeObserver(measure);
    resize.observe(frame);
    const loaded = () => {
      if (!plain) designed = null;
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
  }, [srcDoc, plain]);

  // On the white page the message reads as part of it, with no box. In the dark theme a designed
  // one keeps its white page as a card: it was written for white. Nothing in the frame's own box (no
  // border, no padding), or it would come out of the measured height and the message would scroll inside it.
  return (
    <div ref={box} className={plain ? "overflow-hidden" : "overflow-hidden bg-white dark:rounded-md dark:p-4"}>
      {(!plain || shownCss) && (
        <iframe
          ref={ref}
          title={title}
          srcDoc={srcDoc}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          className="block w-full"
          style={{ height }}
        />
      )}
    </div>
  );
}
