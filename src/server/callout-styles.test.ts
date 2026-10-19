import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { parseCalloutStyles, resolveCallout, storedCalloutStyles, type CalloutStyle } from "@/lib/callout-styles";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { editorBlocksToMarkdown, editorMarkdownToBlocks } from "@/lib/editor-markdown";
import { blocksToMarkdown, markdownToBlocks, serverEditor } from "./blocknote";
import { bodySegmentsFromYdoc } from "./published-body";

function docFrom(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as any, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return doc;
}

const read = (doc: Y.Doc) => serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
const stored = (blocks: unknown[]) => read(docFrom(blocks));

/** Markdown → blocks → Y.Doc → blocks → Markdown. */
async function roundTrip(markdown: string) {
  const blocks = stored(await markdownToBlocks(markdown));
  return { blocks, markdown: (await blocksToMarkdown(blocks)).trim() };
}

const text = (value: string) => ({ type: "text", text: value, styles: {} });
const shape = (list: any[]): unknown[] => list.map((b) => (b.children?.length ? { [b.type]: shape(b.children) } : b.type));

const warn: CalloutStyle = { key: "warn-box", name: "Warning box", icon: "⚠️", color: "orange", border: "left", title: "Watch out" };
const quiet: CalloutStyle = { key: "quiet", name: "Quiet", icon: "", color: "default", border: "full", title: "" };

async function html(blocks: unknown[], styles: CalloutStyle[] = [], print = false) {
  const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(docFrom(blocks)), { calloutStyles: styles, print });
  return segments.map((s) => (s.kind === "html" ? s.html : "")).join("");
}

describe("callout styles", () => {
  it("are checked when saved", () => {
    expect(parseCalloutStyles([warn, quiet])).toEqual({ ok: true, styles: [warn, quiet] });
    expect(parseCalloutStyles([{ ...warn, name: "  Spaced   name ", title: undefined }])).toEqual({
      ok: true,
      styles: [{ ...warn, name: "Spaced name", title: "" }],
    });
    const problem = (styles: unknown) => {
      const parsed = parseCalloutStyles(styles);
      return parsed.ok ? null : `${parsed.problem}@${parsed.index}`;
    };
    expect(problem([{ ...warn, key: "Warn" }])).toBe("key@0");
    expect(problem([{ ...warn, key: "-x" }])).toBe("key@0");
    expect(problem([{ ...warn, key: "a".repeat(33) }])).toBe("key@0");
    expect(problem([quiet, { ...warn, key: "note" }])).toBe("reservedKey@1");
    expect(problem([{ ...warn, key: "frame" }])).toBe("reservedKey@0");
    expect(problem([{ ...warn, key: "details" }])).toBe("reservedKey@0");
    expect(problem([warn, { ...quiet, key: warn.key }])).toBe("duplicateKey@1");
    expect(problem([{ ...warn, name: " " }])).toBe("name@0");
    expect(problem([{ ...warn, icon: "not an icon at all" }])).toBe("icon@0");
    expect(problem([{ ...warn, color: "teal" }])).toBe("color@0");
    expect(problem([{ ...warn, border: "dashed" }])).toBe("border@0");
    expect(problem([{ ...warn, title: "x".repeat(121) }])).toBe("title@0");
    expect(problem(Array.from({ length: 31 }, (_, i) => ({ ...quiet, key: `s${i}` })))).toBe("tooMany@-1");
    expect(problem("nope")).toBe("tooMany@-1");
    // What's stored is read leniently: a broken entry is left out, not the list.
    expect(storedCalloutStyles([warn, { key: "Bad" }, quiet, warn])).toEqual([warn, quiet]);
    expect(storedCalloutStyles(undefined)).toEqual([]);
  });

  it("draw a callout with its style's look, a deleted style's with its own props", () => {
    const props = { styleKey: "warn-box", icon: "🔥", backgroundColor: "red", title: "" };
    expect(resolveCallout(props, [warn])).toMatchObject({ icon: "⚠️", color: "orange", border: "left", title: "Watch out" });
    expect(resolveCallout({ ...props, title: "Own title" }, [warn]).title).toBe("Own title");
    expect(resolveCallout(props, [])).toEqual({ style: undefined, icon: "🔥", color: "red", border: "none", title: "" });
    // The built-in frame needs no workspace style.
    expect(resolveCallout({ styleKey: "frame", icon: "💡", backgroundColor: "gray" }, [])).toMatchObject({ icon: "", color: "default", border: "full" });
  });
});

