import { describe, expect, it } from "vitest";
import { isReactionEmoji } from "./comments";
import { feedExcerpt, feedPlainExcerpt } from "./feed";

describe("feedExcerpt", () => {
  it("keeps a short body whole", () => {
    expect(feedExcerpt("Hello\n\nWorld")).toEqual({ markdown: "Hello\n\nWorld", more: false });
    expect(feedExcerpt("")).toEqual({ markdown: "", more: false });
  });

  it("keeps whole blocks while they fit, and says more follows", () => {
    const body = ["a".repeat(30), "b".repeat(30), "c".repeat(30)].join("\n\n");
    expect(feedExcerpt(body, { chars: 70 })).toEqual({ markdown: `${"a".repeat(30)}\n\n${"b".repeat(30)}`, more: true });
    expect(feedExcerpt(body, { blocks: 1 })).toEqual({ markdown: "a".repeat(30), more: true });
  });

  it("cuts a first block that is too long at a word", () => {
    const { markdown, more } = feedExcerpt("one two three four five six seven", { chars: 15 });
    expect(markdown).toBe("one two three…");
    expect(more).toBe(true);
  });

  it("keeps a code block whole as one block, and closes it again when cut", () => {
    const code = "```js\nconst a = 1;\nconst b = 2;\n\nconst c = 3;\n```";
    expect(feedExcerpt(`${code}\n\nAfter`, { blocks: 1 })).toEqual({ markdown: code, more: true });
    expect(feedExcerpt(code, { chars: 20 }).markdown).toBe("```js\nconst a = 1;\n```");
  });

  it("leaves out the app's own block lines (databases, dashboards…)", () => {
    expect(feedExcerpt("Intro\n\n<!-- leafdesk:linked-view abc -->\n\nOutro").markdown).toBe("Intro\n\nOutro");
    expect(feedExcerpt("<!-- leafdesk:dashboard d1 -->")).toEqual({ markdown: "", more: false });
  });
});

describe("feedPlainExcerpt", () => {
  it("reads links as their text, and leaves out images, app links and marks", () => {
    const body = "# Launch\n\n**Done** with [docs](https://example.com) and [page](/w/w1/p/p1)\n\n![shot](https://example.com/a.png)\n\n- `one`";
    expect(feedPlainExcerpt(body)).toBe("Launch\n\nDone with docs and\n\none");
  });

  it("ends with an ellipsis when the body goes on", () => {
    expect(feedPlainExcerpt("First\n\nSecond", 6)).toBe("First…");
    expect(feedPlainExcerpt("one two three four five six", 12)).toBe("one two…");
  });

  it("drops code fences but keeps their lines", () => {
    expect(feedPlainExcerpt("```js\nconst a = 1;\n```")).toBe("const a = 1;");
  });
});

describe("isReactionEmoji", () => {
  it("takes one emoji, with its modifiers", () => {
    expect(isReactionEmoji("👍")).toBe(true);
    expect(isReactionEmoji("👍🏽")).toBe(true);
    expect(isReactionEmoji("🧑‍💻")).toBe(true);
  });

  it("refuses text, spaces and anything too long", () => {
    expect(isReactionEmoji("ok")).toBe(false);
    expect(isReactionEmoji("👍 👍")).toBe(false);
    expect(isReactionEmoji("")).toBe(false);
    expect(isReactionEmoji("👍".repeat(20))).toBe(false);
    expect(isReactionEmoji(5)).toBe(false);
  });
});
