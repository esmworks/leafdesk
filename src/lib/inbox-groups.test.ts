import { describe, expect, it } from "vitest";
import { GROUP_WINDOW_MS, groupCounts, groupInbox } from "./inbox-groups";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 23, 12, 0) - minutes * 60_000);
const n = (id: string, kind: string, pageId: string | null, minutes: number, read = false) => ({ id, kind, pageId, createdAt: at(minutes), read });

describe("groupInbox", () => {
  it("groups comments on one page that came close together, where the newest stands", () => {
    const entries = groupInbox([n("a", "comment", "p1", 0), n("b", "mention", "p1", 5), n("c", "comment", "p1", 10), n("d", "reaction", "p1", 20, true)]);
    expect(entries.map((e) => (e.type === "item" ? e.item.id : e.items.map((i) => i.id).join("+")))).toEqual(["a+c+d", "b"]);
    const group = entries[0];
    expect(group.type === "group" && group.unread).toBe(2);
    expect(group.type === "group" && group.key).toBe("group:a");
    expect(group.type === "group" && group.family).toBe("comments");
  });

  it("keeps a single notification on its own", () => {
    const entries = groupInbox([n("a", "comment", "p1", 0), n("b", "comment", "p2", 1)]);
    expect(entries.every((e) => e.type === "item")).toBe(true);
  });

  it("groups edits apart from comments, and pages apart", () => {
    const entries = groupInbox([
      n("a", "page_updated", "p1", 0),
      n("b", "comment", "p1", 1),
      n("c", "row_update", "p1", 2),
      n("d", "comment", "p2", 3),
      n("e", "comment", "p1", 4),
    ]);
    expect(entries.map((e) => (e.type === "item" ? e.item.id : e.items.map((i) => i.id).join("+")))).toEqual(["a+c", "b+e", "d"]);
  });

  it("starts a new group past the window", () => {
    const window = GROUP_WINDOW_MS / 60_000;
    const entries = groupInbox([n("a", "comment", "p1", 0), n("b", "comment", "p1", window), n("c", "comment", "p1", window + 1), n("d", "comment", "p1", window + 2)]);
    expect(entries.map((e) => (e.type === "item" ? e.item.id : e.items.map((i) => i.id).join("+")))).toEqual(["a+b", "c+d"]);
  });

  it("never groups kinds outside a family or without a page", () => {
    const entries = groupInbox([n("a", "assignment", "p1", 0), n("b", "assignment", "p1", 1), n("c", "join_request", null, 2), n("d", "join_request", null, 3)]);
    expect(entries).toHaveLength(4);
  });
});

describe("groupCounts", () => {
  it("counts each kind, or only the unread ones", () => {
    const items = [n("a", "comment", "p1", 0), n("b", "reaction", "p1", 1, true), n("c", "comment", "p1", 2)];
    expect(groupCounts(items, false)).toEqual({ comment: 2, reaction: 1 });
    expect(groupCounts(items, true)).toEqual({ comment: 2 });
  });
});
