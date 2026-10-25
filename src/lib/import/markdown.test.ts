// The pure part of Markdown, CSV and ZIP imports: paths, titles, the page plan and links.
import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  importFileKind,
  isIgnoredPath,
  normalizePath,
  planImport,
  resolveLink,
  rewriteLinks,
  splitTitle,
  stripRowProperties,
} from "./markdown";

describe("paths", () => {
  it("normalizes paths and refuses ones climbing out", () => {
    expect(normalizePath("./a\\b/../c.md")).toBe("a/c.md");
    expect(normalizePath("/a//b.md")).toBe("a/b.md");
    expect(normalizePath("../etc/passwd")).toBeNull();
    expect(normalizePath("")).toBeNull();
  });

  it("ignores system files", () => {
    expect(isIgnoredPath("__MACOSX/a/._b.md")).toBe(true);
    expect(isIgnoredPath("a/.DS_Store")).toBe(true);
    expect(isIgnoredPath("a/b.md")).toBe(false);
  });

  it("tells files apart by extension", () => {
    expect(importFileKind("a/B.MD")).toBe("markdown");
    expect(importFileKind("a.markdown")).toBe("markdown");
    expect(importFileKind("t.csv")).toBe("csv");
    expect(importFileKind("x.zip")).toBe("zip");
    expect(importFileKind("i.png")).toBe("asset");
  });

  it("makes titles from names without Notion ids", () => {
    expect(cleanTitle("Docs/Project plan 0123456789abcdef0123456789abcdef.md")).toBe("Project plan");
    expect(cleanTitle("Tasks 0123456789abcdef0123456789abcdef_all.csv")).toBe("Tasks");
    expect(cleanTitle("notes")).toBe("notes");
  });
});

describe("splitTitle", () => {
  it("takes a first-line heading as the title and leaves it out of the body", () => {
    expect(splitTitle("# Plan\n\nBody text\n", "file")).toEqual({ title: "Plan", body: "Body text\n" });
  });

  it("prefers a front matter title and drops the front matter", () => {
    expect(splitTitle("---\ntitle: \"Real\"\ntags: [a]\n---\n# Other\nText", "file")).toEqual({ title: "Real", body: "# Other\nText" });
    expect(splitTitle("---\ntitle: Same\n---\n# Same\nText", "file")).toEqual({ title: "Same", body: "Text" });
  });

  it("falls back to the file name", () => {
    expect(splitTitle("Just text\n# Later heading", "file")).toEqual({ title: "file", body: "Just text\n# Later heading" });
    expect(splitTitle("## Subheading", "file").title).toBe("file");
  });
});

