/**
 * How to allow notifications again once a browser blocks them (Settings > Preferences, the push
 * row): which platform the visitor is on, from the user agent, so the steps for it come first.
 * Pure; the texts are `settings.notifications.unblock.<platform>.*`.
 */

export const UNBLOCK_PLATFORMS = ["chrome", "safari", "firefox", "ios", "android"] as const;
export type UnblockPlatform = (typeof UNBLOCK_PLATFORMS)[number];

/** How many steps each platform's text has (`step1` …). */
export const UNBLOCK_STEPS: Record<UnblockPlatform, number> = { chrome: 3, safari: 3, firefox: 3, ios: 3, android: 4 };

export type BrowserHints = {
  /** navigator.maxTouchPoints: iPadOS reports a Mac, but a Mac has no touch screen. */
  maxTouchPoints?: number;
  /** navigator.userAgentData.platform, where the browser has it ("Android", "macOS" …). */
  platform?: string | null;
};

/** The platform whose steps fit this browser; null when none does (another browser, no user agent). */
export function unblockPlatformOf(userAgent: string, hints: BrowserHints = {}): UnblockPlatform | null {
  const ua = userAgent;
  const platform = hints.platform?.toLowerCase() ?? "";
  // Every browser on iPhone and iPad is Safari underneath; iPadOS can claim to be a Mac.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (hints.maxTouchPoints ?? 0) > 1)) return "ios";
  if (platform === "android" || /Android/.test(ua)) return /Firefox\//.test(ua) ? "firefox" : "android";
  if (/Firefox\//.test(ua)) return "firefox";
  // Edge, Opera, Brave and others carry Chrome's name and settings.
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return "safari";
  return null;
}

/** The platforms to show: the visitor's first, then the others for "other browsers". */
export function unblockOrder(own: UnblockPlatform | null): { own: UnblockPlatform | null; others: UnblockPlatform[] } {
  return { own, others: UNBLOCK_PLATFORMS.filter((platform) => platform !== own) };
}
