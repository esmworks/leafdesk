import { describe, expect, it } from "vitest";
import {
  bookmarkWidth,
  displayHost,
  EMBED_FRAME_ORIGINS,
  embedFor,
  isLoneUrl,
  markdownLinkDestination,
  markdownLinkText,
  parseWebUrl,
  restoreBookmarks,
} from "./web-blocks";

const src = (url: string) => embedFor(url)?.src ?? null;

describe("parseWebUrl", () => {
  it("accepts http(s) URLs and bare domains", () => {
    expect(parseWebUrl(" https://example.com/a?b=1 ")?.href).toBe("https://example.com/a?b=1");
    expect(parseWebUrl("example.com/path")?.href).toBe("https://example.com/path");
    expect(parseWebUrl("www.example.co.uk")?.href).toBe("https://www.example.co.uk/");
  });

  it("refuses other schemes, credentials, spaces and junk", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://x.com", "https://user:pw@example.com", "https://a b.com", "foo", "", null, 42, `https://x.com/${"a".repeat(3000)}`]) {
      expect(parseWebUrl(value), String(value)).toBeNull();
    }
  });

  it("tells a lone URL from text", () => {
    expect(isLoneUrl("https://example.com/x")).toBe(true);
    expect(isLoneUrl("  http://example.com  ")).toBe(true);
    expect(isLoneUrl("see https://example.com")).toBe(false);
    expect(isLoneUrl("example.com")).toBe(false);
    expect(isLoneUrl("javascript:alert(1)")).toBe(false);
  });

  it("shows the host without www", () => {
    expect(displayHost("https://www.example.com/a")).toBe("example.com");
  });
});

