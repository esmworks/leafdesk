import { ACTION_HEADER as NEXT_ACTION_HEADER, NEXT_ACTION_NOT_FOUND_HEADER } from "next/dist/client/components/app-router-headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEEN_BUILD_KEY } from "@/lib/build-id";

type Freshness = typeof import("./freshness");

let store: Map<string, string>;
let storageListeners: ((event: { key: string; newValue: string | null }) => void)[];

/** A fresh copy of the module (its state is per tab) in a "tab" running `build`. */
async function tab(build: string): Promise<Freshness> {
  vi.resetModules();
  vi.stubEnv("LEAFDESK_BUILD_ID", build);
  return import("./freshness");
}

beforeEach(() => {
  store = new Map();
  storageListeners = [];
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  vi.stubGlobal("window", { addEventListener: (_type: string, listener: (typeof storageListeners)[number]) => storageListeners.push(listener) });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("freshness", () => {
  it("stays fresh when the server runs the same build, and remembers it for other tabs", async () => {
    const f = await tab("b2");
    expect(await f.whenFresh(async () => f.noteServerBuild("b2"), 100)).toBe(true);
    expect(f.isStale()).toBe(false);
    expect(store.get(SEEN_BUILD_KEY)).toBe("b2");
  });

  it("turns stale when the server runs another build, and tells whoever listens once", async () => {
    const f = await tab("b1");
    const listener = vi.fn();
    f.onStale(listener);
    expect(await f.whenFresh(async () => f.noteServerBuild("b2"), 100)).toBe(false);
    f.markStale();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.has(SEEN_BUILD_KEY)).toBe(false);
  });

  it("offline, goes by the build another tab of this browser last confirmed", async () => {
    store.set(SEEN_BUILD_KEY, "b2");
    const f = await tab("b1");
    expect(await f.whenFresh(() => Promise.reject(new Error("offline")), 100)).toBe(false);
  });

  it("offline with nothing stored, or the same build stored, stays fresh", async () => {
    const f = await tab("b1");
    expect(await f.whenFresh(() => Promise.reject(new Error("offline")), 100)).toBe(true);
    store.set(SEEN_BUILD_KEY, "b1");
    const g = await tab("b1");
    expect(await g.whenFresh(() => Promise.reject(new Error("offline")), 100)).toBe(true);
  });

  it("doesn't wait longer than asked for a server that doesn't answer", async () => {
    store.set(SEEN_BUILD_KEY, "b2");
    const f = await tab("b1");
    const started = Date.now();
    expect(await f.whenFresh(() => new Promise(() => {}), 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("turns stale when another tab meets a server with another build", async () => {
    const f = await tab("b1");
    expect(await f.whenFresh(async () => f.noteServerBuild("b1"), 100)).toBe(true);
    storageListeners.forEach((l) => l({ key: SEEN_BUILD_KEY, newValue: "b1" }));
    expect(f.isStale()).toBe(false);
    storageListeners.forEach((l) => l({ key: SEEN_BUILD_KEY, newValue: "b2" }));
    expect(f.isStale()).toBe(true);
    expect(await f.whenFresh(async () => f.noteServerBuild("b1"), 100)).toBe(false);
  });

  it("never turns stale in development, where the bundle has no build", async () => {
    store.set(SEEN_BUILD_KEY, "b2");
    const f = await tab("");
    expect(await f.whenFresh(async () => f.noteServerBuild("b2"), 100)).toBe(true);
    storageListeners.forEach((l) => l({ key: SEEN_BUILD_KEY, newValue: "b3" }));
    expect(f.isStale()).toBe(false);
  });

  it("asks the server's build as the tab comes back into view, at most once a minute, and turns stale on another", async () => {
    vi.useFakeTimers();
    const on = new Map<string, () => void>();
    const target = { addEventListener: (type: string, l: () => void) => on.set(type, l), removeEventListener: (type: string) => on.delete(type) };
    const page = { ...target, visibilityState: "visible" };
    const net = { onLine: true };
    vi.stubGlobal("window", target);
    vi.stubGlobal("document", page);
    vi.stubGlobal("navigator", net);
    try {
      const f = await tab("b1");
      let server = "b1";
      const ask = vi.fn(async () => f.noteServerBuild(server));
      const stop = f.watchServerBuild(ask);
      on.get("visibilitychange")!();
      expect(ask).not.toHaveBeenCalled();
      vi.advanceTimersByTime(61_000);
      page.visibilityState = "hidden";
      on.get("visibilitychange")!();
      net.onLine = false;
      page.visibilityState = "visible";
      on.get("online")!();
      expect(ask).not.toHaveBeenCalled();
      net.onLine = true;
      on.get("visibilitychange")!();
      on.get("focus")!();
      expect(ask).toHaveBeenCalledTimes(1);
      server = "b2";
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(ask).toHaveBeenCalledTimes(2);
      expect(f.isStale()).toBe(true);
      vi.advanceTimersByTime(61_000);
      on.get("pageshow")!();
      expect(ask).toHaveBeenCalledTimes(2);
      stop();
      expect([...on.keys()]).toEqual(["storage"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never asks in development", async () => {
    const f = await tab("");
    const ask = vi.fn(async () => {});
    f.watchServerBuild(ask)();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("server actions", () => {
  it("names the headers Next sends an action with and answers an unknown one with", async () => {
    const f = await tab("b1");
    expect(f.ACTION_HEADER).toBe(NEXT_ACTION_HEADER);
    expect(f.ACTION_NOT_FOUND_HEADER).toBe(NEXT_ACTION_NOT_FOUND_HEADER);
  });

  it("turns stale when the server has no such action, and sends no action after that", async () => {
    const f = await tab("b1");
    const unknown = new Response("Server Action unavailable.", { status: 409, headers: { [f.ACTION_NOT_FOUND_HEADER]: "1" } });
    const server = vi.fn(async () => unknown);
    const fetch = f.watchServerActions(server);
    const action = { method: "POST", headers: { [f.ACTION_HEADER]: "408137e7" } };
    // Not an action: passes through, whatever the answer carries.
    expect(await fetch("/w/x", { method: "POST" })).toBe(unknown);
    expect(f.isStale()).toBe(false);
    expect(await fetch("/w/x", action)).toBe(unknown);
    expect(f.isStale()).toBe(true);
    await expect(fetch("/w/x", action)).rejects.toThrow(f.STALE_ACTION_MESSAGE);
    expect(server).toHaveBeenCalledTimes(2);
    expect(await fetch("/api/read/sidebar")).toBe(unknown);
    expect(server).toHaveBeenCalledTimes(3);
  });

  it("stays fresh while the server knows the actions, however the header is given", async () => {
    const f = await tab("b1");
    const known = new Response("0:[]", { status: 200 });
    const server = vi.fn(async () => known);
    const fetch = f.watchServerActions(server);
    expect(await fetch("/w/x", { method: "POST", headers: new Headers({ [f.ACTION_HEADER]: "a" }) })).toBe(known);
    expect(await fetch(new Request("http://leafdesk.test/w/x", { method: "POST", headers: { [f.ACTION_HEADER]: "a" } }))).toBe(known);
    expect(await fetch("/w/x", { method: "POST", headers: [[f.ACTION_HEADER, "a"]] })).toBe(known);
    expect(server).toHaveBeenCalledTimes(3);
    expect(f.isStale()).toBe(false);
  });

  it("wraps the window's fetch in a built tab, never in development", async () => {
    const original = vi.fn();
    const stub = () => vi.stubGlobal("window", { addEventListener: () => {}, fetch: original });
    stub();
    await tab("b1");
    expect(window.fetch).not.toBe(original);
    stub();
    await tab("");
    expect(window.fetch).toBe(original);
  });
});