describe("callouts saved before styles", () => {
  it("still load, as plain callouts without a title", async () => {
    // A callout as documents stored it before `styleKey` and `title` existed.
    const doc = docFrom([{ type: "callout", props: { icon: "🔥", backgroundColor: "red" }, content: "Hot", children: [{ type: "paragraph", content: "In" }] }]);
    const find = (node: Y.XmlFragment | Y.XmlElement): Y.XmlElement | undefined => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === "callout") return child;
        const found = find(child);
        if (found) return found;
      }
    };
    const callout = find(doc.getXmlFragment(COLLAB_FRAGMENT))!;
    doc.transact(() => {
      callout.removeAttribute("styleKey");
      callout.removeAttribute("title");
    });
    expect(Object.keys(callout.getAttributes()).sort()).toEqual(["backgroundColor", "hideInPrint", "icon", "textColor"]);
    const [block] = read(doc);
    expect(block.props).toEqual({ textColor: "default", backgroundColor: "red", icon: "🔥", hideInPrint: false, styleKey: "", title: "" });
    expect(shape([block])).toEqual([{ callout: ["paragraph"] }]);
    // Their Markdown and published HTML are what they were.
    expect((await blocksToMarkdown([block])).trim()).toBe("> [!CAUTION]\n> 🔥 Hot\n>\n> In");
    const out = await html([{ type: "callout", props: { icon: "🔥", backgroundColor: "red" }, content: "Hot" }], [warn]);
    expect(out).toContain('data-background-color="red"');
    expect(out).not.toMatch(/data-style-key|data-callout-border|data-callout-title/);
  });
});

