import { describe, expect, it } from "vitest";
import { fast } from "./linear-fixtures";
import {
  configString,
  formatDay,
  inlineMarkdown,
  journalDay,
  logseqRoots,
  outlineMarkdown,
  pageName,
  parseOutline,
  propertyNames,
  unpackLogseqGraphs,
  type GraphContext,
} from "./logseq";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array | undefined) => (data ? new TextDecoder().decode(data) : undefined);

const UUID = "64f0c3a1-1111-4222-8333-944455556666";
const context: GraphContext = {
  knows: (name) => ["plan", "a/b", "jan 15th, 2024"].includes(name.trim().toLowerCase()),
  blockText: (uuid) => (uuid === UUID ? "the referenced block" : null),
};
const outline = (markdown: string) => outlineMarkdown(parseOutline(markdown).blocks, context);

describe("graph settings and names", () => {
  it("finds graphs by their settings file", () => {
    expect(logseqRoots(["logseq/config.edn", "My graph/logseq/config.edn", "notes/logseq.md", "pages/a.md"])).toEqual(["", "My graph/"]);
  });

  it("reads a string setting, passing over commented ones", () => {
    const config = `{:meta/version 1\n ;; :journal/page-title-format "yyyy"\n :journal/page-title-format "EEE, dd.MM.yyyy"\n :journal/file-name-format "yyyy-MM-dd"}`;
    expect(configString(config, ":journal/page-title-format")).toBe("EEE, dd.MM.yyyy");
    expect(configString(config, ":journal/file-name-format")).toBe("yyyy-MM-dd");
    expect(configString(config, ":missing")).toBeNull();
  });

  it("writes days in Logseq's formats", () => {
    expect(formatDay(2024, 1, 15, "MMM do, yyyy")).toBe("Jan 15th, 2024");
    expect(formatDay(2024, 3, 1, "MMM do, yyyy")).toBe("Mar 1st, 2024");
    expect(formatDay(2024, 3, 12, "do MMMM yyyy")).toBe("12th March 2024");
    expect(formatDay(2024, 1, 15, "EEEE, yyyy/MM/dd")).toBe("Monday, 2024/01/15");
    expect(formatDay(2024, 1, 5, "E d.M.yy 'week'")).toBe("Fri 5.1.24 week");
  });

  it("reads a journal's day from its file name", () => {
    expect(journalDay("2024_01_15")).toEqual({ year: 2024, month: 1, day: 15 });
    expect(journalDay("15-01-2024", "dd-MM-yyyy")).toEqual({ year: 2024, month: 1, day: 15 });
    expect(journalDay("2024_02_30")).toBeNull();
    expect(journalDay("notes")).toBeNull();
  });

  it("reads page names from file names, namespaces included", () => {
    expect(pageName("Projects___Launch")).toBe("Projects/Launch");
    expect(pageName("Projects%2FLaunch")).toBe("Projects/Launch");
    expect(pageName("What%3F")).toBe("What?");
    expect(pageName("100%")).toBe("100%");
  });

  it("reads lists of names in properties", () => {
    expect(propertyNames('[[Plan B]], second, "third", #fourth')).toEqual(["Plan B", "second", "third", "fourth"]);
  });
});

describe("parseOutline", () => {
  it("reads blocks by depth, with their other lines, tabs or spaces", () => {
    const { before, blocks } = parseOutline("title:: Home\n\n- One\n  more of one\n\t- Two\n\t\t- Three\n- Four\n    - Five\n");
    expect(before).toEqual(["title:: Home", ""]);
    expect(blocks).toEqual([
      { depth: 0, lines: ["One", "more of one"] },
      { depth: 1, lines: ["Two"] },
      { depth: 2, lines: ["Three"] },
      { depth: 0, lines: ["Four"] },
      { depth: 1, lines: ["Five"] },
    ]);
  });

  it("keeps a fenced code block's lines in its block, bullets or not", () => {
    const { blocks } = parseOutline("- ```js\n  - not a block\n  ```\n- Next");
    expect(blocks).toEqual([
      { depth: 0, lines: ["```js", "- not a block", "```"] },
      { depth: 0, lines: ["Next"] },
    ]);
  });
});

describe("outlineMarkdown", () => {
  it("keeps blocks as a list and takes headings out of it", () => {
    expect(outline("- ## Section\n\t- point\n\t\t- detail\n\t- ### Sub\n\t\t- inside\n- loose")).toBe(
      "## Section\n\n- point\n  - detail\n\n### Sub\n\n- inside\n- loose",
    );
  });

  it("writes task markers as to-dos, with their days", () => {
    expect(outline("- TODO Call [#A] Ana\n  SCHEDULED: <2024-01-15 Mon 10:00>\n- DONE Ship\n- CANCELED Old idea\n- LATER Read")).toBe(
      "- [ ] Call [#A] Ana @2024-01-15\n- [x] Ship\n- [x] ~~Old idea~~\n- [ ] Read",
    );
    expect(outline("- NOW [#B] Fix it")).toBe("- [ ] #B Fix it");
  });

  it("leaves out internal properties and logbooks, keeps the others", () => {
    expect(outline(`- Meeting\n  id:: ${UUID}\n  collapsed:: true\n  room:: 4\n  :LOGBOOK:\n  CLOCK: [2024-01-15]\n  :END:\n\t- notes`)).toBe(
      "- Meeting\n  room: 4\n  - notes",
    );
  });

  it("drops empty blocks, moving what is under them up", () => {
    expect(outline("- \n\t- under an empty one\n-")).toBe("- under an empty one");
  });

  it("takes code out of the list when it's at the top", () => {
    expect(outline("- ```\n  - x\n  ```\n- after")).toBe("```\n- x\n```\n\n- after");
  });
});

