import { describe, expect, it } from "vitest";
import { commentPath, linkedCommentRef } from "./comment-refs";

describe("linkedCommentRef", () => {
  it("reads a link to a thread, relative or on the app's address", () => {
    expect(linkedCommentRef("/w/ws1/p/page1#comment-t1")).toEqual({ workspaceId: "ws1", pageId: "page1", threadId: "t1" });
    expect(linkedCommentRef("https://app.example/w/ws1/p/page1?row=x#comment-t1", "https://app.example")).toEqual({
      workspaceId: "ws1",
      pageId: "page1",
      threadId: "t1",
    });
    expect(linkedCommentRef(commentPath("a", "b", "c"))).toEqual({ workspaceId: "a", pageId: "b", threadId: "c" });
  });

  it("leaves other links alone", () => {
    expect(linkedCommentRef("/w/ws1/p/page1")).toBeNull();
    expect(linkedCommentRef("/w/ws1/p/page1#block-b1")).toBeNull();
    expect(linkedCommentRef("https://elsewhere.example/w/ws1/p/page1#comment-t1", "https://app.example")).toBeNull();
    expect(linkedCommentRef(42)).toBeNull();
  });
});
