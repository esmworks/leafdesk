import { builtinIconSvg } from "@/lib/builtin-icon-svg";
import { emojiFaviconSvg, emojiIcon } from "@/lib/site";

/**
 * A page icon as the browser tab shows it: `?icon=` an emoji or a built-in icon
 * (`icon:<name>[:<color>]`), drawn as SVG. It reads no page, so it needs no session: the address
 * says everything it draws. Anything else gets the app's icon.
 */
export function GET(request: Request) {
  const icon = new URL(request.url).searchParams.get("icon")?.slice(0, 100) ?? null;
  const emoji = emojiIcon(icon);
  const svg = emoji ? emojiFaviconSvg(emoji) : builtinIconSvg(icon, { size: 64 });
  if (!svg) return new Response(null, { status: 307, headers: { location: "/icon.svg", "cache-control": "no-store" } });
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // The icon is in the address, so the drawing never changes for it.
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
}
