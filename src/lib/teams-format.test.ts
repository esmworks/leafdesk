import { describe, expect, it } from "vitest";
import { escapeHtml } from "./telegram-format";
import { htmlToPlain, htmlToTeamsMarkdown, teamsToText } from "./teams-format";

describe("htmlToTeamsMarkdown", () => {
  it("turns the bot's marks into Markdown", () => {
    expect(htmlToTeamsMarkdown("<b>Bold</b>, <i>italic</i>, <s>gone</s> and <code>a &lt; b</code>")).toBe("**Bold**, _italic_, ~~gone~~ and `a < b`");
  });

  it("gives text back as characters, with the marks Markdown would read escaped", () => {
    expect(htmlToTeamsMarkdown(escapeHtml("2 * 3 = 6 & a_b [x] <tag>"))).toBe("2 \\* 3 = 6 & a\\_b \\[x\\] &lt;tag>");
    expect(htmlToTeamsMarkdown(escapeHtml("# not a heading\n> not a quote"))).toBe("\\# not a heading\n\\> not a quote");
  });

  it("writes links as [label](address) and drops addresses that aren't the web's", () => {
    expect(htmlToTeamsMarkdown('<a href="https://leaf.test/w/1/p/2?a=1&amp;b=2">Tyre [vendors]</a>')).toBe("[Tyre \\[vendors\\]](https://leaf.test/w/1/p/2?a=1&b=2)");
    expect(htmlToTeamsMarkdown('<a href="https://leaf.test/a(b) c">x</a>')).toBe("[x](https://leaf.test/a%28b%29%20c)");
    expect(htmlToTeamsMarkdown('<a href="javascript:alert(1)">x</a>')).toBe("x");
  });

  it("puts marks inside the spaces around them", () => {
    expect(htmlToTeamsMarkdown("<b> spaced </b>")).toBe(" **spaced** ");
    expect(htmlToTeamsMarkdown("<b></b>x")).toBe("x");
  });

  it("quotes each line of a blockquote, with its marks", () => {
    expect(htmlToTeamsMarkdown("<blockquote>one <b>two</b>\nthree</blockquote>")).toBe("> one **two**\n> three");
  });

  it("writes preformatted text as a block, without marks inside", () => {
    expect(htmlToTeamsMarkdown('<pre><code class="language-ts">const a = 1 &lt; 2;\n**x**</code></pre>')).toBe("```\nconst a = 1 < 2;\n**x**\n```");
  });

  it("shows a spoiler as a block, and leaves it out of a preview", () => {
    const html = "<b>Call</b>\n<tg-spoiler>secret=1</tg-spoiler>";
    expect(htmlToTeamsMarkdown(html)).toBe("**Call**\n```\nsecret=1\n```");
    expect(htmlToTeamsMarkdown(html, { hideSpoilers: true })).toBe("**Call**\n…");
    expect(htmlToPlain(html, { hideSpoilers: true })).toBe("Call\n…");
    expect(htmlToPlain("a &amp; <b>b</b>")).toBe("a & b");
  });
});

describe("teamsToText", () => {
  it("drops the bot's mention and tags, and reads entities", () => {
    expect(teamsToText("<at>Leafdesk</at> /help")).toBe("/help");
    expect(teamsToText("a&nbsp;&amp; b<br>c")).toBe("a & b\nc");
    expect(teamsToText("plain < text")).toBe("plain < text");
  });
});
