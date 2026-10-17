import { describe, expect, it } from "vitest";
import { layoutExport, relativeLink, rewriteLinks, safeFileName, safeName, type ExportNode } from "./export-layout";

const node = (id: string, parentId: string | null, title: string, extra: Partial<ExportNode> = {}): ExportNode => ({
  id,
  parentId,
  kind: "page",
  title,
  isTemplate: false,
  ...extra,
});

describe("safeName", () => {
  it("keeps ordinary titles, Turkish letters included", () => {
    expect(safeName("Toplantı notları — Eylül")).toBe("Toplantı notları — Eylül");
  });

  it("replaces separators and characters file systems refuse", () => {
    expect(safeName('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(safeName("tab\there\nnewline")).toBe("tab here newline");
  });

  it("drops leading and trailing dots, and falls back when nothing is left", () => {
    expect(safeName("../../etc/passwd")).toBe("etc passwd");
    expect(safeName("notes...")).toBe("notes");
    expect(safeName("   ")).toBe("Untitled");
    expect(safeName("...", "Adsız")).toBe("Adsız");
  });

  it("avoids Windows device names", () => {
    expect(safeName("CON")).toBe("CON_");
    expect(safeName("lpt1.txt")).toBe("lpt1.txt_");
    expect(safeName("Console")).toBe("Console");
  });

  it("cuts long titles without splitting characters", () => {
    const long = "😀".repeat(100);
    expect(Array.from(safeName(long))).toHaveLength(80);
  });
});

describe("safeFileName", () => {
  it("keeps the extension of long names", () => {
    const name = safeFileName(`${"x".repeat(200)}.png`);
    expect(name.endsWith(".png")).toBe(true);
    expect(name.length).toBe(84);
  });

  it("makes names safe", () => {
    expect(safeFileName("a:b.pdf")).toBe("a b.pdf");
    expect(safeFileName(".hidden")).toBe("hidden");
    expect(safeFileName("")).toBe("file");
  });
});

describe("layoutExport", () => {
  it("mirrors the page tree, with a folder beside each page that has subpages", () => {
    const { paths } = layoutExport([node("a", null, "Project"), node("b", "a", "Plan"), node("c", "b", "Details")]);
    expect(paths.get("a")).toBe("Project.md");
    expect(paths.get("b")).toBe("Project/Plan.md");
    expect(paths.get("c")).toBe("Project/Plan/Details.md");
  });

  it("writes databases as CSV with their rows in a folder of the same name", () => {
    const { paths } = layoutExport([
      node("d", null, "Tasks", { kind: "database" }),
      node("r1", "d", "Write docs"),
      node("r2", "d", "Ship"),
      node("s", "r1", "Draft"),
    ]);
    expect(paths.get("d")).toBe("Tasks.csv");
    expect(paths.get("r1")).toBe("Tasks/Write docs.md");
    expect(paths.get("s")).toBe("Tasks/Write docs/Draft.md");
  });

  it("makes names unique within a folder, ignoring case, in the order given", () => {
    const { paths } = layoutExport([
      node("a", null, "Notes"),
      node("b", null, "notes"),
      node("c", null, "Notes", { kind: "database" }),
      node("d", null, ""),
      node("e", null, "  "),
      node("f", "a", "Notes"),
    ]);
    expect(paths.get("a")).toBe("Notes.md");
    expect(paths.get("b")).toBe("notes (2).md");
    expect(paths.get("c")).toBe("Notes (3).csv");
    expect(paths.get("d")).toBe("Untitled.md");
    expect(paths.get("e")).toBe("Untitled (2).md");
    // Another folder: no clash.
    expect(paths.get("f")).toBe("Notes/Notes.md");
  });

  it("puts pages whose parent isn't exported at the top, like the sidebar", () => {
    const { paths } = layoutExport([node("a", null, "Root"), node("x", "hidden", "Shared with me")]);
    expect(paths.get("x")).toBe("Shared with me.md");
  });

  it("keeps workspace and row templates apart", () => {
    const { paths } = layoutExport([
      node("t", null, "Meeting", { isTemplate: true }),
      node("ts", "t", "Agenda"),
      node("p", null, "Templates"),
      node("d", null, "Tasks", { kind: "database" }),
      node("r", "d", "Row"),
      node("rt", "d", "Bug report", { isTemplate: true }),
    ]);
    expect(paths.get("t")).toBe("Templates/Meeting.md");
    expect(paths.get("ts")).toBe("Templates/Meeting/Agenda.md");
    // A page named like the folder steps aside.
    expect(paths.get("p")).toBe("Templates (2).md");
    expect(paths.get("r")).toBe("Tasks/Row.md");
    expect(paths.get("rt")).toBe("Tasks/Templates/Bug report.md");
  });

  it("puts files in files/, with unique safe names", () => {
    const { paths, files } = layoutExport(
      [node("a", null, "files")],
      [
        { id: "f1", name: "photo.png" },
        { id: "f2", name: "Photo.png" },
        { id: "f3", name: "a/b.pdf" },
        { id: "f4", name: "README" },
      ],
    );
    expect(paths.get("a")).toBe("files (2).md");
    expect(files.get("f1")).toBe("files/photo.png");
    expect(files.get("f2")).toBe("files/Photo (2).png");
    expect(files.get("f3")).toBe("files/a b.pdf");
    expect(files.get("f4")).toBe("files/README");
  });
});

describe("relativeLink", () => {
  it("links between folders", () => {
    expect(relativeLink("A.md", "A/B.md")).toBe("A/B.md");
    expect(relativeLink("A/B/C.md", "A/D.md")).toBe("../D.md");
    expect(relativeLink("A/B/C.md", "files/x.png")).toBe("../../files/x.png");
    expect(relativeLink("A/B.md", "A/C.csv")).toBe("C.csv");
  });

  it("encodes what would break a Markdown link, and nothing else", () => {
    expect(relativeLink("A.md", "My notes (1)/Çizim #2.md")).toBe("My%20notes%20%281%29/Çizim%20%232.md");
  });
});

describe("rewriteLinks", () => {
  const ID = "abcdefghijklmnopqrstuvwx";
  const OTHER = "zzzzzzzzzzzzzzzzzzzzzzzz";
  const targets = {
    page: (id: string) => ({ p1: "Project/Plan.md", db: "Project/Tasks.csv" })[id],
    file: (id: string) => (id === ID ? "files/photo 1.png" : undefined),
    appUrl: "https://notes.example.com/",
  };

  it("points links to exported pages and databases at their files", () => {
    const md = "See [Plan](/w/ws1/p/p1) and [Tasks](https://notes.example.com/w/ws1/p/db).";
    expect(rewriteLinks(md, "Project.md", targets)).toBe("See [Plan](Project/Plan.md) and [Tasks](Project/Tasks.csv).");
  });

  it("points links to pages left out at the app", () => {
    expect(rewriteLinks("[No access](/w/ws1/p/secret)", "A.md", targets)).toBe("[No access](https://notes.example.com/w/ws1/p/secret)");
    expect(rewriteLinks("[x](https://elsewhere.test/w/a/p/b)", "A.md", targets)).toBe("[x](https://elsewhere.test/w/a/p/b)");
  });

  it("points links to a block at the page's file, or at the block in the app", () => {
    expect(rewriteLinks("[Plan](/w/ws1/p/p1#block-b1)", "Project.md", targets)).toBe("[Plan](Project/Plan.md)");
    expect(rewriteLinks("[x](/w/ws1/p/secret#block-b1)", "A.md", targets)).toBe("[x](https://notes.example.com/w/ws1/p/secret#block-b1)");
  });

  it("points uploaded files at their copy in the archive", () => {
    const md = `![photo](/api/files/${ID})\n[doc.pdf](https://notes.example.com/api/files/${ID}?view=pdf)`;
    expect(rewriteLinks(md, "Project/Plan.md", targets)).toBe("![photo](../files/photo%201.png)\n[doc.pdf](../files/photo%201.png)");
  });

  it("points files left out at the app", () => {
    expect(rewriteLinks(`![x](/api/files/${OTHER})`, "A.md", targets)).toBe(`![x](https://notes.example.com/api/files/${OTHER})`);
  });

  it("leaves fenced code alone", () => {
    const md = "```\n[Plan](/w/ws1/p/p1)\n```\n[Plan](/w/ws1/p/p1)";
    expect(rewriteLinks(md, "A.md", targets)).toBe("```\n[Plan](/w/ws1/p/p1)\n```\n[Plan](Project/Plan.md)");
  });
});
