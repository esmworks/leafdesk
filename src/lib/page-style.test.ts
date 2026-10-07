import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_META } from "./collab-constants";
import {
  DEFAULT_PAGE_STYLE,
  observePageStyle,
  pageStyleFromYdoc,
  pageStyleKey,
  parsePageStyleKey,
  readPageStyle,
  writePageStyle,
} from "./page-style";

describe("page style", () => {
  it("reads the defaults from a doc that never had a style", () => {
    expect(readPageStyle(new Y.Doc())).toEqual(DEFAULT_PAGE_STYLE);
  });

  it("writes and reads each setting, and leaves the others alone", () => {
    const doc = new Y.Doc();
    writePageStyle(doc, { font: "serif" });
    writePageStyle(doc, { fullWidth: true });
    expect(readPageStyle(doc)).toEqual({ font: "serif", smallText: false, fullWidth: true });
    writePageStyle(doc, { smallText: true, font: "mono" });
    expect(readPageStyle(doc)).toEqual({ font: "mono", smallText: true, fullWidth: true });
  });

  it("stores the defaults as absent keys", () => {
    const doc = new Y.Doc();
    writePageStyle(doc, { font: "mono", smallText: true, fullWidth: true });
    writePageStyle(doc, DEFAULT_PAGE_STYLE);
    const meta = doc.getMap(COLLAB_META);
    expect([...meta.keys()]).toEqual([]);
    expect(readPageStyle(doc)).toEqual(DEFAULT_PAGE_STYLE);
  });

  it("makes one update for a change and none when nothing changes", () => {
    const doc = new Y.Doc();
    let updates = 0;
    doc.on("update", () => updates++);
    writePageStyle(doc, { font: "serif", fullWidth: true });
    expect(updates).toBe(1);
    writePageStyle(doc, { font: "serif", fullWidth: true, smallText: false });
    expect(updates).toBe(1);
  });

  it("reads unknown values written by someone else as the default", () => {
    const doc = new Y.Doc();
    const meta = doc.getMap(COLLAB_META);
    meta.set("font", "comic");
    meta.set("smallText", "yes");
    meta.set("fullWidth", 1);
    expect(readPageStyle(doc)).toEqual(DEFAULT_PAGE_STYLE);
  });

  it("syncs between replicas", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u));
    let seen = 0;
    const stop = observePageStyle(b, () => seen++);
    writePageStyle(a, { fullWidth: true });
    expect(readPageStyle(b).fullWidth).toBe(true);
    expect(seen).toBe(1);
    stop();
    writePageStyle(a, { fullWidth: false });
    expect(seen).toBe(1);
  });

  it("round-trips through its string key", () => {
    for (const style of [DEFAULT_PAGE_STYLE, { font: "mono", smallText: true, fullWidth: false } as const]) {
      expect(parsePageStyleKey(pageStyleKey(style))).toEqual(style);
    }
    expect(parsePageStyleKey("nonsense")).toEqual(DEFAULT_PAGE_STYLE);
  });

  it("reads a stored state, and falls back to the defaults without one or for a broken one", () => {
    const doc = new Y.Doc();
    writePageStyle(doc, { font: "serif", smallText: true });
    expect(pageStyleFromYdoc(Y.encodeStateAsUpdate(doc))).toEqual({ font: "serif", smallText: true, fullWidth: false });
    expect(pageStyleFromYdoc(null)).toEqual(DEFAULT_PAGE_STYLE);
    expect(pageStyleFromYdoc(new Uint8Array([1, 2, 3, 250]))).toEqual(DEFAULT_PAGE_STYLE);
  });
});