describe("planImport", () => {
  const plan = (paths: string[], options?: { topLevel?: boolean }) => {
    const { nodes, nodeOf, skipped } = planImport(paths, options);
    return {
      nodes: nodes.map(
        (n) =>
          `${n.template ? "template " : ""}${n.kind} ${n.key} <- ${n.parent ?? "root"}${n.source && n.source !== n.key ? ` (${n.source})` : ""}`,
      ),
      nodeOf,
      skipped,
    };
  };

  it("nests a folder's pages under the file of the same name", () => {
    expect(plan(["Project.md", "Project/Notes.md", "Project/img/a.png", "Other.md"]).nodes).toEqual([
      "page Other.md <- root",
      "page Project.md <- root",
      "page Project/Notes.md <- Project.md",
    ]);
  });

  it("turns folders without such a file into pages, with an index file as their body", () => {
    expect(plan(["Archive/index.md", "Archive/Old.md", "Deep/er/Leaf.md"]).nodes).toEqual([
      "page Archive/ <- root (Archive/index.md)",
      "page Deep/ <- root",
      "page Deep/er/ <- Deep/",
      "page Archive/Old.md <- Archive/",
      "page Deep/er/Leaf.md <- Deep/er/",
    ]);
    expect(plan(["Notes/README.md"]).nodes).toEqual(["page Notes/ <- root (Notes/README.md)"]);
    expect(plan(["Notes/Notes.md", "Notes/b.md"]).nodes).toEqual(["page Notes/ <- root (Notes/Notes.md)", "page Notes/b.md <- Notes/"]);
  });

  it("imports CSV files as databases and the pages in their folder as rows", () => {
    const { nodes, skipped } = plan([
      "Tasks 0123456789abcdef0123456789abcdef.csv",
      "Tasks 0123456789abcdef0123456789abcdef_all.csv",
      "Tasks 0123456789abcdef0123456789abcdef/Write docs.md",
      "Tasks 0123456789abcdef0123456789abcdef/Inner.csv",
      "Tasks 0123456789abcdef0123456789abcdef/Inner/x.md",
    ]);
    expect(nodes).toEqual([
      "database Tasks 0123456789abcdef0123456789abcdef_all.csv <- root",
      "row Tasks 0123456789abcdef0123456789abcdef/Write docs.md <- Tasks 0123456789abcdef0123456789abcdef_all.csv",
    ]);
    expect(skipped).toEqual([
      { path: "Tasks 0123456789abcdef0123456789abcdef.csv", reason: "duplicate" },
      { path: "Tasks 0123456789abcdef0123456789abcdef/Inner.csv", reason: "nestedDatabase" },
    ]);
  });

  it("skips ZIPs, system files and assets-only folders", () => {
    const { nodes, skipped } = plan(["a.md", "images/x.png", "more.zip", "__MACOSX/._a.md"]);
    expect(nodes).toEqual(["page a.md <- root"]);
    expect(skipped).toEqual([{ path: "more.zip", reason: "nestedZip" }]);
  });

  it("orders siblings by name, numbers naturally", () => {
    expect(plan(["10 ten.md", "2 two.md", "b.md", "A.md"]).nodes).toEqual([
      "page 2 two.md <- root",
      "page 10 ten.md <- root",
      "page A.md <- root",
      "page b.md <- root",
    ]);
  });

  it("makes a database's Templates folder its row templates, not a row", () => {
    expect(plan(["Tasks.csv", "Tasks/Done.md", "Tasks/Templates/Bug.md", "Tasks/Templates/Bug/Steps.md"]).nodes).toEqual([
      "database Tasks.csv <- root",
      "template row Tasks/Templates/Bug.md <- Tasks.csv",
      "row Tasks/Done.md <- Tasks.csv",
      "page Tasks/Templates/Bug/Steps.md <- Tasks/Templates/Bug.md",
    ]);
    // …with only templates in the database's folder too.
    expect(plan(["Tasks.csv", "Tasks/Templates/Bug.md"]).nodes).toEqual([
      "database Tasks.csv <- root",
      "template row Tasks/Templates/Bug.md <- Tasks.csv",
    ]);
  });

  it("makes a top-level Templates folder workspace templates only at the workspace's top level", () => {
    const paths = ["Home.md", "Templates/Meeting.md", "Templates/Board.csv", "Templates/Board/Row.md"];
    expect(plan(paths, { topLevel: true }).nodes).toEqual([
      "template database Templates/Board.csv <- root",
      "page Home.md <- root",
      "template page Templates/Meeting.md <- root",
      "row Templates/Board/Row.md <- Templates/Board.csv",
    ]);
    expect(plan(paths).nodes).toEqual([
      "page Home.md <- root",
      "page Templates/ <- root",
      "database Templates/Board.csv <- Templates/",
      "page Templates/Meeting.md <- Templates/",
      "row Templates/Board/Row.md <- Templates/Board.csv",
    ]);
  });

  it("keeps a Templates folder with a page of its name, or outside a database, as pages", () => {
    expect(plan(["Tasks.csv", "Tasks/Templates.md", "Tasks/Templates/Inner.md"]).nodes).toEqual([
      "database Tasks.csv <- root",
      "row Tasks/Templates.md <- Tasks.csv",
      "page Tasks/Templates/Inner.md <- Tasks/Templates.md",
    ]);
    expect(plan(["Project.md", "Project/Templates/A.md"], { topLevel: true }).nodes).toEqual([
      "page Project.md <- root",
      "page Project/Templates/ <- Project.md",
      "page Project/Templates/A.md <- Project/Templates/",
    ]);
  });

  it("maps files and folders to the node they became", () => {
    const { nodeOf } = plan(["P.md", "P/c.md", "F/index.md"]);
    expect(nodeOf.get("P")).toBe("P.md");
    expect(nodeOf.get("P/c.md")).toBe("P/c.md");
    expect(nodeOf.get("F")).toBe("F/");
    expect(nodeOf.get("F/index.md")).toBe("F/");
  });
});

