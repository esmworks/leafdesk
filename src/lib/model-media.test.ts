import { describe, expect, it } from "vitest";
import { mediaAsLinks } from "./model-media";

const APP = "https://app.leafdesk.test";

const image = (url: string, props: Record<string, unknown> = {}) => ({ id: `img-${url}`, type: "image", props: { url, caption: "", name: "", ...props }, children: [] });
const linkOf = (block: { type: string; content?: unknown }) => (block.type === "paragraph" ? (block.content as { type: string; href: string; content: { text: string }[] }[])[0] : null);

describe("mediaAsLinks", () => {
  it("turns media that would load another site into links", () => {
    const blocks = [
      image("https://evil.example/p.png?d=secret", { name: "chart" }),
      { type: "video", props: { url: "https://evil.example/v.mp4", caption: "Demo" }, children: [] },
      { type: "audio", props: { url: "evil.example/a.mp3" }, children: [] },
      { type: "webEmbed", props: { url: "https://evil.example/frame" }, children: [] },
      { type: "bookmark", props: { url: "https://evil.example/", title: "Evil" }, children: [] },
      image("//evil.example/protocol-relative.png"),
    ];
    const out = mediaAsLinks(blocks, [], APP);
    expect(out.map((b) => b.type)).toEqual(Array(6).fill("paragraph"));
    expect(out.map(linkOf).map((l) => [l?.href, l?.content[0].text])).toEqual([
      ["https://evil.example/p.png?d=secret", "chart"],
      ["https://evil.example/v.mp4", "Demo"],
      ["https://evil.example/a.mp3", "https://evil.example/a.mp3"],
      ["https://evil.example/frame", "https://evil.example/frame"],
      ["https://evil.example/", "Evil"],
      ["https://evil.example/protocol-relative.png", "https://evil.example/protocol-relative.png"],
    ]);
    // The block keeps its id, so the write replaces it in place.
    expect(out[0]).toMatchObject({ id: "img-https://evil.example/p.png?d=secret", props: { textAlignment: "left" }, children: [] });
  });

  it("keeps this app's files, data, addresses no site serves and media the page already loaded", () => {
    const blocks = [
      image("/api/files/abc"),
      image(`${APP}/api/files/def`),
      image("data:image/png;base64,AAAA"),
      image("javascript:alert(1)"),
      image("https://cdn.example/logo.png"),
      image("https://cdn.example/icon.png"),
      { type: "bookmark", props: { url: "https://docs.example/", title: "Docs" }, children: [] },
      { type: "paragraph", content: [{ type: "text", text: "plain", styles: {} }], children: [] },
    ];
    const existing = [
      { type: "paragraph", children: [{ type: "image", props: { url: "https://cdn.example/logo.png" } }] },
      { type: "bookmark", props: { url: "https://docs.example/" } },
      { type: "image", props: { url: "cdn.example/icon.png" } },
    ];
    expect(mediaAsLinks(blocks, existing, APP)).toBe(blocks);
  });

  it("an address only linked on the page still becomes a link as media", () => {
    const existing = [{ type: "paragraph", content: [{ type: "link", href: "https://evil.example/p.png", content: [] }] }];
    expect(mediaAsLinks([image("https://evil.example/p.png")], existing, APP)[0].type).toBe("paragraph");
  });

  it("reaches nested blocks and keeps the media's own nested blocks under its link", () => {
    const nested = { type: "image", props: { url: "https://evil.example/n.png" }, children: [{ type: "paragraph", content: [], children: [] }] };
    const blocks = [{ type: "columnList", props: {}, children: [{ type: "column", props: {}, children: [nested] }] }];
    const out = mediaAsLinks(blocks, [], APP);
    const inner = out[0].children![0].children![0];
    expect(inner.type).toBe("paragraph");
    expect(inner.children).toEqual(nested.children);
    expect(blocks[0].children[0].children[0]).toBe(nested);
  });
});
