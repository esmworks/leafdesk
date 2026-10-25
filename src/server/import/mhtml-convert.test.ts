import { describe, expect, it } from "vitest";
import { readMhtml } from "@/lib/import/mhtml";
import { mhtml, oneNoteFile, oneNoteHtml, oneNotePage, PNG_BASE64 } from "@/lib/import/mhtml-fixtures";
import type { PageBlock } from "../blocknote";
import { imageSources } from "./docx-convert";
import { MHTML_IMAGE_TOKEN, mhtmlDocument } from "./mhtml-convert";

type Inline = { type: string; text?: string; href?: string; styles?: Record<string, boolean>; content?: Inline[] };
const text = (block: PageBlock) => (Array.isArray(block.content) ? (block.content as Inline[]) : []).map((i) => i.text ?? (i.content ?? []).map((c) => c.text).join("")).join("");
const shape = (blocks: PageBlock[]): unknown[] =>
  blocks.map((b) => {
    const level = (b.props as { level?: number }).level;
    const head = b.type === "image" ? `image: ${(b.props as { url?: string }).url}` : `${b.type}${level ? level : ""}: ${text(b)}`;
    return b.children?.length ? [head, shape(b.children)] : head;
  });
const read = (name: string, data: Uint8Array) => mhtmlDocument(name, readMhtml(name, data));

describe("a OneNote page", () => {
  it("takes the title from the page, keeps the date and time as a line, and reads its outlines", async () => {
    const html = oneNoteHtml([
      oneNotePage({
        title: "Trip plan",
        outlines: [
          "<p style='margin:0in'>Book the <span style='font-weight:bold'>train</span>, see <a href=\"https://example.com/rail\">times</a> and <a href=\"onenote:#Packing&section-id={1}\">packing</a></p>",
          "<ul type=disc style='direction:ltr'><li style='margin-top:0;margin-bottom:0'><span>Passport</span></li><li><span>Charger</span></li></ul>",
          "<p><img src=\"Notes_files/image001.png\" width=320 height=200 alt=\"Map\"> the route</p>",
          "<p><img src=\"Notes_files/image002.png\" width=16 height=16>Call the hotel</p>",
          "<table border=1 cellpadding=0 cellspacing=0><tr><td><p>Day</p></td><td><p>City</p></td></tr></table>",
        ],
      }),
    ]);
    const document = await read("Trip plan.mht", oneNoteFile(html, { "image001.png": PNG_BASE64, "image002.png": PNG_BASE64 }));
    expect(document.oneNote).toBe(true);
    expect(document.section).toBeNull();
    expect(document.pages).toHaveLength(1);
    const [page] = document.pages;
    expect(page.title).toBe("Trip plan");
    expect(shape(page.blocks)).toEqual([
      "paragraph: Thursday, October 1, 2026 9:30 AM",
      "paragraph: Book the train, see times and packing",
      "bulletListItem: Passport",
      "bulletListItem: Charger",
      "paragraph:  the route",
      `image: ${MHTML_IMAGE_TOKEN}1`,
      "paragraph: Call the hotel",
      "table: ",
    ]);
    const inline = page.blocks[1].content as Inline[];
    expect(inline.find((i) => i.text === "train")?.styles).toEqual({ bold: true });
    // Web links stay; OneNote's links between its own pages can't lead anywhere here.
    expect(inline.filter((i) => i.type === "link").map((i) => i.href)).toEqual(["https://example.com/rail"]);
    // The tag icon (16×16) is left out; the picture points at its part.
    expect(document.images.map((i) => [i.token, i.name, i.type, i.part?.location?.endsWith("Notes_files/image001.png")])).toEqual([
      [`${MHTML_IMAGE_TOKEN}1`, "image001.png", "image/png", true],
    ]);
    // The "Created with OneNote." line is gone.
    expect(JSON.stringify(page.blocks)).not.toContain("Created with OneNote");
  });

  it("splits a section into its pages, named after the file", async () => {
    const html = oneNoteHtml([
      oneNotePage({ title: "Monday", outlines: ["<p>First page</p><img src=\"Notes_files/image001.png\">"] }),
      oneNotePage({ title: "", date: "Friday, October 2, 2026", time: "10:00 AM", outlines: ["<h1>Not a title</h1><p>Second page</p>"] }),
      oneNotePage({ title: "Wednesday", outlines: ["<p>Third page</p><img src=\"Notes_files/image001.png\">"] }),
    ]);
    const document = await read("Meeting notes.mhtml", oneNoteFile(html, { "image001.png": PNG_BASE64 }));
    expect(document.section).toBe("Meeting notes");
    expect(document.pages.map((p) => [p.title, shape(p.blocks)])).toEqual([
      ["Monday", ["paragraph: Thursday, October 1, 2026 9:30 AM", "paragraph: First page", `image: ${MHTML_IMAGE_TOKEN}1`]],
      [null, ["paragraph: Friday, October 2, 2026 10:00 AM", "heading1: Not a title", "paragraph: Second page"]],
      ["Wednesday", ["paragraph: Thursday, October 1, 2026 9:30 AM", "paragraph: Third page", `image: ${MHTML_IMAGE_TOKEN}1`]],
    ]);
    // One picture shown on two pages is one picture.
    expect(document.images).toHaveLength(1);
  });

  it("reads a OneNote file whose blocks don't have a page's shape as one page", async () => {
    const html = oneNoteHtml(["<div><p>Loose text</p><p>More</p><p>And more</p></div>"], { title: "Section" });
    const document = await read("Odd.mht", oneNoteFile(html));
    expect(document.section).toBeNull();
    expect(document.pages.map((p) => [p.title, shape(p.blocks)])).toEqual([["Section", ["paragraph: Loose text", "paragraph: More", "paragraph: And more"]]]);
  });
});

