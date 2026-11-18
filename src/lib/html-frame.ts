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
 * A block's own code can still navigate its frame (a link, `location`): the shell stops links,
 * and what is sent that way is limited to what the block itself holds. It is no way to the app's
 * data, which the frame never sees.
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
 * The frame's whole document: a few lines that tell the page it is ready, take the source it is
 * sent (once: from the page that embeds it and nobody else) and write it in as the document, then
 * report the document's height as it changes. Runs under HTML_FRAME_CSP, whose `script-src
 * 'unsafe-inline'` is what lets the block's own scripts run after it.
 */
export const HTML_FRAME_DOCUMENT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title></title></head><body><script>
(function () {
  var host = window.parent;
  var started = false;
  function send(message) { host.postMessage(message, "*"); }
  function height() {
    var root = document.documentElement;
    var body = document.body;
    send({ leafdeskHtml: "height", height: Math.max(root ? root.getBoundingClientRect().height : 0, body ? body.getBoundingClientRect().height : 0) });
  }
  window.addEventListener("message", function (event) {
    var message = event.data;
    if (started || event.source !== host || !message || message.leafdeskHtml !== "source" || typeof message.source !== "string") return;
    started = true;
    var source = message.source;
    if (!/^\\s*<!doctype/i.test(source)) source = "<!doctype html>" + source;
    if (message.scheme === "dark") source = source.replace(/^(\\s*<!doctype[^>]*>)?/i, function (head) { return head + "<style>:root{color-scheme:dark}</style>"; });
    document.open();
    document.write(source);
    document.close();
    // Links go nowhere (a block is an app, not a way out); a link to a place in the block still works.
    document.addEventListener("click", function (click) {
      var node = click.target;
      while (node && node.nodeType === 1 && !(node.tagName === "A" && node.hasAttribute("href"))) node = node.parentNode;
      if (node && node.nodeType === 1 && !/^#/.test(node.getAttribute("href") || "")) click.preventDefault();
    }, true);
    height();
    if (typeof ResizeObserver === "function") {
      var observer = new ResizeObserver(height);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
    window.addEventListener("load", height);
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
