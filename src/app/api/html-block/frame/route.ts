import { HTML_FRAME_CSP, HTML_FRAME_DOCUMENT } from "@/lib/html-frame";

/**
 * The document every HTML block (lib/html-block.ts) runs in, under a policy of its own
 * (lib/html-frame.ts): sandboxed to an opaque origin, nothing loads, nothing is fetched. It holds
 * nothing and reads no session, so it is served to anyone (published pages and sites included);
 * the page that embeds it sends the block's source once the frame says it is ready.
 *
 * API routes are outside the proxy (src/proxy.ts), whose nonce policy would be added to this one
 * and, applying together with it, block the block's inline scripts.
 */
function handle() {
  return new Response(HTML_FRAME_DOCUMENT, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": HTML_FRAME_CSP,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export { handle as GET, handle as HEAD };
