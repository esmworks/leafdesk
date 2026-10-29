"use client";

import type { DesktopLinks } from "@/lib/desktop-links";
import { lazyPart } from "@/components/lazy-part";

const DesktopLinkBanner = lazyPart(() => import("./desktop-link-banner").then((m) => m.default));

/** The offer to open the page in the desktop app, loaded only for people who turned it on. */
export function DesktopLinkOffer({ preference }: { preference: Exclude<DesktopLinks, "off"> }) {
  return <DesktopLinkBanner preference={preference} />;
}
