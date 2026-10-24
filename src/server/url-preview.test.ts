import { beforeEach, describe, expect, it, vi } from "vitest";

const row = { id: "row", parentId: "db", createdBy: "ada", properties: { link: "https://example.com/a", mail: "mailto:a@example.com", secret: "https://example.com/s" } as Record<string, unknown> };
const properties = [
  { id: "link", type: "url", options: { url: { preview: true } } },
  { id: "plain", type: "url", options: {} },
  { id: "mail", type: "url", options: { url: { preview: true } } },
  { id: "secret", type: "url", options: { url: { preview: true } } },
];

vi.mock("@/server/access", () => ({
  requirePageAccess: vi.fn(async (userId: string) => {
    if (userId === "outsider") throw new Error("no access");
    return row;
  }),
}));
vi.mock("@/server/databases", () => ({ getProperties: vi.fn(async () => properties) }));
vi.mock("@/server/link-preview", () => ({ fetchLinkPreview: vi.fn() }));
vi.mock("@/server/property-access", () => ({
  // "bob" may not see the "secret" property.
  propertyAccessFor: vi.fn(async (userId: string) => ({
    visible: <P extends { id: string }>(all: P[]) => all.filter((p) => userId !== "bob" || p.id !== "secret"),
    strip: <R extends { properties: Record<string, unknown> }>(rows: R[]) => rows,
  })),
}));

const { forgetUrlPreviews, urlPropertyPreview } = await import("./url-preview");

const page = (url: string) => ({ url, title: "Example", description: "About", image: "https://example.com/i.png", favicon: "https://example.com/favicon.ico", siteName: "Example" });

describe("URL property previews", () => {
  beforeEach(() => forgetUrlPreviews());

  it("preview the stored link of a property set to show one", async () => {
    const fetch = vi.fn(async (url: string) => page(url));
    expect(await urlPropertyPreview("ada", "row", "link", fetch)).toEqual({
      url: "https://example.com/a",
      title: "Example",
      siteName: "Example",
      image: "https://example.com/i.png",
      favicon: "https://example.com/favicon.ico",
    });
    expect(fetch).toHaveBeenCalledWith("https://example.com/a");
  });

  it("show nothing for properties without the option, other links, or properties the viewer can't see", async () => {
    const fetch = vi.fn(async (url: string) => page(url));
    expect(await urlPropertyPreview("ada", "row", "plain", fetch)).toBeNull();
    expect(await urlPropertyPreview("ada", "row", "mail", fetch)).toBeNull();
    expect(await urlPropertyPreview("ada", "row", "missing", fetch)).toBeNull();
    expect(await urlPropertyPreview("bob", "row", "secret", fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await expect(urlPropertyPreview("outsider", "row", "link", fetch)).rejects.toThrow("no access");
  });

  it("fetch each link once for everyone while it is kept, and failures again sooner", async () => {
    const fetch = vi.fn(async (url: string) => page(url));
    const now = Date.now();
    await urlPropertyPreview("ada", "row", "link", fetch, now);
    await urlPropertyPreview("bob", "row", "link", fetch, now + 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await urlPropertyPreview("ada", "row", "link", fetch, now + 25 * 60 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);

    forgetUrlPreviews();
    const failing = vi.fn(async () => {
      throw new Error("unreachable");
    });
    expect(await urlPropertyPreview("ada", "row", "link", failing, now)).toBeNull();
    expect(await urlPropertyPreview("ada", "row", "link", failing, now + 30 * 60_000)).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(await urlPropertyPreview("ada", "row", "link", failing, now + 2 * 60 * 60_000)).toBeNull();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("limit how many fetches one person makes", async () => {
    let n = 0;
    const fetch = vi.fn(async (url: string) => page(url));
    const now = Date.now() + 10 * 60 * 60_000;
    for (let i = 0; i < 40; i++) {
      row.properties.link = `https://example.com/${n++}`;
      await urlPropertyPreview("carol", "row", "link", fetch, now);
    }
    expect(fetch).toHaveBeenCalledTimes(30);
    row.properties.link = "https://example.com/a";
  });
});
