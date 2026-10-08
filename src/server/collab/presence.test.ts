import { describe, expect, it } from "vitest";
import { initialOf, splitViewers, textOn, userColor, viewersOf } from "@/lib/presence";
import { stampPresence } from "./presence";

const states = (...list: Record<string, unknown>[]) => new Map(list.map((s, i) => [i + 1, s]));

describe("stampPresence", () => {
  it("replaces what the browser claimed with the signed-in user", () => {
    const s = states({ presence: { id: "mallory", name: "Ann" }, user: { name: "Ann", color: "#000" } });
    stampPresence(s, { userId: "u1", userName: "Bob" });
    expect(s.get(1)).toEqual({ presence: { id: "u1", name: "Bob" }, user: { name: "Bob", color: userColor("u1") } });
  });

  it("labels the cursor with the signed-in user's name and color, whatever the browser sent", () => {
    const s = states(
      { user: { name: "Ann", color: "#e5484d" } },
      { user: { name: "Bob", color: "#fff;background:url(https://evil.example.com/x)" } },
      { user: { name: "Bob", color: { toString: 1 } } },
      { user: "Ann" },
      { user: { name: "Bob", color: "#0090FF", extra: "<b>" } },
    );
    stampPresence(s, { userId: "u1", userName: "Bob" });
    for (const state of s.values()) expect(state).toEqual({ user: { name: "Bob", color: userColor("u1") } });
    expect(userColor("u1")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("drops a cursor label that no signed-in user backs", () => {
    const s = states({ user: { name: "Ann", color: "#e5484d" }, cursor: { anchor: 1 } });
    stampPresence(s, undefined);
    expect(s.get(1)).toEqual({ cursor: { anchor: 1 } });
  });

  it("stamps any presence value, not only well-formed ones", () => {
    const s = states({ presence: true }, { presence: "x" });
    stampPresence(s, { userId: "u1", userName: "Bob" });
    expect(s.get(1)?.presence).toEqual({ id: "u1", name: "Bob" });
    expect(s.get(2)?.presence).toEqual({ id: "u1", name: "Bob" });
  });

  it("leaves states without presence, or that cleared it, alone", () => {
    const s = states({ cursor: { anchor: 1 } }, { presence: null });
    stampPresence(s, { userId: "u1", userName: "Bob" });
    expect(s.get(1)).toEqual({ cursor: { anchor: 1 } });
    expect(s.get(2)).toEqual({ presence: null });
  });

  it("adds the signed-in user's picture, never the browser's", () => {
    const s = states({ presence: { id: "u1", name: "Bob", image: "https://evil.example.com/x.png" } });
    stampPresence(s, { userId: "u1", userName: "Bob", userImage: "/api/avatars/u1/pic" });
    expect(s.get(1)?.presence).toEqual({ id: "u1", name: "Bob", image: "/api/avatars/u1/pic" });
    stampPresence(s, { userId: "u1", userName: "Bob", userImage: null });
    expect(s.get(1)?.presence).toEqual({ id: "u1", name: "Bob" });
  });

  it("drops presence that no signed-in user backs", () => {
    const s = states({ presence: { id: "u1", name: "Bob" }, other: 1 });
    stampPresence(s, undefined);
    expect(s.get(1)).toEqual({ other: 1 });
  });
});

describe("viewersOf", () => {
  it("lists each person once, in order, without yourself", () => {
    const s = states(
      { presence: { id: "b", name: "Bob" } },
      { presence: { id: "me", name: "Me" } },
      { presence: { id: "c", name: "Cem" } },
      { presence: { id: "b", name: "Bob" } }, // a second tab
      { user: { name: "cursor only" } },
      { presence: null },
      { presence: { id: 5, name: "bad" } },
    );
    expect(viewersOf(s, "me")).toEqual([
      { id: "b", name: "Bob" },
      { id: "c", name: "Cem" },
    ]);
  });

  it("leaves out this tab's own state whatever it claims", () => {
    const s = states({ presence: { id: "b", name: "Bob" } }, { presence: { id: "c", name: "Cem" } });
    expect(viewersOf(s, "me", 1)).toEqual([{ id: "c", name: "Cem" }]);
  });
});

describe("splitViewers", () => {
  it("shows up to the limit without folding", () => {
    expect(splitViewers([1, 2, 3, 4])).toEqual({ shown: [1, 2, 3, 4], more: 0 });
  });

  it("folds the rest into +N, keeping the row at the limit", () => {
    expect(splitViewers([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3], more: 2 });
    expect(splitViewers([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual({ shown: [1, 2, 3], more: 6 });
  });
});

describe("avatars", () => {
  it("shows the first letter of the name", () => {
    expect(initialOf("ada lovelace")).toBe("A");
    expect(initialOf("  Ümit  ")).toBe("Ü");
    expect(initialOf("😀 Smile")).toBe("😀");
    expect(initialOf(" ")).toBe("?");
  });

  it("picks readable text on the cursor colors", () => {
    expect(textOn("#ffc53d")).toBe("#000000");
    expect(textOn("#6e56cf")).toBe("#ffffff");
    expect(textOn("#e5484d")).toBe("#ffffff");
  });
});
