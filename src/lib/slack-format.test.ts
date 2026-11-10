import { describe, expect, it } from "vitest";
import { htmlToMrkdwn, mrkdwnToText, splitMrkdwn } from "./slack-format";
import { escapeHtml, markdownToTelegramBlocks } from "./telegram-format";

describe("htmlToMrkdwn", () => {
  it("turns the bot's marks into Slack's", () => {
    expect(htmlToMrkdwn("<b>Bold</b>, <i>italic</i>, <s>gone</s> and <code>a &lt; b</code>")).toBe("*Bold*, _italic_, ~gone~ and `a &lt; b`");
  });

  it("keeps escaped text escaped, as Slack wants it", () => {
    expect(htmlToMrkdwn(escapeHtml("Tom & Jerry <tag>"))).toBe("Tom &amp; Jerry &lt;tag&gt;");
  });

  it("writes links as <url|label>, and drops addresses that aren't the web's", () => {
    expect(htmlToMrkdwn('<a href="https://leaf.test/w/1/p/2?a=1&amp;b=2">Tyre | vendors</a>')).toBe("<https://leaf.test/w/1/p/2?a=1&amp;b=2|Tyre ¦ vendors>");
    expect(htmlToMrkdwn('<a href="javascript:alert(1)">x</a>')).toBe("x");
  });

  it("puts marks inside the spaces around them", () => {
    expect(htmlToMrkdwn("<b> spaced </b>")).toBe(" *spaced* ");
    expect(htmlToMrkdwn("<b></b>x")).toBe("x");
  });

  it("quotes each line of a blockquote, with its marks", () => {
    expect(htmlToMrkdwn("<blockquote>one <b>two</b>\nthree</blockquote>")).toBe("> one *two*\n> three");
  });

  it("writes preformatted text as a block, without marks inside", () => {
    expect(htmlToMrkdwn('<pre><code class="language-ts">const a = 1 &lt; 2;\n**x**</code></pre>')).toBe("```\nconst a = 1 &lt; 2;\n**x**\n```");
  });

  it("shows a spoiler in the message and leaves it out of what notifications show", () => {
    const html = "<b>Filer asks</b>\n<tg-spoiler>{&quot;secret&quot;: 1}</tg-spoiler>";
    expect(htmlToMrkdwn(html)).toBe('*Filer asks*\n```\n{&quot;secret&quot;: 1}\n```');
    expect(htmlToMrkdwn(html, { hideSpoilers: true })).toBe("*Filer asks*\n…");
  });

  it("drops tags it doesn't know and stray closings, keeping their text", () => {
    expect(htmlToMrkdwn("<u>under</u> </b>rest")).toBe("under rest");
  });

  it("reads what the answer formatter writes", () => {
    const blocks = markdownToTelegramBlocks("# Title\n\nSee **Tyre vendors** [1].\n\n- one\n- two\n\n> quoted", (n) => (n === 1 ? "https://leaf.test/p" : null));
    expect(blocks.map((b) => htmlToMrkdwn(b))).toEqual(["*Title*", "See *Tyre vendors* <https://leaf.test/p|[1]>.", "• one\n• two", "> quoted"]);
  });
});

describe("splitMrkdwn", () => {
  it("keeps short text whole and cuts long text at line breaks", () => {
    expect(splitMrkdwn("short", 10)).toEqual(["short"]);
    expect(splitMrkdwn("aaaa\nbbbb\ncccc", 10)).toEqual(["aaaa\nbbbb", "cccc"]);
  });
});

describe("mrkdwnToText", () => {
  it("reads links, mentions and escapes as plain text", () => {
    expect(mrkdwnToText("See <https://example.com|the site> and <https://a.test>, ask <@U123>, in <#C1|general> &amp; a &lt; b")).toBe(
      "See the site and https://a.test, ask @U123, in #general & a < b",
    );
    expect(mrkdwnToText("<mailto:a@b.test|a@b.test> <!here>")).toBe("a@b.test @here");
  });
});
