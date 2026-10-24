import { describe, expect, it } from "vitest";
import { downloadName, downloadUrl, EXTERNAL_DOWNLOAD_ROUTE } from "./downloads";

const ID = "abcdefghijklmnopqrstuvwx";

describe("downloadUrl", () => {
  it("downloads an uploaded file from the file route", () => {
    expect(downloadUrl(`/api/files/${ID}`, { pageId: "p" })).toBe(`/api/files/${ID}?download=1`);
    expect(downloadUrl(`https://app.example/api/files/${ID}`, { pageId: "p" })).toBe(`/api/files/${ID}?download=1`);
  });

  it("downloads a file on the web through the server, with the page and name", () => {
    const url = new URL(downloadUrl("https://cdn.example/a b.png", { pageId: "p1", name: "Cat.png" })!, "http://x");
    expect(url.pathname).toBe(EXTERNAL_DOWNLOAD_ROUTE);
    expect(url.searchParams.get("url")).toBe("https://cdn.example/a%20b.png");
    expect(url.searchParams.get("pageId")).toBe("p1");
    expect(url.searchParams.get("name")).toBe("Cat.png");
  });

  it("has nothing to download for no address or another scheme", () => {
    expect(downloadUrl("", { pageId: "p" })).toBeNull();
    expect(downloadUrl(undefined, { pageId: "p" })).toBeNull();
    expect(downloadUrl("javascript:alert(1)", { pageId: "p" })).toBeNull();
    expect(downloadUrl("https://user:pw@host.example/x", { pageId: "p" })).toBeNull();
  });
});

describe("downloadName", () => {
  it("takes the name given, else the address's last part, else 'download'", () => {
    expect(downloadName(new URL("https://h.example/x/report%20(1).pdf"), null)).toBe("report (1).pdf");
    expect(downloadName(new URL("https://h.example/x/a.png"), " Mine.png ")).toBe("Mine.png");
    expect(downloadName(new URL("https://h.example/"), "")).toBe("download");
    expect(downloadName(new URL("https://h.example/..%2F..%2Fetc"), null)).toBe("_.._etc");
    expect(downloadName(new URL("https://h.example/a"), 'x"<>|.txt')).toBe("x_.txt");
  });
});
