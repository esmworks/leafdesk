import { describe, expect, it } from "vitest";
import { addReactor, parseReactors, reactionSummary, reactionTarget, removeReactor } from "./comment-reactions";
import type { PlainThread } from "./comments";

const comment = (id: string, userId: string, reactions: { emoji: string; userIds: string[] }[] = [], deleted = false) => ({
  id,
  userId,
  createdAt: "",
  updatedAt: "",
  deletedAt: deleted ? "2026-10-23T00:00:00Z" : null,
  body: deleted ? null : [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Ship   it\non Friday", styles: {} }] }],
  reactions,
});
const thread = (comments: PlainThread["comments"]) => ({ comments });

describe("reactionTarget", () => {
  it("tells the comment's author, with the comment's start", () => {
    expect(reactionTarget(thread([comment("c1", "ann", [{ emoji: "👍", userIds: ["bob"] }])]), "c1", "bob", "👍")).toEqual({
      authorId: "ann",
      reacted: true,
      excerpt: "Ship it on Friday",
    });
  });

  it("says when the reaction is gone (taken back)", () => {
    expect(reactionTarget(thread([comment("c1", "ann")]), "c1", "bob", "👍")?.reacted).toBe(false);
  });

  it("tells nobody about one's own reactions, deleted comments or missing ones", () => {
    expect(reactionTarget(thread([comment("c1", "ann", [{ emoji: "👍", userIds: ["ann"] }])]), "c1", "ann", "👍")).toBeNull();
    expect(reactionTarget(thread([comment("c1", "ann", [], true)]), "c1", "bob", "👍")).toBeNull();
    expect(reactionTarget(thread([comment("c1", "ann")]), "c2", "bob", "👍")).toBeNull();
    expect(reactionTarget(undefined, "c1", "bob", "👍")).toBeNull();
  });
});

describe("reactors", () => {
  it("adds each person's emoji once, the latest last", () => {
    let list = addReactor([], { userId: "bob", emoji: "👍" });
    list = addReactor(list, { userId: "cy", emoji: "🎉" });
    list = addReactor(list, { userId: "bob", emoji: "👍" });
    expect(list).toEqual([
      { userId: "cy", emoji: "🎉" },
      { userId: "bob", emoji: "👍" },
    ]);
    expect(reactionSummary(list)).toEqual({ emojis: ["👍", "🎉"], userIds: ["bob", "cy"] });
  });

  it("takes one reaction out and leaves the person's others", () => {
    const list = [
      { userId: "bob", emoji: "👍" },
      { userId: "bob", emoji: "🎉" },
      { userId: "cy", emoji: "👍" },
    ];
    expect(removeReactor(list, { userId: "bob", emoji: "👍" })).toEqual([
      { userId: "bob", emoji: "🎉" },
      { userId: "cy", emoji: "👍" },
    ]);
  });

  it("reads only well-formed entries back", () => {
    expect(parseReactors([{ userId: "bob", emoji: "👍" }, { userId: 1 }, "x", null])).toEqual([{ userId: "bob", emoji: "👍" }]);
    expect(parseReactors(null)).toEqual([]);
  });
});
