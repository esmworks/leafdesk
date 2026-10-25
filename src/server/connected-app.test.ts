import { describe, expect, it, vi } from "vitest";
import { appModeHere, asWrite, connectedAppCall, connectedAppRefusal, connectedAppsMode, runAsConnectedApp } from "./connected-app";
import { mayPublish } from "./workspaces";

vi.mock("@/db", () => ({ db: {} }));

describe("the connected-apps setting", () => {
  it("reads anything unknown or unset as full access", () => {
    expect(connectedAppsMode("read")).toBe("read");
    expect(connectedAppsMode("off")).toBe("off");
    for (const value of ["full", null, undefined, "", "READ", 1]) expect(connectedAppsMode(value)).toBe("full");
  });

  it("hides the workspace when off, refuses only writes when read-only, and allows everything when full", () => {
    expect(connectedAppRefusal("off", false)).toBe("hidden");
    expect(connectedAppRefusal("off", true)).toBe("hidden");
    expect(connectedAppRefusal("read", false)).toBeNull();
    expect(connectedAppRefusal("read", true)).toBe("readOnly");
    expect(connectedAppRefusal("full", false)).toBeNull();
    expect(connectedAppRefusal("full", true)).toBeNull();
  });

  it("turns away apps owners haven't approved where only approved apps may come", () => {
    expect(appModeHere("full", true, false)).toBe("off");
    expect(appModeHere("read", true, false)).toBe("off");
    expect(appModeHere("read", true, true)).toBe("read");
    expect(appModeHere("full", false, false)).toBe("full");
    expect(appModeHere("off", false, true)).toBe("off");
  });
});

describe("connected-app requests", () => {
  it("are seen only for the user the app acts for", () => {
    expect(connectedAppCall("u1")).toBeNull();
    runAsConnectedApp({ userId: "u1" }, () => {
      expect(connectedAppCall("u1")).toMatchObject({ userId: "u1", writing: false });
      expect(connectedAppCall("u2")).toBeNull();
    });
    expect(connectedAppCall("u1")).toBeNull();
  });

  it("become writes inside asWrite, keeping the settings already asked for", async () => {
    await runAsConnectedApp({ userId: "u1" }, async () => {
      const outer = connectedAppCall("u1")!;
      outer.modes.set("ws1", Promise.resolve("read"));
      await asWrite(async () => {
        await Promise.resolve();
        const inner = connectedAppCall("u1")!;
        expect(inner.writing).toBe(true);
        expect(inner.modes).toBe(outer.modes);
      });
      expect(connectedAppCall("u1")!.writing).toBe(false);
    });
    expect(asWrite(() => connectedAppCall("u1"))).toBeNull();
  });

  it("can be writes from the start (a REST endpoint needing pages:write)", () => {
    runAsConnectedApp({ userId: "u1", writing: true }, () => expect(connectedAppCall("u1")!.writing).toBe(true));
  });
});

describe("the publishing setting", () => {
  it("lets owners, or members too, publish, and nobody when off", () => {
    expect(mayPublish("owner", "owners")).toBe(true);
    expect(mayPublish("member", "owners")).toBe(false);
    expect(mayPublish("member", "members")).toBe(true);
    expect(mayPublish("guest", "members")).toBe(false);
    expect(mayPublish("owner", "off")).toBe(false);
    expect(mayPublish("member", "off")).toBe(false);
  });
});
