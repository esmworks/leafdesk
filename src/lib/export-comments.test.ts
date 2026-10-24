import { describe, expect, it } from "vitest";
import type { CommentBody, PlainComment, PlainThread } from "@/lib/comments";
import { commentDate, commentMarkdown, commentsMarkdown, ENGLISH_COMMENT_LABELS, exportedThreads, shortQuote } from "./export-comments";

const text = (t: string, styles: Record<string, true> = {}) => ({ type: "text" as const, text: t, styles });
const body = (...paragraphs: string[]): CommentBody => paragraphs.map((p) => ({ type: "paragraph", content: [text(p)] }));

function comment(id: string, userId: string, createdAt: string, b: CommentBody | null, deleted = false): PlainComment {
  return { id, userId, createdAt, updatedAt: createdAt, deletedAt: deleted ? createdAt : null, body: deleted ? null : b, reactions: [] };
}

function thread(id: string, createdAt: string, comments: PlainComment[], extra: Partial<PlainThread> = {}): PlainThread {
  return { id, createdAt, updatedAt: createdAt, resolved: false, resolvedBy: null, comments, ...extra };
}

const names = new Map([
  ["ada", "Ada Demir"],
  ["bora", "Bora Kaya"],
]);
const nameOf = (id: string) => names.get(id);

describe("commentDate", () => {
  it("writes the time in UTC to the minute", () => {
    expect(commentDate("2026-10-24T09:12:45.123Z")).toBe("2026-10-24 09:12 UTC");
    expect(commentDate("2026-10-24T23:30:00+02:00")).toBe("2026-10-24 21:30 UTC");
  });
  it("is empty for a missing or broken time", () => {
    expect(commentDate("")).toBe("");
    expect(commentDate("soon")).toBe("");
  });
});

describe("shortQuote", () => {
  it("keeps a quote on one line and cuts a long one", () => {
    expect(shortQuote("  two\n lines ")).toBe("two lines");
    const long = shortQuote("x".repeat(300));
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("exportedThreads", () => {
  it("says what each thread is about, oldest first", () => {
    const one = [comment("c", "ada", "2026-10-01T10:00:00Z", body("hi"))];
    const threads = [
      thread("removed", "2026-10-05T00:00:00Z", one, { quote: null }),
      thread("quote", "2026-10-01T00:00:00Z", one, { quote: "Beta with five customers" }),
      thread("page", "2026-10-02T00:00:00Z", one, { quote: null, page: true }),
      thread("property", "2026-10-03T00:00:00Z", one, { property: { id: "p", name: "Status" } }),
      thread("suggestion", "2026-10-04T00:00:00Z", one, { quote: null, suggestion: "s1" }),
    ];
    expect(exportedThreads(threads, nameOf, ENGLISH_COMMENT_LABELS).map((t) => t.about)).toEqual([
      "“Beta with five customers”",
      "About this page",
      "On “Status”",
      "Suggested edit",
      "On text that was removed",
    ]);
  });

  it("leaves out deleted and empty comments, and threads with nothing left", () => {
    const threads = [
      thread("a", "2026-10-01T00:00:00Z", [
        comment("c1", "ada", "2026-10-01T10:00:00Z", body("first")),
        comment("c2", "bora", "2026-10-01T11:00:00Z", body("gone"), true),
        comment("c3", "bora", "2026-10-01T12:00:00Z", body("  ")),
        comment("c4", "ghost", "2026-10-01T13:00:00Z", body("from someone who left")),
      ]),
      thread("b", "2026-10-02T00:00:00Z", [comment("c5", "ada", "2026-10-02T10:00:00Z", null, true)], { quote: "x" }),
    ];
    const out = exportedThreads(threads, nameOf, ENGLISH_COMMENT_LABELS);
    expect(out).toHaveLength(1);
    expect(out[0].comments.map((c) => [c.author, c.date])).toEqual([
      ["Ada Demir", "2026-10-01 10:00 UTC"],
      ["Someone", "2026-10-01 13:00 UTC"],
    ]);
  });
});

describe("commentMarkdown", () => {
  it("keeps styles and links, and escapes what Markdown would read", () => {
    const b: CommentBody = [
      {
        type: "paragraph",
        content: [text("Use "), text("bold", { bold: true }), text(" and "), text("a`b", { code: true }), text(" *not* [this]")],
      },
      { type: "paragraph", content: [{ type: "link", href: "https://example.com/a b", content: [text("the doc")] }] },
      { type: "paragraph", content: [text("# not a heading\n1. not a list")] },
    ];
    expect(commentMarkdown(b)).toEqual([
      "Use **bold** and `` a`b `` \\*not\\* \\[this\\]",
      "[the doc](https://example.com/a%20b)",
      "\\# not a heading\n1\\. not a list",
    ]);
  });
});

describe("commentsMarkdown", () => {
  it("writes a section with one heading per thread and each comment quoted under its author", () => {
    const threads = exportedThreads(
      [
        thread(
          "t",
          "2026-10-01T00:00:00Z",
          [comment("c1", "ada", "2026-10-01T10:00:00Z", body("Can we", "send them by email?")), comment("c2", "bora", "2026-10-01T11:05:00Z", body("Yes"))],
          { quote: "Invoices downloadable as PDF", resolved: true },
        ),
      ],
      nameOf,
      ENGLISH_COMMENT_LABELS,
    );
    expect(commentsMarkdown(threads, ENGLISH_COMMENT_LABELS)).toBe(
      [
        "---",
        "## Comments",
        "### “Invoices downloadable as PDF”",
        "*Resolved*",
        "**Ada Demir** · 2026-10-01 10:00 UTC",
        "> Can we\n>\n> send them by email?",
        "**Bora Kaya** · 2026-10-01 11:05 UTC",
        "> Yes",
      ].join("\n\n"),
    );
  });

  it("is empty without threads", () => {
    expect(commentsMarkdown([], ENGLISH_COMMENT_LABELS)).toBe("");
  });
});
