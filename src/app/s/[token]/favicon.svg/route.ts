import { builtinIconSvg } from "@/lib/builtin-icon-svg";
import { emojiFaviconSvg, emojiIcon, isSiteKey } from "@/lib/site";
import { loadSite } from "@/server/site";

/**
 * A site's favicon: its home page's emoji or built-in icon, drawn as SVG here (no image of anyone's
 * is loaded). Sites whose home page has neither, and publication links, get the app's icon.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const site = isSiteKey(token) ? await loadSite(token) : null;
  const emoji = emojiIcon(site?.homeIcon);
  const svg = emoji ? emojiFaviconSvg(emoji) : builtinIconSvg(site?.homeIcon, { size: 64 });
  if (!svg) return new Response(null, { status: 307, headers: { location: "/icon.svg", "cache-control": "no-store" } });
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // The page links it with its icon in the address, so a new icon is a new address.
      "cache-control": "public, max-age=86400",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
}
