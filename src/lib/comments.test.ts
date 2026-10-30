import { describe, expect, it } from "vitest";
import {
  cleanCommentBody,
  CommentError,
  commentGroupMentions,
  commentImages,
  commentMentions,
  commentText,
  isEmojiOnly,
  keepCommentImages,
  MAX_COMMENT_IMAGES,
  MAX_COMMENT_LENGTH,
  mentionsAsText,
  replyAudience,
  safeHref,
  threadBefore,
  threadParticipants,
  type PlainComment,
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

  const A = "/api/files/" + "a".repeat(24);
  const B = "https://app.example/api/files/" + "b".repeat(24);

  it("keeps the uploaded files images blocks show, as one block after the text", () => {
    const body = cleanCommentBody([
      { type: "images", props: { urls: `${A}\nhttps://evil.example/x.png\n${A}` } },
      { type: "paragraph", content: "Look" },
      { type: "paragraph", content: [] },
      { type: "images", props: { urls: B } },
    ]);
    expect(body).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Look", styles: {} }] },
      { type: "images", props: { urls: `${A}\n/api/files/${"b".repeat(24)}` } },
    ]);
    expect(commentText(body)).toBe("Look");
    expect(commentImages(body)).toEqual([A, `/api/files/${"b".repeat(24)}`]);
  });

  it("takes a comment of only images, but not too many", () => {
    expect(cleanCommentBody([{ type: "paragraph", content: [] }, { type: "images", props: { urls: A } }])).toEqual([
      { type: "images", props: { urls: A } },
    ]);
    const many = Array.from({ length: MAX_COMMENT_IMAGES + 1 }, (_, i) => `/api/files/${String(i).padStart(24, "c")}`).join("\n");
    expect(() => cleanCommentBody([{ type: "images", props: { urls: many } }])).toThrow(CommentError);
    expect(() => cleanCommentBody([{ type: "images", props: { urls: "https://evil.example/x.png" } }])).toThrow(CommentError);
  });

  it("keeps only the images the page holds", () => {
    const body = cleanCommentBody([{ type: "paragraph", content: "Hi" }, { type: "images", props: { urls: `${A}\n${B}` } }]);
    expect(commentImages(keepCommentImages(body, new Set(["a".repeat(24)])))).toEqual([A]);
    expect(keepCommentImages(body, new Set())).toEqual([{ type: "paragraph", content: [{ type: "text", text: "Hi", styles: {} }] }]);
    const onlyImages = cleanCommentBody([{ type: "images", props: { urls: A } }]);
    expect(() => keepCommentImages(onlyImages, new Set())).toThrow(CommentError);
  });
});

describe("isEmojiOnly", () => {
  it("is one to three emoji, spaces aside", () => {
    expect(isEmojiOnly("👍")).toBe(true);
    expect(isEmojiOnly(" 🎉 🎉🎉 ")).toBe(true);
    expect(isEmojiOnly("👩‍💻")).toBe(true);
    expect(isEmojiOnly("👍🏽")).toBe(true);
    expect(isEmojiOnly("🇹🇷")).toBe(true);
    expect(isEmojiOnly("❤️")).toBe(true);
  });

  it("is not text, numbers or more emoji", () => {
    expect(isEmojiOnly("")).toBe(false);
    expect(isEmojiOnly("ok 👍")).toBe(false);
    expect(isEmojiOnly("1")).toBe(false);
    expect(isEmojiOnly("#")).toBe(false);
    expect(isEmojiOnly("👍👍👍👍")).toBe(false);
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

  it("of groups are read apart from people, and stored as the group's name", () => {
    const withGroup = [
      {
        type: "paragraph",
        content: [
          { type: "mention", props: { kind: "group", id: "g1", groupId: "grp-1", name: "Design team" } },
          { type: "text", text: " and ", styles: {} },
          { type: "mention", props: { kind: "user", userId: "bob", name: "Bob" } },
          { type: "mention", props: { kind: "group", groupId: "grp-1", name: "Design team" } },
        ],
      },
    ];
    expect(commentGroupMentions(withGroup)).toEqual(["grp-1"]);
    expect(commentMentions(withGroup)).toEqual(["bob"]);
    expect(commentText(cleanCommentBody(mentionsAsText(withGroup, () => null)))).toBe("@Design team and @Bob@Design team");
  });

  it("are stored as the person's name", () => {
    expect(commentText(cleanCommentBody(body))).toBe("Over to @Bob@Bob");
  });

  it("of pages are sent as the text they show", () => {
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

  it("of days stay days, without their reminder or id", () => {
    const written = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Due ", styles: {} },
          { type: "mention", props: { kind: "date", date: "2026-11-02", id: "m1", remindAt: "2026-11-01T09:00:00.000Z", pageId: "" } },
          { type: "mention", props: { kind: "date", date: "2026-02-30" } },
          { type: "mention", props: { kind: "date", date: "tomorrow" } },
        ],
      },
    ];
    const [block] = cleanCommentBody(mentionsAsText(written, () => null)) as { content: unknown[] }[];
    expect(block.content).toEqual([
      { type: "text", text: "Due ", styles: {} },
      { type: "mention", props: { kind: "date", date: "2026-11-02" } },
    ]);
    expect(commentText([block])).toBe("Due 2026-11-02");
  });

  it("of links are sent as links with their title", () => {
    const pasted = [
      {
        type: "paragraph",
        content: [
          { type: "mention", props: { kind: "link", url: "https://example.com/a", title: "Docs", favicon: "https://example.com/i.ico" } },
          { type: "mention", props: { kind: "link", url: "javascript:alert(1)", title: "Bad" } },
        ],
      },
    ];
    const [block] = cleanCommentBody(mentionsAsText(pasted, () => null)) as { content: unknown[] }[];
    expect(block.content).toEqual([{ type: "link", href: "https://example.com/a", content: [{ type: "text", text: "Docs", styles: {} }] }]);
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

describe("threadBefore", () => {
  const comment = (id: string, userId: string, text: string, deleted = false): PlainComment => ({
    id,
    userId,
    createdAt: "",
    updatedAt: "",
    deletedAt: deleted ? "2026-01-01T00:00:00.000Z" : null,
    body: deleted ? null : [{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }],
    reactions: [],
  });
  const names = (id: string) => ({ ada: "Ada", bot: "Helper (agent)" })[id] ?? "Someone";
  const thread = {
    comments: [comment("c1", "ada", "First"), comment("c2", "bob", "gone", true), comment("c3", "bot", "Sure."), comment("c4", "ada", "@Helper now"), comment("c5", "ada", "Later")],
  };

  it("reads the comments before the one that mentioned the agent, oldest first, deleted ones left out", () => {
    expect(threadBefore(thread, "c4", names, { max: 20, chars: 1000 })).toEqual(["Ada: First", "Helper (agent): Sure."]);
    expect(threadBefore(thread, "c1", names, { max: 20, chars: 1000 })).toEqual([]);
    expect(threadBefore(thread, "missing", names, { max: 20, chars: 1000 })).toEqual([]);
  });

  it("keeps the newest that fit, by count and by length", () => {
    expect(threadBefore(thread, "c5", names, { max: 1, chars: 1000 })).toEqual(["Ada: @Helper now"]);
    expect(threadBefore(thread, "c5", names, { max: 20, chars: 40 })).toEqual(["Helper (agent): Sure.", "Ada: @Helper now"]);
  });
});
