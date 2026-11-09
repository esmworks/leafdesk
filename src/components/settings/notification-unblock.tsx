"use client";

import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { unblockOrder, unblockPlatformOf, UNBLOCK_STEPS, type UnblockPlatform } from "@/lib/notification-unblock";

/** The browser's own hints where it has them (Chromium's userAgentData). */
function platformHint(): string | null {
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return typeof data?.platform === "string" ? data.platform : null;
}

function Steps({ platform }: { platform: UnblockPlatform }) {
  const t = useTranslations("settings.notifications.unblock");
  return (
    <ol className="list-decimal space-y-1 ps-5 text-sm text-fg-muted">
      {Array.from({ length: UNBLOCK_STEPS[platform] }, (_, i) => (
        <li key={i}>{t(`${platform}.step${i + 1}` as "chrome.step1")}</li>
      ))}
    </ol>
  );
}

/**
 * Under "this browser blocks notifications": the steps to allow them again on the visitor's
 * platform, and the other platforms' behind a disclosure (someone may be reading on another device).
 */
export function NotificationUnblockHelp() {
  const t = useTranslations("settings.notifications.unblock");
  // Read after the first render: the server can't know the browser.
  const [own, setOwn] = useState<UnblockPlatform | null | undefined>(undefined);
  useEffect(() => {
    setOwn(unblockPlatformOf(navigator.userAgent, { maxTouchPoints: navigator.maxTouchPoints, platform: platformHint() }));
  }, []);
  if (own === undefined) return null;
  const order = unblockOrder(own);
  return (
    <div className="space-y-3">
      {order.own && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t("ownHeading", { platform: t(`${order.own}.name` as "chrome.name") })}</p>
          <Steps platform={order.own} />
        </div>
      )}
      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-sm text-fg-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100" aria-hidden />
          {order.own ? t("others") : t("all")}
        </summary>
        <div className="mt-3 space-y-3 border-s border-border ps-3">
          {order.others.map((platform) => (
            <div key={platform} className="space-y-1.5">
              <p className="text-sm font-medium">{t(`${platform}.name` as "chrome.name")}</p>
              <Steps platform={platform} />
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
