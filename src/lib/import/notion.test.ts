import { describe, expect, it } from "vitest";
import { splitList } from "./csv";
import { fast, randomTexts } from "./linear-fixtures";
import { planImport, resolveLink } from "./markdown";
import {
  isNotionExport,
  notionId,
  notionMarkdown,
  notionUrlId,
  planRelations,
  relationRefs,
  relationTitles,
  rewriteNotionUrls,
  soleLink,
  splitRowProperties,
  type NotionDatabase,
} from "./notion";

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";
const C = "1111111111111111aaaaaaaaaaaaaaaa";

describe("Notion names and links", () => {
  it("reads the id at the end of file and folder names", () => {
    expect(notionId(`Docs/Project plan ${A}.md`)).toBe(A);
    expect(notionId(`Tasks ${A}_all.csv`)).toBe(A);
    expect(notionId(`Tasks ${A.toUpperCase()}/`)).toBe(A);
    expect(notionId(`v1.2 notes ${A}`)).toBe(A);
    expect(notionId("Project plan.md")).toBeNull();
    expect(notionId(`Project${A}.md`)).toBeNull();
  });

  it("tells a Notion export by its names", () => {
    expect(isNotionExport(["a.md", `Tasks ${A}/Row ${B}.md`])).toBe(true);
    expect(isNotionExport(["a.md", "Tasks/Row.md"])).toBe(false);
  });

  it("reads page ids from notion.so links", () => {
    expect(notionUrlId(`https://www.notion.so/Project-plan-${A}?pvs=21`)).toBe(A);
    expect(notionUrlId(`https://www.notion.so/acme/${A}`)).toBe(A);
    expect(notionUrlId("https://www.notion.so/0123abcd-89ab-cdef-0123-456789abcdef")).toBe("0123abcd89abcdef0123456789abcdef");
    expect(notionUrlId(`https://acme.notion.site/Page-${B}`)).toBe(B);
    expect(notionUrlId(`https://www.notion.so/acme/Board-${A}?p=${B}&pm=s`)).toBe(B);
    expect(notionUrlId(`https://example.com/Page-${A}`)).toBeNull();
    expect(notionUrlId("https://www.notion.so/product")).toBeNull();
    expect(notionUrlId("not a url")).toBeNull();
  });

  it("points notion.so links it knows at imported pages, outside code", () => {
    const md = [
      `See [plan](https://www.notion.so/Project-plan-${A}?pvs=21) and [other](https://www.notion.so/Other-${B}).`,
      `\`[code](https://www.notion.so/x-${A})\``,
      "```",
      `[fenced](https://www.notion.so/x-${A})`,
      "```",
    ].join("\n");
    const out = rewriteNotionUrls(md, (id) => (id === A ? "/w/ws/p/1" : null));
    expect(out.split("\n")[0]).toBe(`See [plan](/w/ws/p/1) and [other](https://www.notion.so/Other-${B}).`);
    expect(out.split("\n").slice(1)).toEqual(md.split("\n").slice(1));
  });

  it("finds lines that are only a link", () => {
    expect(soleLink(`[Child](Parent%20${A}/Child%20${B}.md)`)).toBe(`Parent%20${A}/Child%20${B}.md`);
    expect(soleLink("  [x](a.md)  ")).toBe("a.md");
    expect(soleLink("See [x](a.md)")).toBeNull();
    expect(soleLink("![img](a.png)")).toBeNull();
  });
});

describe("notionMarkdown", () => {
  it("turns callouts into NOTE callouts, icon first", () => {
    expect(notionMarkdown("Before\n\n<aside>\n💡 A **tip**\n\nSecond line\n\n</aside>\n\nAfter")).toBe(
      "Before\n\n> [!NOTE]\n> 💡 A **tip**\n>\n> Second line\n\n\nAfter",
    );
  });

  it("joins an icon on a line of its own to the text after it", () => {
    expect(notionMarkdown("<aside>\n🚧\n\nUnder construction\n</aside>")).toBe("> [!NOTE]\n> 🚧 Under construction\n");
  });

  it("reads callouts on one line and without an icon", () => {
    expect(notionMarkdown("<aside>Plain note</aside>")).toBe("> [!NOTE]\n> Plain note\n");
    expect(notionMarkdown("<aside>📌 Pinned</aside> after")).toBe("> [!NOTE]\n> 📌 Pinned\n\nafter");
  });

  it("leaves an aside that never closes, and code, as they are", () => {
    expect(notionMarkdown("<aside>\nopen")).toBe("<aside>\nopen");
    const code = "```html\n<aside>x</aside>\n$`a`$\n```";
    expect(notionMarkdown(code)).toBe(code);
  });

  it("writes inline equations the way the editor reads them", () => {
    expect(notionMarkdown("Energy $`E=mc^2`$ and $`\\frac{a}{b}`$.")).toBe("Energy $E=mc^2$ and $\\frac{a}{b}$.");
    expect(notionMarkdown("$$\nE=mc^2\n$$")).toBe("$$\nE=mc^2\n$$");
    expect(notionMarkdown("<aside>\nSee $`x`$\n</aside>")).toBe("> [!NOTE]\n> See $x$\n");
  });
});

