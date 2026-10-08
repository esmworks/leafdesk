import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { remarkTextScripts } from "./remark-text-scripts";

const render = (markdown: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm, remarkTextScripts] }, markdown));

describe("remarkTextScripts", () => {
  it("shows <sup> and <sub> as superscript and subscript", () => {
    expect(render("E = mc<sup>2</sup> and H<sub>2</sub>O")).toBe("<p>E = mc<sup>2</sup> and H<sub>2</sub>O</p>");
  });

  it("keeps the Markdown inside them, and them inside emphasis, links and tables", () => {
    expect(render("**x<sup>*a*</sup>** [n<sub>1</sub>](https://example.com/)")).toBe(
      '<p><strong>x<sup><em>a</em></sup></strong> <a href="https://example.com/">n<sub>1</sub></a></p>',
    );
    expect(render("| a<sup>2</sup> |\n| --- |\n| b |")).toContain("<th>a<sup>2</sup></th>");
  });

  it("leaves other HTML, unclosed tags and code as text", () => {
    expect(render("<b>bold</b> x<sup>2 `<sub>1</sub>`")).toBe("<p>&lt;b&gt;bold&lt;/b&gt; x&lt;sup&gt;2 <code>&lt;sub&gt;1&lt;/sub&gt;</code></p>");
    expect(render('<sup onclick="x">1</sup>')).toBe("<p>&lt;sup onclick=&quot;x&quot;&gt;1&lt;/sup&gt;</p>");
  });

  it("pairs nested tags of the same kind", () => {
    expect(render("a<sup>b<sup>c</sup>d</sup>")).toBe("<p>a<sup>b<sup>c</sup>d</sup></p>");
  });
});