describe("callouts in Markdown", () => {
  it("write a style's key and a title on the marker line, and read them back", async () => {
    const blocks = stored([
      { type: "callout", props: { styleKey: "warn-box", icon: "⚠️", backgroundColor: "orange", title: "Before you start" }, content: "Back up first" },
      { type: "callout", props: { icon: "", backgroundColor: "gray", title: "Plain, titled" }, content: "Text" },
      { type: "callout", props: { styleKey: "quiet", icon: "" }, content: [text("Untitled "), { type: "text", text: "bold", styles: { bold: true } }] },
    ]);
    const markdown = (await blocksToMarkdown(blocks)).trim();
    expect(markdown).toBe(
      ["> [!warn-box] Before you start", "> ⚠️ Back up first", "", "> [!NOTE] Plain, titled", "> Text", "", "> [!quiet]", "> Untitled **bold**"].join("\n"),
    );
    const again = await roundTrip(markdown);
    expect(again.markdown).toBe(markdown);
    // A styled callout's own color (drawn only once its style is gone) isn't written: it comes back gray.
    expect(again.blocks.map((b) => b.props)).toEqual(blocks.map((b: any) => (b.props.styleKey ? { ...b.props, backgroundColor: "gray" } : b.props)));
    expect(again.blocks[2].content).toEqual(blocks[2].content);
  });

  it("keep colors the alert kinds don't have after a '|', and leave the others as they were", async () => {
    const colors = ["gray", "green", "purple", "yellow", "red", "blue", "brown", "orange", "pink"];
    const blocks = stored(colors.map((color) => ({ type: "callout", props: { icon: "", backgroundColor: color }, content: color })));
    const markdown = (await blocksToMarkdown(blocks)).trim();
    expect(markdown.split("\n\n").map((part) => part.split("\n")[0])).toEqual([
      "> [!NOTE]",
      "> [!TIP]",
      "> [!IMPORTANT]",
      "> [!WARNING]",
      "> [!CAUTION]",
      "> [!NOTE|blue]",
      "> [!NOTE|brown]",
      "> [!WARNING|orange]",
      "> [!IMPORTANT|pink]",
    ]);
    const { blocks: back } = await roundTrip(markdown);
    expect(back.map((b: any) => b.props.backgroundColor)).toEqual(colors);
    // A color written after any kind wins over the kind's; an unknown one is ignored.
    const [a, b] = (await roundTrip("> [!TIP|Purple] Title\n> x\n\n> [!TIP|teal]\n> y")).blocks;
    expect(a.props).toMatchObject({ backgroundColor: "purple", title: "Title", styleKey: "" });
    expect(b.props).toMatchObject({ backgroundColor: "green" });
  });

  it("keep a key no style has, which draws as a plain callout with its title", async () => {
    const { blocks, markdown } = await roundTrip("> [!Somewhere-Else] Kept title\n> 📌 Body");
    expect(blocks[0].props).toMatchObject({ styleKey: "somewhere-else", title: "Kept title", icon: "📌", backgroundColor: "gray" });
    expect(markdown).toBe("> [!somewhere-else] Kept title\n> 📌 Body");
    const out = await html(blocks, [warn]);
    expect(out).toContain('data-background-color="gray"');
    expect(out).toContain("<div data-callout-title=\"\">Kept title</div>");
    expect(out).not.toContain("data-callout-border");
    // Not a key: a quote, as before.
    expect((await roundTrip("> [!not a key] text")).blocks.map((b) => b.type)).toEqual(["quote"]);
  });

  it("read the same in the editor's conversion", async () => {
    const editor = serverEditor as unknown as Parameters<typeof editorBlocksToMarkdown>[0];
    const blocks = [{ type: "callout", props: { styleKey: "warn-box", icon: "", backgroundColor: "pink", title: "T" }, content: [text("Body")] }];
    const markdown = await editorBlocksToMarkdown(editor, blocks);
    expect(markdown.trim()).toBe("> [!warn-box] T\n> Body");
    const back = await editorMarkdownToBlocks(editor, `${markdown}\n\n:::details More\nHidden\n:::\n\n:::info\nFYI\n:::`);
    expect(back.map((b) => b.type)).toEqual(["callout", "toggleListItem", "callout"]);
    expect(back[0].props).toMatchObject({ styleKey: "warn-box", title: "T" });
    expect(back[2].props).toMatchObject({ backgroundColor: "blue" });
    expect(back[2].props).not.toHaveProperty("styleKey");
  });
});