describe("links", () => {
  it("resolves relative links, decoding them, and leaves others alone", () => {
    expect(resolveLink("a/b.md", "c%20d.md")).toBe("a/c d.md");
    expect(resolveLink("a/b.md", "../x.md#part")).toBe("x.md");
    expect(resolveLink("a/b.md", "<img/p q.png>")).toBe("a/img/p q.png");
    expect(resolveLink("a/b.md", "https://example.com")).toBeNull();
    expect(resolveLink("a/b.md", "mailto:x@example.com")).toBeNull();
    expect(resolveLink("a/b.md", "/w/ws/p/id")).toBeNull();
    expect(resolveLink("a/b.md", "#top")).toBeNull();
    expect(resolveLink("b.md", "../../x.md")).toBeNull();
  });

  it("rewrites links, images, definitions and HTML images, but not code", () => {
    const md = [
      "See [the plan](Plan.md \"title\") and ![diagram](img/d.png).",
      "Skip [web](https://example.com) and `[code](Plan.md)`.",
      "[ref]: Plan.md",
      '<img src="img/d.png" width="10">',
      "```",
      "[fenced](Plan.md)",
      "```",
      "[missing](Nope.md)",
    ].join("\n");
    const seen: string[] = [];
    const out = rewriteLinks(md, "notes/Index.md", ({ path, image }) => {
      seen.push(`${image ? "image" : "link"} ${path}`);
      return path === "notes/Nope.md" ? null : `/to/${path.replace(/ /g, "_")}`;
    });
    expect(out).toBe(
      [
        'See [the plan](/to/notes/Plan.md "title") and ![diagram](/to/notes/img/d.png).',
        "Skip [web](https://example.com) and `[code](Plan.md)`.",
        "[ref]: /to/notes/Plan.md",
        '<img src="/to/notes/img/d.png" width="10">',
        "```",
        "[fenced](Plan.md)",
        "```",
        "[missing](Nope.md)",
      ].join("\n"),
    );
    expect(seen).toEqual(["link notes/Plan.md", "image notes/img/d.png", "link notes/Plan.md", "image notes/img/d.png", "link notes/Nope.md"]);
  });

  it("handles links with parentheses and angle brackets", () => {
    const out = rewriteLinks("[a](Page%20(1).md) [b](<My Page.md>)", "x.md", ({ path }) => `/p/${encodeURIComponent(path)}`);
    expect(out).toBe("[a](/p/Page%20(1).md) [b](/p/My%20Page.md)");
  });
});

describe("stripRowProperties", () => {
  const headers = ["Name", "Status", "Notes", "Due", "Attachments"];

  it("drops the property list the export writes when it matches the row's cells", () => {
    const cells = ["Write docs", "Done", "line one\nline two", "", "a.png (files/a.png)"];
    const body = "- Status: Done\n- Notes: line one, line two\n- Attachments: [a.png](../files/a.png)\n\nThe body.\n\n- a list";
    expect(stripRowProperties(body, headers, cells, 0)).toBe("The body.\n\n- a list");
    expect(stripRowProperties("- Status: Done\n", ["Name", "Status"], ["x", "Done"], 0)).toBe("");
  });

  it("leaves a body alone when the list isn't what the export would write", () => {
    const cells = ["Write docs", "Done", "", "", ""];
    // Another value, another order, a missing or an extra line, or no blank line after it.
    for (const body of [
      "- Status: Open\n\nText",
      "- Notes: x\n- Status: Done\n\nText",
      "- Status: Done\n- Due: 2024-01-01\n\nText",
      "- Status: Done\n- more of a list",
      "Text\n\n- Status: Done",
    ]) {
      expect(stripRowProperties(body, headers, cells, 0)).toBe(body);
    }
    // A row without values has no list to drop.
    expect(stripRowProperties("- Status: Done", headers, ["x", "", "", "", ""], 0)).toBe("- Status: Done");
  });
});