describe("embedFor", () => {
  it("turns YouTube links into youtube-nocookie embeds", () => {
    const embed = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
    expect(src("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(embed);
    expect(src("https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2")).toBe(embed);
    expect(src("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(embed);
    expect(src("https://youtu.be/dQw4w9WgXcQ?t=90")).toBe(`${embed}?start=90`);
    expect(src("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s")).toBe(`${embed}?start=90`);
    expect(src("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(embed);
    expect(src("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(embed);
    expect(src("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf")).toBe(
      "https://www.youtube-nocookie.com/embed/videoseries?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
    );
    expect(embedFor("https://youtu.be/dQw4w9WgXcQ")).toMatchObject({ provider: "youtube", height: null });
  });

  it("refuses YouTube links that aren't a video or playlist", () => {
    for (const url of [
      "https://www.youtube.com/",
      "https://www.youtube.com/@channel",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ%22onload",
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ/extra",
    ]) {
      expect(embedFor(url), url).toBeNull();
    }
  });

  it("converts the other providers", () => {
    expect(src("https://vimeo.com/76979871")).toBe("https://player.vimeo.com/video/76979871?dnt=1");
    expect(src("https://vimeo.com/76979871/abcdef1234")).toBe("https://player.vimeo.com/video/76979871?dnt=1&h=abcdef1234");
    expect(src("https://vimeo.com/channels/staffpicks/76979871")).toBe("https://player.vimeo.com/video/76979871?dnt=1");
    expect(src("https://player.vimeo.com/video/76979871")).toBe("https://player.vimeo.com/video/76979871?dnt=1");
    expect(src("https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184")).toBe(
      "https://www.loom.com/embed/0281766fa2d04bb788eaf19e65135184",
    );
    expect(src("https://www.figma.com/design/AbCdEf1234567890/My-File?node-id=1-2&t=xyz")).toBe(
      `https://www.figma.com/embed?embed_host=leafdesk&url=${encodeURIComponent("https://www.figma.com/design/AbCdEf1234567890?node-id=1-2")}`,
    );
    expect(src("https://docs.google.com/document/d/e/2PACX-1vQabcdefghijk/pub")).toBe(
      "https://docs.google.com/document/d/e/2PACX-1vQabcdefghijk/pub?embedded=true",
    );
    expect(src("https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijk/pubhtml?gid=0&single=true")).toBe(
      "https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijk/pubhtml?widget=true&headers=false&gid=0",
    );
    expect(src("https://docs.google.com/presentation/d/e/2PACX-1vQabcdefghijk/pub?start=false")).toBe(
      "https://docs.google.com/presentation/d/e/2PACX-1vQabcdefghijk/embed?start=false&loop=false",
    );
    expect(src("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMn/embed")).toBe(
      "https://docs.google.com/presentation/d/1AbCdEfGhIjKlMn/embed?start=false&loop=false",
    );
    expect(src("https://codepen.io/someone/pen/abcXYZ")).toBe("https://codepen.io/someone/embed/abcXYZ?default-tab=result");
    expect(src("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x")).toBe(
      "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC",
    );
    expect(embedFor("https://open.spotify.com/intl-tr/album/4uLU6hMCjMI75M1A2tKUQC")).toMatchObject({ height: 352 });
    expect(src("https://www.google.com/maps/place/Galata+Tower/@41.0256,28.9741,17z/data=!3m1")).toBe(
      "https://www.google.com/maps?q=Galata+Tower&output=embed&z=17",
    );
    expect(src("https://www.google.com/maps/@41.0256,28.9741,15z")).toBe("https://www.google.com/maps?q=41.0256%2C28.9741&output=embed&z=15");
    expect(src("https://maps.google.com/?q=Ankara")).toBe("https://www.google.com/maps?q=Ankara&output=embed");
    expect(src("https://www.google.com/maps/embed?pb=!1m18!1m12")).toBe("https://www.google.com/maps/embed?pb=%211m18%211m12");
  });

  it("refuses private Google Docs, unknown sites and look-alikes", () => {
    for (const url of [
      "https://docs.google.com/document/d/1AbCdEfGhIjKlMn/edit",
      "https://docs.google.com/forms/d/e/1FAIpQL/viewform",
      "https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view",
      "https://www.google.com/search?q=maps",
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "https://vimeo.com/about",
      "https://codepen.io/someone",
      "https://open.spotify.com/user/abc",
      "https://www.figma.com/community/file/123",
      "http://loom.com.attacker.example/share/0281766fa2d04bb788eaf19e65135184",
      "javascript:alert(1)",
    ]) {
      expect(embedFor(url), url).toBeNull();
    }
  });

  it("only ever points at allowlisted origins", () => {
    const samples = [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://vimeo.com/1",
      "https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184",
      "https://www.figma.com/file/AbCdEf1234567890",
      "https://docs.google.com/document/d/e/2PACX-1vQabcdefghijk/pub",
      "https://codepen.io/a/pen/abc",
      "https://open.spotify.com/show/4uLU6hMCjMI75M1A2tKUQC",
      "https://maps.google.com/?q=x",
    ];
    for (const url of samples) {
      const embed = embedFor(url);
      expect(embed, url).not.toBeNull();
      expect(EMBED_FRAME_ORIGINS).toContain(new URL(embed!.src).origin);
    }
  });
});

describe("Markdown helpers", () => {
  it("escapes link text and destinations", () => {
    expect(markdownLinkText("A [b] *c* $5 <d>\nnext")).toBe("A \\[b\\] \\*c\\* \\$5 \\<d\\> next");
    expect(markdownLinkDestination("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("<https://en.wikipedia.org/wiki/Foo_(bar)>");
    expect(markdownLinkDestination("https://example.com/a")).toBe("https://example.com/a");
  });

  const link = (href: string, text = href) => ({
    type: "paragraph",
    content: [{ type: "link", href, content: [{ type: "text", text, styles: {} }] }],
    children: [],
  });

  it("turns link lines back into the page's bookmarks, each once", () => {
    const existing = [
      { type: "bookmark", props: { url: "https://example.com/a", title: "A", image: "https://example.com/a.png" }, children: [] },
      { type: "paragraph", content: [], children: [] },
    ];
    const blocks = restoreBookmarks([link("https://example.com/a", "A"), link("https://example.com/a"), link("https://other.example/")], existing);
    expect(blocks[0]).toMatchObject({ type: "bookmark", props: { url: "https://example.com/a", title: "A", image: "https://example.com/a.png" } });
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[2].type).toBe("paragraph");
  });

  it("leaves links alone on pages without bookmarks", () => {
    const blocks = [link("https://example.com/a")];
    expect(restoreBookmarks(blocks, [])).toBe(blocks);
  });
});

describe("bookmarkWidth", () => {
  it("is a whole percent of the column, no narrower than the least", () => {
    expect(bookmarkWidth(55)).toBe(55);
    expect(bookmarkWidth(42.6)).toBe(43);
    expect(bookmarkWidth("70")).toBe(70);
    expect(bookmarkWidth(5)).toBe(30);
  });

  it("is the whole width for 0, 100 and more, and anything else", () => {
    for (const value of [0, 100, 140, -10, "", "wide", null, undefined, Number.NaN, {}]) expect(bookmarkWidth(value)).toBeNull();
  });
});
