"use client";

import { AppWindow, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { setDesktopLinksAction } from "@/app/actions/preferences";
import { Button, IconButton } from "@/components/ui";
import { desktopLink, desktopLinkAction, inDesktopApp, type DesktopLinks } from "@/lib/desktop-links";

/** Kept for the browser tab only: a new tab may offer, and try, again. */
const DISMISSED = "leafdesk:desktop-link:dismissed";
const TRIED = "leafdesk:desktop-link:tried";

function readFlag(key: string) {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function setFlag(key: string) {
  try {
    sessionStorage.setItem(key, "1");
  } catch {}
}

/**
 * For people who open Leafdesk's links in the desktop app (Settings > Preferences): a page opened
 * in a browser offers to go on to the app, or, set to "always", tries it at once and offers it
 * still, in case no app answered (lib/desktop-links.ts). Inside the app it shows nothing.
 */
export default function DesktopLinkBanner({ preference }: { preference: Exclude<DesktopLinks, "off"> }) {
  const t = useTranslations("settings.desktopLinks.banner");
  const pathname = usePathname();
  const [always, setAlways] = useState(preference === "always");
  const [shown, setShown] = useState(false);

  // Read after mounting: the server can't know the browser tab, or whether this is the app.
  useEffect(() => {
    const action = desktopLinkAction({
      preference,
      inDesktopApp: inDesktopApp(document.documentElement),
      pathname,
      dismissed: readFlag(DISMISSED),
      tried: readFlag(TRIED),
    });
    if (action === "open") {
      setFlag(TRIED);
      window.location.href = desktopLink(window.location.href);
    }
    setShown(action !== "none");
  }, [preference, pathname]);

  if (!shown) return null;

  const open = () => {
    if (always && preference !== "always") void setDesktopLinksAction("always").catch(() => undefined);
    window.location.href = desktopLink(window.location.href);
  };
  const dismiss = () => {
    setFlag(DISMISSED);
    setShown(false);
  };

  return (
    <div
      role="status"
      className="fixed end-4 bottom-4 z-40 flex w-[min(26rem,calc(100vw-2rem))] items-center gap-3 rounded-lg border border-border bg-bg py-2.5 ps-3.5 pe-2 shadow-lg"
    >
      <AppWindow className="h-5 w-5 shrink-0 text-fg-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t("text")}</p>
        {preference === "ask" && (
          <label className="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
            <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--color-accent)]" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            {t("always")}
          </label>
        )}
      </div>
      <Button variant="primary" size="sm" onClick={open}>
        {t("open")}
      </Button>
      <IconButton label={t("dismiss")} onClick={dismiss}>
        <X className="h-4 w-4" />
      </IconButton>
    </div>
  );
}
