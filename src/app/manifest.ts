import type { MetadataRoute } from "next";
import { getTranslations } from "next-intl/server";
import { THEME_COLORS } from "@/lib/theme";

/**
 * Web app manifest (/manifest.webmanifest): installable on desktop (Chrome, Edge) and phones.
 * `start_url` is the root, which opens the last workspace; offline, the service worker sends it to
 * the last page it kept instead. Icons live in public/icons (generated from public/icons/icon.svg).
 *
 * The description follows the visitor's language (same key as the page metadata), so the manifest
 * can't be prerendered.
 */
export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = await getTranslations("common");
  return {
    id: "/",
    name: "Leafdesk",
    short_name: "Leafdesk",
    description: t("appDescription"),
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: THEME_COLORS.light,
    theme_color: THEME_COLORS.light,
    categories: ["productivity"],
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
