import { describe, expect, it } from "vitest";
import { PAGE_LINK_MARKER } from "../mentions";
import { resolveLink } from "./markdown";
import { blockReferences, frontMatterAliases, hasWikilink, hrefTo, obsidianMarkdown, rewriteWikilinks, VaultIndex } from "./obsidian";

const vault = new VaultIndex(
  [
    { path: "Vault/Welcome.md", aliases: ["Start here"] },
    { path: "Vault/Projects/Launch plan.md", aliases: ["Countdown plan"] },
    { path: "Vault/Projects/Apollo 11.md" },
    { path: "Vault/Notes/Ideas.md" },
    { path: "Vault/Archive/Ideas.md" },
    { path: "Vault/Archive/Deep/Deepest note.md" },
    { path: "Vault/Café crème.md" },
    { path: "Vault/Release v1.2.md" },
    { path: "Vault/Tasks.csv" },
  ],
  ["Vault/attachments/photo.png", "Vault/Notes/photo.png", "Vault/attachments/spec.pdf"],
);

describe("VaultIndex", () => {
  it("finds a note by name anywhere, without case or extension", () => {
    expect(vault.page("Launch plan", "Vault/Welcome.md")).toBe("Vault/Projects/Launch plan.md");
    expect(vault.page("launch PLAN.md", "Vault/Welcome.md")).toBe("Vault/Projects/Launch plan.md");
    expect(vault.page("Deepest note", "Vault/Notes/Ideas.md")).toBe("Vault/Archive/Deep/Deepest note.md");
    expect(vault.page("Release v1.2", "Vault/Welcome.md")).toBe("Vault/Release v1.2.md");
  });

  it("takes paths relative to the linking file and to the top first", () => {
    expect(vault.page("../Welcome", "Vault/Projects/Apollo 11.md")).toBe("Vault/Welcome.md");
    expect(vault.page("Vault/Notes/Ideas", "Vault/Welcome.md")).toBe("Vault/Notes/Ideas.md");
  });

  it("prefers the linking file's folder, then the shortest path, and matches a folder suffix", () => {
    expect(vault.page("Ideas", "Vault/Archive/Old.md")).toBe("Vault/Archive/Ideas.md");
    expect(vault.page("Ideas", "Vault/Welcome.md")).toBe("Vault/Archive/Ideas.md");
    expect(vault.page("Notes/Ideas", "Vault/Archive/Old.md")).toBe("Vault/Notes/Ideas.md");
    expect(vault.page("Elsewhere/Ideas", "Vault/Welcome.md")).toBeNull();
  });

  it("finds pages by alias and databases by name, and compares names in one Unicode form", () => {
    expect(vault.page("start HERE", "Vault/Projects/Apollo 11.md")).toBe("Vault/Welcome.md");
    expect(vault.page("Tasks", "Vault/Welcome.md")).toBe("Vault/Tasks.csv");
    expect(vault.page("Café crème", "Vault/Welcome.md")).toBe("Vault/Café crème.md");
    expect(vault.page("Nowhere", "Vault/Welcome.md")).toBeNull();
  });

  it("finds attachments by path or name, nearest first", () => {
    expect(vault.file("photo.png", "Vault/Notes/Ideas.md")).toBe("Vault/Notes/photo.png");
    expect(vault.file("photo.png", "Vault/Welcome.md")).toBe("Vault/attachments/photo.png");
    expect(vault.file("attachments/spec.pdf", "Vault/Notes/Ideas.md")).toBe("Vault/attachments/spec.pdf");
    expect(vault.file("photo.png", "Vault/Welcome.md")).not.toBeNull();
    expect(vault.file("Welcome.md", "Vault/Welcome.md")).toBeNull();
  });
});

describe("hrefTo", () => {
  it("writes a relative, encoded href the import's own link reading resolves back", () => {
    const from = "Vault/Projects/Apollo 11.md";
    for (const path of ["Vault/Welcome.md", "Vault/Projects/Launch plan.md", "Vault/a/b (1)#?%.md", "Top.md"]) {
      const href = hrefTo(from, path);
      expect(href.startsWith("<") && href.endsWith(">")).toBe(true);
      expect(resolveLink(from, href)).toBe(path);
    }
    expect(hrefTo("Vault/Projects/Apollo 11.md", "Vault/Welcome.md")).toBe("<../Welcome.md>");
  });
});