describe("splitRowProperties", () => {
  const headers = ["Name", "Status", "Due date", "Due", "Project"];

  it("takes the property list off a row page and keeps its values", () => {
    const body = "Status: Done\nDue date: September 28, 2026\nProject: Site (../Projects%20x/Site%20y.md)\n\nThe row's own text.\n";
    const split = splitRowProperties(body, headers, 0);
    expect(split.body).toBe("The row's own text.\n");
    expect(Object.fromEntries(split.values)).toEqual({
      Status: "Done",
      "Due date": "September 28, 2026",
      Project: "Site (../Projects%20x/Site%20y.md)",
    });
  });

  it("reads a page that is only a list", () => {
    expect(splitRowProperties("Status: Open", headers, 0)).toEqual({ body: "", values: new Map([["Status", "Open"]]) });
  });

  it("leaves other bodies as they are", () => {
    const cases = [
      "Just text\n\nStatus: not a list",
      "Status: Done\nThis line is text, so it isn't a list\n\nMore",
      "Name: the title isn't a property\n\nText",
      "Status: Done\nStatus: twice\n\nText",
      "",
    ];
    for (const body of cases) expect(splitRowProperties(body, headers, 0)).toEqual({ body, values: new Map() });
  });
});

describe("relations", () => {
  it("reads Notion's relation cells", () => {
    const from = `Tasks ${A}_all.csv`;
    expect(relationRefs(`Site (Projects%20${B}/Site%20${C}.md), Blog (Projects%20${B}/Blog%20${A}.md)`, from)).toEqual([
      { title: "Site", path: `Projects ${B}/Site ${C}.md`, id: C },
      { title: "Blog", path: `Projects ${B}/Blog ${A}.md`, id: A },
    ]);
    expect(relationRefs(`Site (https://www.notion.so/Site-${C}?pvs=21)`, from)).toEqual([{ title: "Site", path: null, id: C }]);
    // Titles with commas and parentheses of their own.
    expect(relationRefs(`Plan, v2 (draft) (Projects%20${B}/Plan,%20v2%20(draft)%20${C}.md)`, from)).toEqual([
      { title: "Plan, v2 (draft)", path: `Projects ${B}/Plan, v2 (draft) ${C}.md`, id: C },
    ]);
  });

  it("reads relations as a row page's list writes them", () => {
    const from = `Tasks ${A}/Write ${B}.md`;
    expect(relationRefs(`[Site](../Projects%20${B}/Site%20${C}.md), [Blog](https://www.notion.so/Blog-${A})`, from)).toEqual([
      { title: "Site", path: `Projects ${B}/Site ${C}.md`, id: C },
      { title: "Blog", path: null, id: A },
    ]);
  });

  it("finds no relation in plain cells", () => {
    expect(relationRefs("Site, Blog", "t.csv")).toEqual([]);
    expect(relationRefs("Meeting (weekly)", "t.csv")).toEqual([]);
    expect(relationRefs("diagram (files/diagram.png)", "t.csv")).toEqual([]);
    expect(relationRefs("", "t.csv")).toEqual([]);
  });

  it("gives a relation cell's titles when the column stays text", () => {
    expect(relationTitles(`Site (https://www.notion.so/Site-${C}), Blog (x/Blog%20${A}.md)`, "t.csv")).toBe("Site, Blog");
    expect(relationTitles("Plain text", "t.csv")).toBe("Plain text");
  });

  it("decides which columns are relations to which database", () => {
    const tasks: NotionDatabase = {
      key: `Tasks ${A}_all.csv`,
      source: `Tasks ${A}_all.csv`,
      headers: ["Name", "Project", "Elsewhere", "Tags", "Listed"],
      rows: [
        ["Write", `Site (Projects%20${B}/Site%20${C}.md)`, `X (https://www.notion.so/X-${A.replace("0", "9")})`, "a, b", ""],
        ["Ship", "", "", "a", ""],
      ],
      titleColumn: 0,
      rowPages: [{ source: `Tasks ${A}/Write ${B}.md`, values: new Map([["Listed", `[Site](../Projects%20${B}/Site%20${C}.md)`]]) }],
    };
    const targetOf = (ref: { path: string | null }) => (ref.path?.startsWith(`Projects ${B}/`) ? `Projects ${B}.csv` : null);
    const { relations, plain } = planRelations([tasks], targetOf);
    expect(relations.get(tasks.key)).toEqual([
      { column: 1, header: "Project", target: `Projects ${B}.csv` },
      { column: 4, header: "Listed", target: `Projects ${B}.csv` },
    ]);
    expect(plain.get(tasks.key)).toEqual([2]);
  });
});

