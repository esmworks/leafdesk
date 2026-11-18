// Client-safe and small: the document an HTML block (lib/html-block.ts) runs in, and the messages
// the page and the frame exchange. Served by app/api/html-block/frame, used by
// components/page/html-frame.tsx.

/**
 * Where the frame's document is served: the same for every block, because it holds nothing: the
 * page sends the block's source to the frame once the frame says it is ready. (A `srcdoc` or blob
 * frame would inherit the app's nonce policy, which blocks the inline scripts a block is made of;
 * a document of its own has its own policy. And a route that read the source from the page would
 * need an access check of its own on every request, published pages' included.)
 */
export const HTML_FRAME_PATH = "/api/html-block/frame";

/**
 * The frame's own Content-Security-Policy, which is all that holds the block's code in:
 *
 * - `sandbox allow-scripts`: the document gets an opaque origin, never the app's: no cookies, no
 *   storage, no reading of the page around it, no popups, no forms, no top navigation, no modals.
 *   (The iframe element carries the same sandbox, for browsers that read only one of the two.)
 * - `default-src 'none'` and `connect-src 'none'`: nothing loads and nothing is fetched, from the
 *   app or from anywhere; inline scripts and styles, and data: and blob: images, fonts and media
 *   are what a block is made of.
 * - `form-action 'none'`, `base-uri 'none'`, `frame-src 'none'`, `object-src 'none'`.
 * - `frame-ancestors 'self'`: no other site frames it.
 *
 * The block's code doesn't run in this document but in a frame inside it (`srcdoc`, sandboxed
 * the same way, inheriting this policy): a frame's navigations are checked against the `frame-src`
 * of the document holding it, and the app's pages allow `https:` there (for embeds), so a block
 * running in the outer frame could take what a reader typed to another site by navigating itself
 * (a `<meta http-equiv="refresh">` does, even with nothing else loading). Held by this document's
 * `frame-src 'none'`, it can't navigate anywhere; it can't navigate this document either (a
 * sandboxed frame navigates only itself and what it holds).
 */
export const HTML_FRAME_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** The iframe element's sandbox: scripts only, never `allow-same-origin`. */
export const HTML_FRAME_SANDBOX = "allow-scripts";

/** What the frame says to the page, and the page to the frame (the `leafdeskHtml` key names the kind). */
export type FrameToPage = { leafdeskHtml: "ready" } | { leafdeskHtml: "height"; height: number };
export type PageToFrame = { leafdeskHtml: "source"; source: string; scheme: "light" | "dark" };

/**
 * What goes before a block's source in its inner frame: reports the document's height to the shell
 * as it changes and stops links (a block is an app, not a way out; a link to a place in the block
 * still works). Runs as the block's first script.
 */
const INNER_HEAD = `<script>(function () {
  var shell = window.parent;
  function height() {
    var root = document.documentElement;
    var body = document.body;
    shell.postMessage({ leafdeskHtml: "height", height: Math.max(root ? root.getBoundingClientRect().height : 0, body ? body.getBoundingClientRect().height : 0) }, "*");
  }
  document.addEventListener("click", function (click) {
    var node = click.target;
    while (node && node.nodeType === 1 && !(node.tagName === "A" && node.hasAttribute("href"))) node = node.parentNode;
    if (node && node.nodeType === 1 && !/^#/.test(node.getAttribute("href") || "")) click.preventDefault();
  }, true);
  document.addEventListener("DOMContentLoaded", function () {
    height();
    if (typeof ResizeObserver === "function") {
      var observer = new ResizeObserver(height);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
  });
  window.addEventListener("load", height);
})();</script>`;

/**
 * The frame's whole document: a few lines that tell the page it is ready, take the source it is
 * sent (once: from the page that embeds it and nobody else) and run it in a sandboxed frame of its
 * own (`srcdoc`, under this document's policy, see HTML_FRAME_CSP for why it is nested), then pass
 * the block's height on to the page as it changes. HTML_FRAME_CSP's `script-src 'unsafe-inline'`
 * is what lets the block's own scripts run.
 */
export const HTML_FRAME_DOCUMENT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title></title><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}iframe{display:block;border:0;width:100%;height:0}</style></head><body><script>
(function () {
  var host = window.parent;
  var started = false;
  var inner = null;
  var head = ${JSON.stringify(INNER_HEAD).replace(/<\//g, "<\\/")};
  function send(message) { host.postMessage(message, "*"); }
  window.addEventListener("message", function (event) {
    var message = event.data;
    if (inner && event.source === inner.contentWindow) {
      if (message && message.leafdeskHtml === "height" && typeof message.height === "number" && isFinite(message.height)) {
        inner.style.height = Math.max(0, Math.ceil(message.height)) + "px";
        send({ leafdeskHtml: "height", height: message.height });
      }
      return;
    }
    if (started || event.source !== host || !message || message.leafdeskHtml !== "source" || typeof message.source !== "string") return;
    started = true;
    var source = message.source;
    var doctype = /^\\s*<!doctype[^>]*>/i.exec(source);
    var rest = doctype ? source.slice(doctype[0].length) : source;
    var scheme = message.scheme === "dark" ? "<style>:root{color-scheme:dark}</style>" : "";
    if (message.scheme === "dark") document.documentElement.style.colorScheme = "dark";
    inner = document.createElement("iframe");
    inner.setAttribute("sandbox", "allow-scripts");
    inner.setAttribute("title", "");
    inner.srcdoc = (doctype ? doctype[0] : "<!doctype html>") + scheme + head + rest;
    document.body.appendChild(inner);
  });
  // Said again until the page answers: a page that was still starting up (a published page being
  // hydrated) misses the first one.
  var tries = 0;
  var timer = setInterval(function () {
    if (started || ++tries > 400) clearInterval(timer);
    else send({ leafdeskHtml: "ready" });
  }, 150);
  send({ leafdeskHtml: "ready" });
})();
</script></body></html>
`;