describe("containers in Markdown", () => {
  it("read the known names as callouts, details as a toggle and frames with their title", async () => {
    const { blocks } = await roundTrip(
      [
        ":::info",
        "For your information",
        ":::",
        "",
        ":::tip Handy",
        "A tip",
        ":::",
        "",
        ":::note",
        "A note",
        ":::",
        "",
        ":::warning Careful",
        "A warning",
        ":::",
        "",
        ":::danger",
        "Danger",
        ":::",
        "",
        ":::details Click to open",
        "Inside the toggle",
        "",
        "* and a list",
        ":::",
        "",
        ':::frame title="Framed"',
        "In a frame",
        ":::",
        "",
        ":::card{title='A card'}",
        "In a card",
        ":::",
        "",
        ":::panel",
        "In a panel",
        ":::",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual(["callout", "callout", "callout", "callout", "callout", "toggleListItem", "callout", "callout", "callout"]);
    const props = blocks.map((b) => b.props as Record<string, unknown>);
    expect(props.slice(0, 5).map((p) => [p.backgroundColor, p.title, p.styleKey])).toEqual([
      ["blue", "", ""],
      ["green", "Handy", ""],
      ["gray", "", ""],
      ["yellow", "Careful", ""],
      ["red", "", ""],
    ]);
    expect(blocks[0].content).toEqual([text("For your information")]);
    expect(blocks[5].content).toEqual([text("Click to open")]);
    expect(shape([blocks[5]])).toEqual([{ toggleListItem: ["paragraph", "bulletListItem"] }]);
    expect(props.slice(6).map((p) => [p.styleKey, p.title])).toEqual([
      ["frame", "Framed"],
      ["frame", "A card"],
      ["frame", ""],
    ]);
    const out = await html(blocks);
    expect(out).toContain('data-callout-border="full"');
  });

  it("read a style's key as that style, and any other name as a plain callout", async () => {
    const { blocks } = await roundTrip([":::warn-box", "Styled", ":::", "", ":::Mystery Some title", "Unknown", ":::", "", ":::odd_name", "Odd", ":::"].join("\n"));
    expect(blocks.map((b: any) => [b.type, b.props.styleKey, b.props.title])).toEqual([
      ["callout", "warn-box", ""],
      ["callout", "mystery", "Some title"],
      ["callout", "", ""],
    ]);
    const out = await html(blocks, [warn]);
    expect(out).toContain('data-callout-border="left"');
    expect(out).toContain("⚠️");
    expect(out).toContain("Watch out");
    // The unknown one stays plain.
    expect(out.match(/data-callout-border/g)).toHaveLength(1);
  });

  it("keep nesting, and nothing inside fenced code counts", async () => {
    const { blocks } = await roundTrip(
      [
        "::::warning Outer",
        "Outer text",
        "",
        ":::details Inner toggle",
        "Toggle body",
        "",
        ":::tip",
        "Deep tip",
        ":::",
        ":::",
        "",
        "```",
        ":::info",
        "not a container",
        ":::",
        "```",
        "::::",
        "",
        "After",
      ].join("\n"),
    );
    expect(shape(blocks)).toEqual([{ callout: [{ toggleListItem: ["paragraph", "callout"] }, "codeBlock"] }, "paragraph"]);
    expect(blocks[0].props).toMatchObject({ backgroundColor: "yellow", title: "Outer" });
    expect(blocks[0].content).toEqual([text("Outer text")]);
    const code = blocks[0].children[1];
    expect(code.content).toEqual([text(":::info\nnot a container\n:::")]);
    expect(blocks[1].content).toEqual([text("After")]);
  });

  it("end one left open with the Markdown, and leave a stray closing line as text", async () => {
    const { blocks } = await roundTrip(":::tip\nNever closed\n\nStill inside");
    expect(shape(blocks)).toEqual([{ callout: ["paragraph"] }]);
    const stray = await roundTrip("Text\n\n:::");
    expect(stray.blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
  });
});

describe("styled callouts on published pages and in print", () => {
  const blocks = [
    { type: "callout", props: { styleKey: "warn-box", icon: "🔥", backgroundColor: "red" }, content: "Styled" },
    { type: "callout", props: { styleKey: "quiet", icon: "🔥", backgroundColor: "red", title: "Own" }, content: "Quiet" },
    { type: "callout", props: { styleKey: "gone", icon: "🧊", backgroundColor: "blue", hideInPrint: true }, content: "Deleted style" },
  ];

  it("draw the style's icon, color, border and title", async () => {
    const out = await html(blocks, [warn, quiet]);
    const [styled, own] = out.split("</div></div>");
    expect(styled).toContain('data-background-color="orange"');
    expect(styled).toContain('data-callout-border="left"');
    expect(styled).toContain('<span data-callout-icon="">⚠️</span>');
    expect(styled).toContain('<div data-callout-title="">Watch out</div>');
    expect(own).toContain('data-callout-border="full"');
    expect(own).not.toContain("data-callout-icon");
    expect(own).toContain('<div data-callout-title="">Own</div>');
  });

  it("fall back to the callout's own props when its style was deleted", async () => {
    const out = await html(blocks, [warn]);
    const deleted = out.slice(out.indexOf('data-style-key="gone"') - 200);
    expect(deleted).toContain('data-background-color="blue"');
    expect(deleted).toContain("🧊");
    expect(out.match(/data-callout-border/g)).toHaveLength(1);
    // Hidden in print still works for styled callouts.
    expect(await html(blocks, [warn], true)).not.toContain("Deleted style");
  });

  it("escape titles, which are text", async () => {
    const out = await html([{ type: "callout", props: { title: '<img src=x onerror="alert(1)">' }, content: "x" }]);
    expect(out).toContain("&lt;img src=x onerror=\"alert(1)\"&gt;");
    // Only as an attribute's value, which BlockNote writes for every prop.
    expect(out.replace(/ data-title="[^"]*"/, "")).not.toContain("<img");
  });
});