describe("rewriteWikilinks", () => {
  const from = "Vault/Welcome.md";
  const rewrite = (markdown: string, at = from) => {
    const missing: string[] = [];
    return { out: rewriteWikilinks(markdown, at, vault, (t) => missing.push(t)), missing };
  };

  it("writes wikilinks as Markdown links, with their labels", () => {
    expect(rewrite("See [[Launch plan]] and [[Apollo 11|the landing]].").out).toBe(
      "See [Launch plan](<Projects/Launch%20plan.md>) and [the landing](<Projects/Apollo%2011.md>).",
    );
    expect(rewrite("[[Launch plan#Countdown]], [[Launch plan#^step-2|step two]]").out).toBe(
      "[Launch plan > Countdown](<Projects/Launch%20plan.md>), [step two](<Projects/Launch%20plan.md>)",
    );
    expect(rewrite("[[Countdown plan]] [[Tasks]]").out).toBe("[Countdown plan](<Projects/Launch%20plan.md>) [Tasks](<Tasks.csv>)");
  });

  it("reads a label after an escaped pipe, as in a table", () => {
    expect(rewrite("| [[Apollo 11\\|landing]] | x |").out).toBe("| [landing](<Projects/Apollo%2011.md>) | x |");
  });

  it("turns embeds into images, files and link-to-page blocks", () => {
    expect(rewrite("![[photo.png]]").out).toBe("![](<attachments/photo.png>)");
    expect(rewrite("![[photo.png|300]] ![[photo.png|A photo]]").out).toBe(
      "![](<attachments/photo.png>) ![A photo](<attachments/photo.png>)",
    );
    expect(rewrite("![[spec.pdf]]").out).toBe("[spec.pdf](<attachments/spec.pdf>)");
    expect(rewrite("![[Launch plan]]").out).toBe(`[Launch plan](<Projects/Launch%20plan.md>) ${PAGE_LINK_MARKER}`);
    expect(rewrite("Text ![[Launch plan]]").out).toBe("Text [Launch plan](<Projects/Launch%20plan.md>)");
  });

  it("keeps links to the same note's headings as their text", () => {
    expect(rewrite("Up to [[#Intro]] or [[#Intro|the start]]").out).toBe("Up to Intro or the start");
  });

  it("leaves what names nothing as written and reports it, and doesn't touch code", () => {
    const { out, missing } = rewrite("[[Missing mission]] and ![[gone.png]]");
    expect(out).toBe("[[Missing mission]] and ![[gone.png]]");
    expect(missing).toEqual(["Missing mission", "gone.png"]);
    const code = "`[[Launch plan]]`\n```\n[[Launch plan]]\n```";
    expect(rewrite(code).out).toBe(code);
  });

  it("escapes backslashes in labels, and leaves a label with brackets (not a wikilink) alone", () => {
    expect(rewrite("[[Apollo 11|a \\ b]]").out).toBe("[a \\\\ b](<Projects/Apollo%2011.md>)");
    expect(rewrite("[[Apollo 11|a [b] c]]").out).toBe("[[Apollo 11|a [b] c]]");
  });

  it("tells a note with a wikilink", () => {
    expect(hasWikilink("See [[Note]]")).toBe(true);
    expect(hasWikilink("See [Note](Note.md) and [[ ]")).toBe(false);
  });
});

describe("frontMatterAliases", () => {
  it("reads inline lists, single values and block lists", () => {
    expect(frontMatterAliases('---\naliases: [Start here, "Home"]\n---\nText')).toEqual(["Start here", "Home"]);
    expect(frontMatterAliases("---\nalias: Home\n---\n")).toEqual(["Home"]);
    expect(frontMatterAliases("---\ntags: a\naliases:\n  - One\n  - 'Two'\ncreated: 2024\n---\n")).toEqual(["One", "Two"]);
    expect(frontMatterAliases("No front matter\naliases: x")).toEqual([]);
  });
});

describe("obsidianMarkdown", () => {
  it("writes callouts as the editor's kinds", () => {
    expect(obsidianMarkdown("> [!info] Heads up\n> Text")).toBe("> [!NOTE] Heads up\n> Text");
    expect(obsidianMarkdown("> [!tip]- Folded")).toBe("> [!TIP] Folded");
    expect(obsidianMarkdown("> [!danger]\n> x")).toBe("> [!CAUTION]\n> x");
    expect(obsidianMarkdown("> [!caution]")).toBe("> [!WARNING]");
    expect(obsidianMarkdown("> [!IMPORTANT]")).toBe("> [!IMPORTANT]");
    expect(obsidianMarkdown("> [!whatever]")).toBe("> [!NOTE]");
  });

  it("leaves out comments, block ids and highlight marks", () => {
    expect(obsidianMarkdown("Keep %%hidden%% this")).toBe("Keep  this");
    expect(obsidianMarkdown("Before\n%%\nsecret\nlines\n%%\nAfter")).toBe("Before\n\n\n\n\nAfter");
    expect(obsidianMarkdown("A paragraph ^abc-123\n^quote", new Set(["abc-123", "quote"]))).toBe("A paragraph\n");
    expect(obsidianMarkdown("Made by Obsidian ^x7k2qa\n^9fz1ab")).toBe("Made by Obsidian\n");
    expect(blockReferences("[[Plan#^step-2|two]] and [x](<Plan.md#^9fz1ab>), not [[Plan#Heading]]")).toEqual(["step-2", "9fz1ab"]);
    // Not a block id: nothing links to it, and Obsidian wouldn't write it so.
    expect(obsidianMarkdown("Area grows with r ^2\nVersion bump ^minor\n^quote")).toBe("Area grows with r ^2\nVersion bump ^minor\n^quote");
    expect(obsidianMarkdown("Some ==marked== text, a == b")).toBe("Some marked text, a == b");
  });

  it("doesn't touch code", () => {
    const code = "```\n%% x %% ==y== ^id\n> [!info]\n```\n`==z==` and `%%`";
    expect(obsidianMarkdown(code)).toBe(code);
  });
});