describe("other single-file web pages", () => {
  it("are one page, titled by a heading at the top, else <title>, with scripts, frames and outside pictures handled", async () => {
    const page = (body: string, title = "Saved page") =>
      mhtml(
        [
          {
            type: "text/html",
            charset: "utf-8",
            location: "https://example.com/blog/post.html",
            body: `<html><head><title>${title}</title><script>alert(1)</script></head><body>${body}</body></html>`,
          },
          { type: "image/png", location: "https://example.com/blog/a.png", encoding: "base64", body: PNG_BASE64 },
          { type: "image/svg+xml", location: "https://example.com/logo.svg", body: "<svg/>" },
          { type: "application/octet-stream", id: "pic@x", encoding: "base64", body: PNG_BASE64 },
        ],
        { boundary: "----MultipartBoundary--abc----" },
      );
    const saved = await read(
      "post.mhtml",
      page(
        [
          "<p>Intro <a href=\"/about\">about</a> <a href=\"javascript:alert(1)\">bad</a></p>",
          "<iframe src=\"https://evil.example\"></iframe><script>alert(2)</script>",
          "<img src=\"a.png\"><img src=\"../logo.svg\"><img src=\"https://cdn.example/remote.png\"><img src=\"cid:pic@x\"><img src=\"data:image/png;base64,AAAA\">",
          "<form><input value=x></form><p onclick=\"x()\">End</p>",
        ].join(""),
      ),
    );
    expect(saved.oneNote).toBe(false);
    expect(saved.pages).toHaveLength(1);
    expect(saved.pages[0].title).toBe("Saved page");
    expect(shape(saved.pages[0].blocks)).toEqual([
      "paragraph: Intro about bad",
      ...[1, 2, 3, 4].map((n) => `image: ${MHTML_IMAGE_TOKEN}${n}`),
      "paragraph: End",
    ]);
    const links = (saved.pages[0].blocks[0].content as Inline[]).filter((i) => i.type === "link").map((i) => i.href);
    expect(links).toEqual(["https://example.com/about"]);
    expect(saved.images.map((i) => [i.name, i.type, i.part ? "part" : "none"])).toEqual([
      ["a.png", "image/png", "part"],
      ["logo.svg", "image/svg+xml", "part"],
      ["remote.png", "", "none"],
      ["image-4.png", "image/png", "part"],
    ]);
    expect(imageSources(saved.pages[0].blocks)).toHaveLength(4);
    expect(JSON.stringify(saved.pages)).not.toMatch(/alert|evil/);

    const headed = await read("post.mhtml", page("<h1>The post</h1><p>Text</p>"));
    expect([headed.pages[0].title, shape(headed.pages[0].blocks)]).toEqual(["The post", ["paragraph: Text"]]);
    const untitled = await read("post.mhtml", page("<p>Text</p>", ""));
    expect(untitled.pages[0].title).toBeNull();
  });

  it("refuses HTML too large for one page", async () => {
    const big = `<p>${"word ".repeat(2_200_000)}</p>`;
    await expect(read("big.mht", mhtml([{ type: "text/html", encoding: "8bit", body: big }]))).rejects.toMatchObject({ code: "docxTooComplex" });
  });
});