describe("planImport with Notion's layout", () => {
  it("leaves out a database's own Markdown file and links it to the database", () => {
    const plan = planImport([`Tasks ${A}.md`, `Tasks ${A}.csv`, `Tasks ${A}_all.csv`, `Tasks ${A}/Row ${B}.md`, "Notes.md", "Notes.csv"]);
    // Without Notion ids a page and a database of the same name are both kept.
    expect(plan.nodes.map((n) => `${n.kind}:${n.key}`)).toEqual([
      "database:Notes.csv",
      "page:Notes.md",
      `database:Tasks ${A}_all.csv`,
      `row:Tasks ${A}/Row ${B}.md`,
    ]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { path: `Tasks ${A}.csv`, reason: "duplicate" },
        { path: `Tasks ${A}.md`, reason: "duplicate" },
      ]),
    );
    expect(plan.nodeOf.get(`Tasks ${A}.md`)).toBe(`Tasks ${A}_all.csv`);
  });
});

describe("crafted exports are read in time growing with their length", () => {
  it("callouts that never close", () => {
    const open = "<aside>\nnote\n".repeat(50_000);
    expect(fast(() => notionMarkdown(open))).toBe(open);
    const closed = "<aside>\n💡\nText\n</aside>\n";
    expect(fast(() => notionMarkdown(closed + open))).toBe(`> [!NOTE]\n> 💡 Text\n\n${open}`);
  });

  it("names ending in many slashes, and cells full of brackets", () => {
    expect(fast(() => notionId(`Tasks ${A}${"/".repeat(1_000_000)}`))).toBe(A);
    expect(fast(() => notionId(`${"/".repeat(1_000_000)}x`))).toBeNull();
    expect(fast(() => relationRefs(`](${"[".repeat(1_000_000)}`, "Tasks.csv"))).toEqual([]);
    expect(fast(() => relationRefs(`${"[".repeat(500_000)}Row](Row%20${A}.md)`, "Tasks.csv"))).toEqual([
      { title: `${"[".repeat(499_999)}Row`, path: `Row ${A}.md`, id: A },
    ]);
  });

  it("finds the same relation links as the regex it replaces", () => {
    const MD_LINK = /\[((?:\\.|[^\]\\\n])*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?\s*\)/g;
    const target = (href: string, from: string) => {
      const id = notionUrlId(href);
      if (id) return { path: null, id };
      if (!/\.md$/i.test(href.replace(/[?#].*$/, ""))) return null;
      const path = resolveLink(from, href);
      return path ? { path, id: notionId(path) } : null;
    };
    const before = (cell: string) => {
      const refs: { title: string; path: string | null; id: string | null }[] = [];
      let last = 0;
      for (const match of cell.matchAll(MD_LINK)) {
        const found = target(match[2], "Tasks.csv");
        if (!found) continue;
        for (const title of splitList(cell.slice(last, match.index))) refs.push({ title, path: null, id: null });
        refs.push({ title: match[1].replace(/\\(.)/g, "$1").trim(), ...found });
        last = match.index + match[0].length;
      }
      if (!refs.length) return [];
      for (const title of splitList(cell.slice(last))) refs.push({ title, path: null, id: null });
      return refs;
    };
    const pieces = ["[", "]", "](", "a", "\\", "(", ")", " ", ",", "\n", "<", ">", "b.md", "](a.md)", "?"];
    for (const text of randomTexts(pieces, 5000, 14)) expect(relationRefs(`](${text}`, "Tasks.csv")).toEqual(before(`](${text}`));
  });
});