describe("inlineMarkdown", () => {
  it("writes links, references, tags and macros as the editor reads them", () => {
    expect(inlineMarkdown("[[Plan]] and [[Nowhere]] and [[a/b]]", context)).toBe("[[Plan]] and Nowhere and [[a/b]]");
    expect(inlineMarkdown(`see ((${UUID})) or ((${"0".repeat(8)}-0000-0000-0000-000000000000))`, context)).toBe("see the referenced block or ");
    expect(inlineMarkdown("[the plan]([[Plan]]) [x]([[Gone]]) [ref](((" + UUID + ")))", context)).toBe("[[Plan|the plan]] x ref");
    expect(inlineMarkdown("#[[Plan]] #[[two words]] #tag", context)).toBe("[[Plan]] #two-words #tag");
    expect(inlineMarkdown("{{embed [[Plan]]}}", context, true)).toBe("![[Plan]]");
    expect(inlineMarkdown(`{{embed ((${UUID}))}} {{video https://v.example/1}} {{query (todo now)}}`, context)).toBe(
      "the referenced block https://v.example/1 `{{query (todo now)}}`",
    );
    expect(inlineMarkdown("^^marked^^ ![a](../assets/a.png){:height 30, :width 40}", context)).toBe("marked ![a](../assets/a.png)");
    expect(inlineMarkdown("`[[Nowhere]]` stays", context)).toBe("`[[Nowhere]]` stays");
  });

  it("takes time growing with the line's length", () => {
    fast(() => inlineMarkdown("[[a]]".repeat(200_000), context));
    fast(() => inlineMarkdown("[x](".repeat(200_000) + ")", context));
    fast(() => inlineMarkdown("((".repeat(300_000) + "))", context));
    fast(() => inlineMarkdown("{{".repeat(300_000), context));
    fast(() => outline(`- ${"a".repeat(500_000)}::`));
  });
});

describe("unpackLogseqGraphs", () => {
  const graph = (dir = "") =>
    new Map(
      Object.entries({
        [`${dir}logseq/config.edn`]: '{:journal/page-title-format "MMM do, yyyy"}',
        [`${dir}logseq/custom.css`]: "",
        [`${dir}logseq/bak/pages/Plan.md`]: "- old",
        [`${dir}pages/Plan.md`]: `alias:: Roadmap\n\n- Goals\n  id:: ${UUID}\n- See [[Projects/Launch]] and [[Jan 15th, 2024]]\n- ![shot](../assets/shot.png)`,
        [`${dir}pages/Projects___Launch.md`]: `- Builds on ((${UUID})) of [[Roadmap]]`,
        [`${dir}journals/2024_01_15.md`]: "- TODO Write [[Plan]]",
        [`${dir}assets/shot.png`]: "png",
        [`${dir}draws/x.excalidraw`]: "{}",
      }).map(([path, text]) => [path, encode(text)]),
    );

  it("lays pages and journal days out as Markdown files with titles and aliases", () => {
    const { files, graphs } = unpackLogseqGraphs(graph("Graph/"));
    expect(graphs).toBe(1);
    expect([...files.keys()].sort()).toEqual(["Graph/Plan.md", "Graph/Projects/Launch.md", "Graph/assets/shot.png", "Graph/journals/2024-01-15.md"]);
    expect(decode(files.get("Graph/Plan.md"))).toBe(
      '---\ntitle: "Plan"\naliases:\n  - "Plan"\n  - "Roadmap"\n---\n\n- Goals\n- See [[Projects/Launch]] and [[Jan 15th, 2024]]\n\n![shot](assets/shot.png)\n',
    );
    expect(decode(files.get("Graph/Projects/Launch.md"))).toBe(
      '---\ntitle: "Launch"\naliases:\n  - "Launch"\n  - "Projects/Launch"\n---\n\n- Builds on Goals of [[Roadmap]]\n',
    );
    expect(decode(files.get("Graph/journals/2024-01-15.md"))).toBe(
      '---\ntitle: "Jan 15th, 2024"\naliases:\n  - "Jan 15th, 2024"\n  - "2024-01-15"\n---\n\n- [ ] Write [[Plan]]\n',
    );
  });

  it("works at the top of the upload and leaves uploads without a graph as they were", () => {
    expect([...unpackLogseqGraphs(graph()).files.keys()].sort()).toEqual(["Plan.md", "Projects/Launch.md", "assets/shot.png", "journals/2024-01-15.md"]);
    const plain = new Map([["pages/a.md", encode("- a")]]);
    expect(unpackLogseqGraphs(plain).files).toBe(plain);
  });

  it("titles a page by its title property, and keeps two pages of one name apart", () => {
    const files = new Map([
      ["logseq/config.edn", encode("{}")],
      ["pages/what_.md", encode("title:: What?\n\n- body")],
      ["pages/What%3F.md", encode("- other")],
    ]);
    const out = unpackLogseqGraphs(files).files;
    expect([...out.keys()].sort()).toEqual(["What? (2).md", "What?.md"]);
  });
});
