import { describe, expect, it } from "vitest";
import { codeLanguage, emoticonText, exportPath, isPageFile, orderPages, pageTitle, panelColor, spaceName } from "./confluence";

describe("Confluence export files", () => {
  it("knows page files from the index", () => {
    expect(isPageFile("DOCS/Getting-started_65537.html")).toBe(true);
    expect(isPageFile("DOCS/65537.html")).toBe(true);
    expect(isPageFile("DOCS/index.html")).toBe(false);
    expect(isPageFile("DOCS/attachments/1/2.png")).toBe(false);
  });

  it("resolves links inside the export", () => {
    expect(exportPath("DOCS/A_1.html", "B_2.html#section")).toBe("DOCS/B_2.html");
    expect(exportPath("DOCS/A_1.html", "attachments/1/My%20file.pdf")).toBe("DOCS/attachments/1/My file.pdf");
    expect(exportPath("DOCS/A_1.html", "../other/C.html")).toBe("other/C.html");
    expect(exportPath("A.html", "../../x.html")).toBeNull();
    expect(exportPath("DOCS/A_1.html", "https://example.com/x")).toBeNull();
    expect(exportPath("DOCS/A_1.html", "#top")).toBeNull();
    expect(exportPath("DOCS/A_1.html", "mailto:a@b.c")).toBeNull();
  });
});

describe("titles", () => {
  it("takes the part after the space's name", () => {
    expect(pageTitle(" Docs : Getting started ", null)).toBe("Getting started");
    expect(pageTitle(null, "Docs : Setup : Linux")).toBe("Setup : Linux");
    expect(pageTitle("", "Plain")).toBe("Plain");
    expect(pageTitle(null, null)).toBe("");
    expect(spaceName("Docs : Docs Home")).toBe("Docs");
    expect(spaceName("Docs")).toBe("Docs");
  });
});

describe("macros", () => {
  it("colors panels by kind", () => {
    expect(panelColor("confluence-information-macro confluence-information-macro-warning")).toBe("red");
    expect(panelColor("confluence-information-macro confluence-information-macro-information")).toBe("blue");
    expect(panelColor("confluence-information-macro-tip")).toBe("green");
    expect(panelColor("panel")).toBe("gray");
  });

  it("reads the code macro's language", () => {
    expect(codeLanguage("brush: java; gutter: false; theme: Confluence")).toBe("java");
    expect(codeLanguage("brush: js; gutter: true")).toBe("javascript");
    expect(codeLanguage("brush: text")).toBe("");
    expect(codeLanguage(null)).toBe("");
  });

  it("turns emoticons into emoji", () => {
    expect(emoticonText("🙂", "(smile)")).toBe("🙂");
    expect(emoticonText(":smile:", "(smile)")).toBe("🙂");
    expect(emoticonText(null, "(tick)")).toBe("✅");
    expect(emoticonText(null, "(unknown)")).toBe("");
  });
});

describe("orderPages", () => {
  it("follows the index, then places the pages it leaves out under their breadcrumb parent", () => {
    const pages = [
      { file: "a", parent: null },
      { file: "b", parent: "a" },
      { file: "c", parent: "b" },
      { file: "d", parent: "a" },
      { file: "e", parent: "missing" },
    ];
    const tree = [{ file: "a", children: [{ file: "d", children: [] }, { file: "x", children: [{ file: "b", children: [] }] }] }];
    expect(orderPages(pages, tree)).toEqual([
      { file: "a", parent: null },
      { file: "d", parent: "a" },
      { file: "b", parent: "a" },
      { file: "c", parent: "b" },
      { file: "e", parent: null },
    ]);
  });

  it("puts each page once, even when breadcrumbs go round", () => {
    const out = orderPages(
      [
        { file: "a", parent: "b" },
        { file: "b", parent: "a" },
      ],
      [],
    );
    expect(out.map((p) => p.file).sort()).toEqual(["a", "b"]);
    expect(out[0].parent).toBeNull();
  });
});
