import { describe, expect, it } from "vitest";
import { desktopLink, desktopLinkAction, inDesktopApp, isDesktopLinks, isOpenablePath } from "./desktop-links";

const PAGE = "/w/ws_1/p/3f2b-91aa";
const base = { preference: "ask" as const, inDesktopApp: false, pathname: PAGE, dismissed: false, tried: false };

describe("desktopLinkAction", () => {
  it("does nothing when the setting is off, or inside the app", () => {
    expect(desktopLinkAction({ ...base, preference: "off" })).toBe("none");
    expect(desktopLinkAction({ ...base, inDesktopApp: true })).toBe("none");
    expect(desktopLinkAction({ ...base, preference: "always", inDesktopApp: true })).toBe("none");
  });

  it("offers to open a page until the offer is closed", () => {
    expect(desktopLinkAction(base)).toBe("offer");
    expect(desktopLinkAction({ ...base, pathname: "/w/ws_1" })).toBe("offer");
    expect(desktopLinkAction({ ...base, dismissed: true })).toBe("none");
  });

  it("opens the app once on its own, then only offers", () => {
    expect(desktopLinkAction({ ...base, preference: "always" })).toBe("open");
    expect(desktopLinkAction({ ...base, preference: "always", tried: true })).toBe("offer");
    expect(desktopLinkAction({ ...base, preference: "always", tried: true, dismissed: true })).toBe("none");
  });

  it("leaves settings and other screens alone", () => {
    expect(desktopLinkAction({ ...base, pathname: "/w/ws_1/settings" })).toBe("none");
    expect(desktopLinkAction({ ...base, preference: "always", pathname: "/w/ws_1/graph" })).toBe("none");
    expect(desktopLinkAction({ ...base, pathname: "/sign-in" })).toBe("none");
  });
});

describe("desktop links", () => {
  it("carries the page's address", () => {
    expect(desktopLink("https://leafdesk.example.com/w/a/p/b?row=r1")).toBe(
      "leafdesk://open?url=https%3A%2F%2Fleafdesk.example.com%2Fw%2Fa%2Fp%2Fb%3Frow%3Dr1",
    );
    const url = new URL(desktopLink("https://leafdesk.example.com/w/a/p/b?row=r1#c"));
    expect(url.searchParams.get("url")).toBe("https://leafdesk.example.com/w/a/p/b?row=r1#c");
  });

  it("knows the settings' values and the app's pages", () => {
    expect(isDesktopLinks("always")).toBe(true);
    expect(isDesktopLinks("sometimes")).toBe(false);
    expect(isDesktopLinks(null)).toBe(false);
    expect(isOpenablePath(PAGE)).toBe(true);
    expect(isOpenablePath("/w/ws_1/p/x/history")).toBe(false);
    expect(inDesktopApp({ hasAttribute: (name) => name === "data-desktop-app" })).toBe(true);
    expect(inDesktopApp({ hasAttribute: (name) => name === "data-window-controls" })).toBe(true);
    expect(inDesktopApp({ hasAttribute: () => false })).toBe(false);
  });
});
