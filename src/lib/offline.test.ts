import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  belongsToSomeoneElse,
  copiesDue,
  copiesToDrop,
  descendantsOf,
  EMPTY_STATE,
  FILE_PATH,
  fileFits,
  filesOnlyIn,
  forgetPage,
  isKeptOffline,
  keepPage,
  keptSnapshotKeys,
  keptSummaries,
  mayDropDocument,
  MAX_FILE_BYTES,
  MAX_PAGE_FILE_BYTES,
  reconcileFavorites,
  recordCopy,
  setChildren,
  setKeepFavorites,
  wantedPages,
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
  type OfflinePage,
  type OfflineState,
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
    const filePath = /const FILE_PATH = (\/.+\/);/.exec(sw)?.[1];
    expect(filePath).toBe(FILE_PATH.toString());
    expect(FILE_PATH.test("/api/files/abc_DEF-123")).toBe(true);
    expect(FILE_PATH.test("/api/files/abc/preview")).toBe(false);
  });
});

describe("recent pages and unsent edits", () => {
  it("puts a page first, once, and keeps a bounded list", () => {
    const list = [page("a"), page("b"), page("c")];
    expect(rememberRecent(list, page("b", 5)).map((p) => p.id)).toEqual(["b", "a", "c"]);
    expect(rememberRecent(list, page("d"), 3).map((p) => p.id)).toEqual(["d", "a", "b"]);
  });

  it("marks and clears pages with edits waiting for the server", () => {
    const empty = EMPTY_STATE;
    const one = setDirty(empty, "p1", true);
    expect(one.dirty).toEqual(["p1"]);
    expect(setDirty(one, "p1", true)).toBe(one);
    expect(setDirty(one, "p1", false).dirty).toEqual([]);
  });

  it("forgets a page the server refused", () => {
    const state = { ...EMPTY_STATE, recent: [page("a"), page("b")], dirty: ["a", "b"] };
    expect(forgetPage(state, "a")).toEqual({ ...EMPTY_STATE, recent: [page("b")], dirty: ["b"] });
  });

  it("survives broken or foreign storage", () => {
    expect(parseOfflineState(null)).toEqual(EMPTY_STATE);
    expect(parseOfflineState("{nope")).toEqual(EMPTY_STATE);
    // State written before downloads existed: favorites are kept offline unless turned off.
    expect(parseOfflineState(JSON.stringify({ recent: [page("a"), { id: 3 }], dirty: ["a", 4] }))).toEqual({
      ...EMPTY_STATE,
      recent: [page("a")],
      dirty: ["a"],
    });
    const kept = keepPage(EMPTY_STATE, doc("k"), { manual: true }, 1);
    const stored = JSON.stringify({ ...kept, keepFavorites: false, kept: [...kept.kept, { id: 5 }], copies: { k: copy(1), x: { bytes: "?" } } });
    expect(parseOfflineState(stored)).toEqual({ ...kept, keepFavorites: false, copies: { k: copy(1) } });
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

const doc = (id: string, extra: Partial<OfflinePage> = {}): OfflinePage => ({
  id,
  workspaceId: "ws",
  title: id,
  icon: null,
  kind: "page",
  row: false,
  ...extra,
});
const copy = (syncedAt: number, files: string[] = [], bytes = 10) => ({ syncedAt, bytes, files });

describe("pages downloaded for offline use", () => {
  it("keeps a page while it has a reason to, and lets it go without one", () => {
    let state = keepPage(EMPTY_STATE, doc("a"), { manual: true }, 1);
    expect(state.kept).toEqual([{ ...doc("a"), manual: true, favorite: false, subpages: false, children: [], at: 1 }]);
    state = keepPage(state, doc("a", { title: "renamed" }), { favorite: true });
    expect(state.kept[0]).toMatchObject({ title: "renamed", manual: true, favorite: true, at: 1 });
    state = keepPage(state, doc("a"), { manual: false });
    expect(state.kept).toHaveLength(1);
    state = keepPage(state, doc("a"), { favorite: false });
    expect(state.kept).toEqual([]);
    // Turning off what was never on changes nothing.
    expect(keepPage(EMPTY_STATE, doc("b"), { manual: false })).toBe(EMPTY_STATE);
  });

  it("stores only the page's own fields", () => {
    const extra = { ...doc("a"), updatedAt: new Date(), teamspaceId: "t" } as OfflinePage;
    expect(Object.keys(keepPage(EMPTY_STATE, extra, { manual: true }).kept[0]).sort()).toEqual(
      ["at", "children", "favorite", "icon", "id", "kind", "manual", "row", "subpages", "title", "workspaceId"],
    );
  });

  it("takes sub-pages along only while asked to, and at most the cap", () => {
    let state = keepPage(EMPTY_STATE, doc("a"), { manual: true });
    state = setChildren(state, "a", [doc("b")]);
    expect(state.kept[0].children).toEqual([]);
    state = keepPage(state, doc("a"), { subpages: true });
    state = setChildren(state, "a", [doc("a"), doc("b"), doc("c"), doc("d")], 2);
    expect(state.kept[0].children.map((c) => c.id)).toEqual(["b", "c"]);
    expect([...wantedPages(state).keys()]).toEqual(["a", "b", "c"]);
    expect(wantedPages(state).get("c")?.root).toBe("a");
    expect(isKeptOffline(state, "c")).toBe(true);
    expect(isKeptOffline(state, "d")).toBe(false);
    state = keepPage(state, doc("a"), { subpages: false });
    expect(state.kept[0].children).toEqual([]);
  });

  it("follows a workspace's favorites, leaving other workspaces and pages turned on by hand", () => {
    let state = keepPage(EMPTY_STATE, doc("manual"), { manual: true });
    state = keepPage(state, doc("other", { workspaceId: "ws2" }), { favorite: true });
    const fav = (id: string, title = id) => ({ id, title, icon: null, kind: "page" as const });
    state = reconcileFavorites(state, "ws", [fav("manual"), fav("f1")]);
    expect(state.kept.map((p) => [p.id, p.manual, p.favorite])).toEqual([
      ["manual", true, true],
      ["other", false, true],
      ["f1", false, true],
    ]);
    // Nothing changed: the same object, so nothing is written.
    expect(reconcileFavorites(state, "ws", [fav("manual"), fav("f1")])).toBe(state);
    state = reconcileFavorites(state, "ws", [fav("f1", "new title")]);
    expect(state.kept.map((p) => [p.id, p.manual, p.favorite, p.title])).toEqual([
      ["manual", true, false, "manual"],
      ["other", false, true, "other"],
      ["f1", false, true, "new title"],
    ]);
    // At most the cap of a workspace's favorites.
    expect(reconcileFavorites(EMPTY_STATE, "ws", [fav("a"), fav("b"), fav("c")], 2).kept.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("keeps no favorites once turned off on this device", () => {
    let state = keepPage(EMPTY_STATE, doc("both"), { manual: true, favorite: true });
    state = keepPage(state, doc("fav"), { favorite: true });
    state = setKeepFavorites(state, false);
    expect(state.keepFavorites).toBe(false);
    expect(state.kept.map((p) => [p.id, p.favorite])).toEqual([["both", false]]);
    expect(reconcileFavorites(state, "ws", [{ id: "fav", title: "fav", icon: null, kind: "page" }])).toBe(state);
    expect(setKeepFavorites(state, false)).toBe(state);
  });

  it("downloads what has no copy or an old one, and drops copies nothing wants", () => {
    let state = keepPage(EMPTY_STATE, doc("a"), { manual: true, subpages: true });
    state = setChildren(state, "a", [doc("b")]);
    state = recordCopy(state, "a", copy(1000));
    state = recordCopy(state, "gone", copy(1000));
    expect(copiesDue(state, 1500, 1000).map((p) => p.id)).toEqual(["b"]);
    expect(copiesDue(state, 2000, 1000).map((p) => p.id)).toEqual(["a", "b"]);
    expect(copiesToDrop(state)).toEqual(["gone"]);
  });

  it("keeps a document that is wanted, recent or holding unsent edits", () => {
    const state: OfflineState = { ...keepPage(EMPTY_STATE, doc("kept"), { manual: true }), recent: [page("recent")], dirty: ["dirty"] };
    expect(mayDropDocument(state, "kept")).toBe(false);
    expect(mayDropDocument(state, "recent")).toBe(false);
    expect(mayDropDocument(state, "dirty")).toBe(false);
    expect(mayDropDocument(state, "other")).toBe(true);
  });

  it("drops only files no other copy shows", () => {
    let state = recordCopy(EMPTY_STATE, "a", copy(1, ["f1", "f2"]));
    state = recordCopy(state, "b", copy(1, ["f2"]));
    expect(filesOnlyIn(state, "a")).toEqual(["f1"]);
    expect(filesOnlyIn(state, "missing")).toEqual([]);
  });

  it("caps files one by one and per page", () => {
    expect(fileFits(1024, 0)).toBe(true);
    expect(fileFits(MAX_FILE_BYTES, 0)).toBe(true);
    expect(fileFits(MAX_FILE_BYTES + 1, 0)).toBe(false);
    expect(fileFits(1024, MAX_PAGE_FILE_BYTES - 1023)).toBe(false);
    expect(fileFits(1024, MAX_PAGE_FILE_BYTES - 1024)).toBe(true);
    expect(fileFits(NaN, 0)).toBe(false);
    expect(fileFits(-1, 0)).toBe(false);
  });

  it("finds the pages under a page, nearest first, up to the cap", () => {
    const node = (id: string, parentId: string | null, kind: "page" | "database" = "page") => ({ id, parentId, title: id, icon: null, kind });
    const tree = [node("root", null), node("a", "root"), node("a1", "a"), node("b", "root", "database"), node("other", null), node("a2", "a")];
    expect(descendantsOf(tree, "root", "ws").map((p) => p.id)).toEqual(["a", "b", "a1", "a2"]);
    expect(descendantsOf(tree, "root", "ws", 2).map((p) => p.id)).toEqual(["a", "b"]);
    expect(descendantsOf(tree, "root", "ws")[1]).toEqual({ id: "b", workspaceId: "ws", title: "b", icon: null, kind: "database", row: false });
    expect(descendantsOf(tree, "a1", "ws")).toEqual([]);
  });

  it("sums a kept page with its sub-pages for Settings", () => {
    let state = keepPage(EMPTY_STATE, doc("a"), { manual: true, subpages: true });
    state = setChildren(state, "a", [doc("b")]);
    state = recordCopy(state, "a", copy(5, [], 100));
    expect(keptSummaries(state)[0]).toMatchObject({ bytes: 100, syncedAt: null, unsent: false });
    state = { ...recordCopy(state, "b", copy(3, [], 50)), dirty: ["b"] };
    expect(keptSummaries(state)[0]).toMatchObject({ bytes: 150, syncedAt: 3, unsent: true });
  });

  it("never evicts downloaded pages' rows or the sidebar trees", () => {
    let state = keepPage(EMPTY_STATE, doc("db", { kind: "database" }), { manual: true });
    state = keepPage(state, doc("row", { row: true }), { manual: true });
    const keep = keptSnapshotKeys(state);
    expect([...keep].sort()).toEqual(["db:db", "row:row"]);
    const entries = [
      { key: "db:db", savedAt: 1 },
      { key: "row:row", savedAt: 1 },
      { key: "tree:ws", savedAt: 1 },
      { key: "db:x", savedAt: 2 },
      { key: "db:y", savedAt: 3 },
    ];
    expect(snapshotsToEvict(entries, 1, keep)).toEqual(["db:x"]);
  });

  it("forgets a page that is gone everywhere it is kept", () => {
    let state = keepPage(EMPTY_STATE, doc("a"), { manual: true, subpages: true });
    state = setChildren(state, "a", [doc("b"), doc("c")]);
    state = recordCopy(recordCopy(state, "a", copy(1)), "b", copy(1));
    const forgotten = forgetPage(state, "b");
    expect(forgotten.kept[0].children.map((c) => c.id)).toEqual(["c"]);
    expect(Object.keys(forgotten.copies)).toEqual(["a"]);
    expect(forgetPage(state, "a").kept).toEqual([]);
  });
});
