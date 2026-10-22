import { describe, expect, it } from "vitest";
import { escapeHtml, htmlToText, markdownToTelegramBlocks, MESSAGE_LIMIT, packMessages, preview, splitText } from "./telegram-format";

const blocks = (markdown: string, cite?: (n: number) => string | null) => markdownToTelegramBlocks(markdown, cite);

describe("markdownToTelegramBlocks", () => {
  it("escapes what Telegram would read as markup", () => {
    expect(blocks("a < b & c > d")).toEqual(["a &lt; b &amp; c &gt; d"]);
    expect(blocks("<b>not bold</b>")).toEqual(["&lt;b&gt;not bold&lt;/b&gt;"]);
  });

  it("turns emphasis, code and links into Telegram's tags", () => {
    expect(blocks("**bold**, *italic*, _also_, ~~gone~~ and `x < 1`")).toEqual([
      "<b>bold</b>, <i>italic</i>, <i>also</i>, <s>gone</s> and <code>x &lt; 1</code>",
    ]);
    expect(blocks("See [the plan](https://example.com/a_b_c?x=1&y=2).")).toEqual([
      'See <a href="https://example.com/a_b_c?x=1&amp;y=2">the plan</a>.',
    ]);
    // Only web addresses become links.
    expect(blocks("[click](javascript:alert(1))")).toEqual(["click"]);
  });

  it("leaves underscores and stars inside words alone", () => {
    expect(blocks("snake_case_name and 2*3*4")).toEqual(["snake_case_name and 2*3*4"]);
  });

  it("links citations to their pages, and keeps unknown ones as text", () => {
    const cite = (n: number) => (n === 1 ? "https://leaf.test/w/1/p/a" : null);
    expect(blocks("It ships Friday [1][2].", cite)).toEqual(['It ships Friday <a href="https://leaf.test/w/1/p/a">[1]</a>[2].']);
    expect(blocks("Both [1, 2].", cite)).toEqual(['Both <a href="https://leaf.test/w/1/p/a">[1]</a>[2].']);
  });

  it("shows headings bold, list markers as bullets and tasks as boxes", () => {
    expect(blocks("## Plan\n- one\n  * two\n- [ ] open\n- [x] done\n1. first")).toEqual([
      "<b>Plan</b>\n• one\n  • two\n☐ open\n☑ done\n1. first",
    ]);
  });

  it("keeps code blocks as they are written", () => {
    expect(blocks("Before\n\n```ts\nconst a = 1 < 2 && **b**;\n```\nAfter")).toEqual([
      "Before",
      '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; **b**;</code></pre>',
      "After",
    ]);
    // A block still open at the end runs to it.
    expect(blocks("```\nopen")).toEqual(["<pre><code>open</code></pre>"]);
  });

  it("shows tables as preformatted text without the alignment row", () => {
    expect(blocks("| Name | Due |\n| --- | :-: |\n| Plan | Fri |\nafter")).toEqual(["<pre>| Name | Due |\n| Plan | Fri |</pre>", "after"]);
  });

  it("quotes quotes, without a callout's marker", () => {
    expect(blocks("> [!NOTE]\n> Mind the **gap**")).toEqual(["<blockquote>Mind the <b>gap</b></blockquote>"]);
    expect(blocks("> one\n> two")).toEqual(["<blockquote>one\ntwo</blockquote>"]);
  });

  it("splits paragraphs at blank lines", () => {
    expect(blocks("one\ntwo\n\n\nthree")).toEqual(["one\ntwo", "three"]);
  });
});

describe("packMessages", () => {
  it("packs blocks into messages under the limit", () => {
    expect(packMessages(["a", "b"], 10)).toEqual(["a\n\nb"]);
    expect(packMessages(["aaaa", "bbbb", "cc"], 10)).toEqual(["aaaa\n\nbbbb", "cc"]);
  });

  it("sends a block too long for one message as plain text, split", () => {
    const long = `<pre>${"x".repeat(MESSAGE_LIMIT + 500)}</pre>`;
    const messages = packMessages(["before", long]);
    expect(messages[0]).toBe("before");
    expect(messages.slice(1).join("")).toBe("x".repeat(MESSAGE_LIMIT + 500));
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
  });
});

describe("text helpers", () => {
  it("splits at line breaks, then spaces, near the limit", () => {
    expect(splitText("aaaa\nbbbb", 6)).toEqual(["aaaa", "bbbb"]);
    expect(splitText("aaa bbb ccc", 8)).toEqual(["aaa bbb", "ccc"]);
    expect(splitText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("takes tags and entities out", () => {
    expect(htmlToText('<b>a</b> &lt;b&gt; <a href="x">c &amp; d</a>')).toBe("a <b> c & d");
    expect(htmlToText(escapeHtml('a "b" <c>'))).toBe('a "b" <c>');
  });

  it("previews text on one line", () => {
    expect(preview("one\n two   three", 20)).toBe("one two three");
    expect(preview("abcdefghij", 5)).toBe("abcd…");
  });
});
