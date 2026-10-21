import { describe, expect, it } from "vitest";
import {
  cleanCommentBody,
  CommentError,
  commentMentions,
  commentText,
  MAX_COMMENT_LENGTH,
  mentionsAsText,
  replyAudience,
  safeHref,
  threadParticipants,
} from "./comments";

describe("cleanCommentBody", () => {
  it("keeps paragraphs, allowed styles and web links", () => {
    const body = cleanCommentBody([
      {
        id: "b1",
        type: "paragraph",
        props: { textColor: "red" },
        content: [
          { type: "text", text: "Hello ", styles: { bold: true, textColor: "red" } },
          { type: "link", href: "https://example.com/a", content: [{ type: "text", text: "there", styles: {} }] },
        ],
        children: [{ type: "paragraph", content: "nested" }],
      },
    ]);
    expect(body).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello ", styles: { bold: true } },
          { type: "link", href: "https://example.com/a", content: [{ type: "text", text: "there", styles: {} }] },
        ],
      },
    ]);
  });

  it("drops script links and other blocks, keeping the link's text", () => {
    const body = cleanCommentBody([
      { type: "paragraph", content: [{ type: "link", href: "javascript:alert(1)", content: "click" }] },
      { type: "image", props: { url: "https://x" } },
    ]);
    expect(body).toEqual([{ type: "paragraph", content: [{ type: "text", text: "click", styles: {} }] }]);
  });

  it("turns plain text into one paragraph per line", () => {
    expect(commentText(cleanCommentBody("one\ntwo"))).toBe("one\ntwo");
  });

  it("refuses empty and overlong comments", () => {
    expect(() => cleanCommentBody([{ type: "paragraph", content: "  " }])).toThrow(CommentError);
    expect(() => cleanCommentBody(null)).toThrow(CommentError);
    expect(() => cleanCommentBody("x".repeat(MAX_COMMENT_LENGTH + 1))).toThrow(CommentError);
  });
});

describe("safeHref", () => {
  it("allows web and email links only", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com/");
    expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
  });
});

describe("threadParticipants", () => {
  const comment = (id: string, userId: string) => ({ id, userId, createdAt: "", updatedAt: "", deletedAt: null, body: null, reactions: [] });
  it("lists earlier commenters once, without the new comment's author", () => {
    const thread = { comments: [comment("c1", "ann"), comment("c2", "bob"), comment("c3", "ann"), comment("c4", "cem")] };
    expect(threadParticipants(thread, "cem", "c4")).toEqual(["ann", "bob"]);
    expect(threadParticipants(thread, "ann")).toEqual(["bob", "cem"]);
  });
});

describe("comment mentions", () => {
  const body = [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Over to ", styles: {} },
        { type: "mention", props: { kind: "user", id: "m1", userId: "bob", name: "Bob" } },
        { type: "mention", props: { kind: "page", pageId: "p1" } },
        { type: "mention", props: { kind: "user", id: "m2", userId: "bob", name: "Bob" } },
      ],
    },
  ];

  it("are the people mentioned, once each", () => {
    expect(commentMentions(body)).toEqual(["bob"]);
    expect(commentMentions("@Bob")).toEqual([]);
  });

  it("are stored as the person's name", () => {
    expect(commentText(cleanCommentBody(body))).toBe("Over to @Bob@Bob");
  });

  it("of pages and dates are sent as the text they show", () => {
    const pasted = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "See ", styles: {} },
          { type: "mention", props: { kind: "page", pageId: "p1" } },
          { type: "text", text: " by ", styles: {} },
          { type: "mention", props: { kind: "date", date: "2026-11-02" } },
          { type: "mention", props: { kind: "page", pageId: "hidden" } },
          { type: "mention", props: { kind: "user", userId: "bob", name: "Bob" } },
        ],
      },
    ];
    const sent = mentionsAsText(pasted, (id) => (id === "p1" ? "Price list" : null));
    expect(commentMentions(sent)).toEqual(["bob"]);
    expect(commentText(cleanCommentBody(sent))).toBe("See Price list by 2026-11-02@Bob");
    expect(mentionsAsText("plain", () => null)).toBe("plain");
  });
});

describe("replyAudience", () => {
  const participants = ["ann", "bob", "cem"];

  it("leaves out the people who muted the thread, and no one else", () => {
    expect(replyAudience({ participants, muted: ["bob"], mentioned: [], authorId: "dan" })).toEqual({ notify: ["ann", "cem"], unmute: [] });
    expect(replyAudience({ participants, muted: [], mentioned: [], authorId: "dan" }).notify).toEqual(participants);
  });

  it("still tells someone who muted it when the reply mentions them, and ends their mute", () => {
    expect(replyAudience({ participants, muted: ["bob"], mentioned: ["bob"], authorId: "ann" })).toEqual({ notify: ["cem", "bob"], unmute: ["bob"] });
  });

  it("tells people it mentions who weren't in the thread", () => {
    expect(replyAudience({ participants: ["ann"], muted: [], mentioned: ["eve"], authorId: "cem" }).notify).toEqual(["ann", "eve"]);
  });

  it("ends the author's own mute when they post in the thread", () => {
    expect(replyAudience({ participants: ["ann"], muted: ["bob", "cem"], mentioned: [], authorId: "bob" })).toEqual({ notify: ["ann"], unmute: ["bob"] });
  });

  it("never tells the author, even when they mention themselves", () => {
    expect(replyAudience({ participants: ["ann"], muted: [], mentioned: ["bob"], authorId: "bob" }).notify).toEqual(["ann"]);
  });
});
