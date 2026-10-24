"use client";

import dynamic from "next/dynamic";
import type { DesktopLinks } from "@/lib/desktop-links";

const DesktopLinkBanner = dynamic(() => import("./desktop-link-banner"), { ssr: false });

/** The offer to open the page in the desktop app, loaded only for people who turned it on. */
export function DesktopLinkOffer({ preference }: { preference: Exclude<DesktopLinks, "off"> }) {
  return <DesktopLinkBanner preference={preference} />;
}
