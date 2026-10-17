import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  belongsToSomeoneElse,
  forgetPage,
  isCacheablePagePath,
  isOfflineStore,
  offlineStateKey,
  PAGE_PATH,
  pageCacheName,
  pageStoreName,
  parseOfflineState,
  readUserMarker,
  rememberRecent,
  setDirty,
  snapshotStoreName,
  snapshotsToEvict,
  syncState,
  type RecentPage,
} from "./offline";

const page = (id: string, at = 0): RecentPage => ({ id, workspaceId: "ws", title: id, icon: null, at });

describe("offline storage names", () => {
  it("keeps every user's data under their own id", () => {
    expect(pageStoreName("u1", "p1")).toBe("leafdesk-u1-page-p1");
    expect(snapshotStoreName("u1")).toBe("leafdesk-u1-cache");
    expect(pageCacheName("u1")).toBe("leafdesk-pages-u1");
    expect(offlineStateKey("u1")).toBe("leafdesk:offline:u1");
  });

  it("finds what another user left behind, and nothing else", () => {
    const mine = [pageStoreName("u1", "p1"), snapshotStoreName("u1"), pageCacheName("u1"), offlineStateKey("u1")];
    const theirs = [pageStoreName("u2", "p1"), snapshotStoreName("u2"), pageCacheName("u2"), offlineStateKey("u2")];
    for (const name of mine) expect(belongsToSomeoneElse(name, "u1"), name).toBe(false);
    for (const name of theirs) expect(belongsToSomeoneElse(name, "u1"), name).toBe(true);
    // A user id that starts like another one is still someone else.
    expect(belongsToSomeoneElse(pageStoreName("u10", "p1"), "u1")).toBe(true);
    expect(belongsToSomeoneElse(pageCacheName("u10"), "u1")).toBe(true);
    // Not offline data at all: settings, the static cache, the service worker's own metadata.
    for (const name of ["leafdesk:expanded", "leafdesk-static-1", "leafdesk-meta", "other-app"]) {
      expect(belongsToSomeoneElse(name, "u1"), name).toBe(false);
    }
    expect(isOfflineStore("leafdesk:expanded")).toBe(false);
    expect(isOfflineStore(offlineStateKey("u2"))).toBe(true);
  });
});

describe("pages the service worker keeps", () => {
  it("keeps workspace pages, not settings or exports", () => {
    expect(isCacheablePagePath("/w/abc")).toBe(true);
    expect(isCacheablePagePath("/w/abc/")).toBe(true);
    expect(isCacheablePagePath("/w/abc/p/0f3a-11")).toBe(true);
    expect(isCacheablePagePath("/w/abc/settings")).toBe(false);
    expect(isCacheablePagePath("/w/abc/p/x/export")).toBe(false);
    expect(isCacheablePagePath("/print/x")).toBe(false);
    expect(isCacheablePagePath("/s/token")).toBe(false);
    expect(isCacheablePagePath("/")).toBe(false);
  });

  it("reads the user a page was rendered for", () => {
    expect(readUserMarker('<head><meta name="leafdesk-user" content="u_1-x"/></head>')).toBe("u_1-x");
    expect(readUserMarker('<meta name="description" content="x">')).toBeNull();
    expect(readUserMarker('<meta name="leafdesk-user" content="a&quot;b">')).toBeNull();
  });

  it("public/sw.js uses the same rules", () => {
    const sw = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
    const pagePath = /const PAGE_PATH = (\/.+\/);/.exec(sw)?.[1];
    const marker = /const USER_MARKER = (\/.+\/);/.exec(sw)?.[1];
    expect(pagePath).toBe(PAGE_PATH.toString());
    const swMarker = new Function(`return ${marker}`)() as RegExp;
    expect(swMarker.exec('<meta name="leafdesk-user" content="u1">')?.[1]).toBe("u1");
    expect(sw).toContain('const PAGE_CACHE_PREFIX = "leafdesk-pages-"');
  });
});

describe("recent pages and unsent edits", () => {
  it("puts a page first, once, and keeps a bounded list", () => {
    const list = [page("a"), page("b"), page("c")];
    expect(rememberRecent(list, page("b", 5)).map((p) => p.id)).toEqual(["b", "a", "c"]);
    expect(rememberRecent(list, page("d"), 3).map((p) => p.id)).toEqual(["d", "a", "b"]);
  });

  it("marks and clears pages with edits waiting for the server", () => {
    const empty = { recent: [], dirty: [] };
    const one = setDirty(empty, "p1", true);
    expect(one.dirty).toEqual(["p1"]);
    expect(setDirty(one, "p1", true)).toBe(one);
    expect(setDirty(one, "p1", false).dirty).toEqual([]);
  });

  it("forgets a page the server refused", () => {
    const state = { recent: [page("a"), page("b")], dirty: ["a", "b"] };
    expect(forgetPage(state, "a")).toEqual({ recent: [page("b")], dirty: ["b"] });
  });

  it("survives broken or foreign storage", () => {
    expect(parseOfflineState(null)).toEqual({ recent: [], dirty: [] });
    expect(parseOfflineState("{nope")).toEqual({ recent: [], dirty: [] });
    expect(parseOfflineState(JSON.stringify({ recent: [page("a"), { id: 3 }], dirty: ["a", 4] }))).toEqual({
      recent: [page("a")],
      dirty: ["a"],
    });
  });

  it("evicts the oldest snapshots", () => {
    const entries = [
      { key: "a", savedAt: 1 },
      { key: "b", savedAt: 3 },
      { key: "c", savedAt: 2 },
    ];
    expect(snapshotsToEvict(entries, 2)).toEqual(["a"]);
    expect(snapshotsToEvict(entries, 5)).toEqual([]);
  });
});

describe("sync state", () => {
  const base = {
    accessLost: false,
    socket: "connected" as const,
    tokenFailed: false,
    browserOffline: false,
    serverSynced: true,
    ready: true,
    unsynced: false,
  };

  it("is live when connected and confirmed", () => {
    expect(syncState(base)).toBe("live");
  });

  it("is syncing while edits wait for the server, or until the server state arrived", () => {
    expect(syncState({ ...base, unsynced: true })).toBe("syncing");
    expect(syncState({ ...base, serverSynced: false })).toBe("syncing");
    expect(syncState({ ...base, serverSynced: false, ready: false })).toBe("connecting");
  });

  it("is offline without the network, the socket or a token", () => {
    expect(syncState({ ...base, browserOffline: true })).toBe("offline");
    expect(syncState({ ...base, socket: "disconnected" })).toBe("offline");
    expect(syncState({ ...base, tokenFailed: true })).toBe("offline");
  });

  it("says reconnecting once the page was shown, connecting before", () => {
    expect(syncState({ ...base, socket: "connecting" })).toBe("reconnecting");
    expect(syncState({ ...base, socket: "connecting", ready: false })).toBe("connecting");
  });

  it("says not saved while the server's saves fail, unless the connection itself is down", () => {
    expect(syncState({ ...base, saveFailed: true })).toBe("notSaved");
    expect(syncState({ ...base, saveFailed: true, unsynced: true })).toBe("notSaved");
    expect(syncState({ ...base, saveFailed: true, socket: "disconnected" })).toBe("offline");
    expect(syncState({ ...base, saveFailed: true, socket: "connecting" })).toBe("reconnecting");
  });

  it("puts lost access above everything", () => {
    expect(syncState({ ...base, accessLost: true, browserOffline: true })).toBe("noAccess");
  });
});
