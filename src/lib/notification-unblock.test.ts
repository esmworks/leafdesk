import { describe, expect, it } from "vitest";
import { unblockOrder, unblockPlatformOf, UNBLOCK_PLATFORMS } from "./notification-unblock";

const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
  firefoxAndroid: "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1",
  androidChrome: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
};

describe("unblockPlatformOf", () => {
  it("knows desktop browsers", () => {
    expect(unblockPlatformOf(UA.chromeMac)).toBe("chrome");
    expect(unblockPlatformOf(UA.chromeWindows)).toBe("chrome");
    expect(unblockPlatformOf(UA.edge)).toBe("chrome");
    expect(unblockPlatformOf(UA.safariMac)).toBe("safari");
    expect(unblockPlatformOf(UA.firefoxMac)).toBe("firefox");
    expect(unblockPlatformOf(UA.firefoxLinux)).toBe("firefox");
  });

  it("knows phones and tablets", () => {
    expect(unblockPlatformOf(UA.iphone)).toBe("ios");
    expect(unblockPlatformOf(UA.chromeIphone)).toBe("ios");
    expect(unblockPlatformOf(UA.androidChrome)).toBe("android");
    expect(unblockPlatformOf(UA.firefoxAndroid)).toBe("firefox");
  });

  it("tells an iPad claiming to be a Mac by its touch screen", () => {
    expect(unblockPlatformOf(UA.safariMac, { maxTouchPoints: 5 })).toBe("ios");
    expect(unblockPlatformOf(UA.safariMac, { maxTouchPoints: 0 })).toBe("safari");
  });

  it("takes the platform from client hints", () => {
    expect(unblockPlatformOf("Mozilla/5.0 (Linux; K) Chrome/141.0.0.0", { platform: "Android" })).toBe("android");
  });

  it("knows nothing of other browsers", () => {
    expect(unblockPlatformOf("")).toBeNull();
    expect(unblockPlatformOf("curl/8.0")).toBeNull();
  });
});

describe("unblockOrder", () => {
  it("puts the visitor's platform apart from the others", () => {
    expect(unblockOrder("safari")).toEqual({ own: "safari", others: ["chrome", "firefox", "ios", "android"] });
    expect(unblockOrder(null).others).toEqual([...UNBLOCK_PLATFORMS]);
  });
});
