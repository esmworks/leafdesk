import { describe, expect, it } from "vitest";
import { copyPublishedBlocks, mentionedPageIds, remapFilePaths, type CopyRefs } from "./published-copy";

const OLD_FILE = "A".repeat(24);
const NEW_FILE = "B".repeat(24);
const OTHER_FILE = "C".repeat(24);

const refs: CopyRefs = {
  pageIds: new Map([["inside", "copy-of-inside"], ["db", "copy-of-db"]]),
  fileIds: new Map([[OLD_FILE, NEW_FILE]]),
  outside: new Map([
    ["published", { text: "Elsewhere", href: "/s/acme/elsewhere-published" }],
    ["private", { text: "No access", href: null }],
  ]),
};

const mention = (props: Record<string, string>) => ({ type: "mention", props: { kind: "page", id: "", userId: "", name: "", pageId: "", date: "", remindAt: "", ...props } });
type TestBlock = { id: string; type: string; props: Record<string, unknown>; content?: unknown; children: TestBlock[] };
const paragraph = (content: unknown[], children: TestBlock[] = []): TestBlock => ({ id: "b", type: "paragraph", props: {}, content, children });

describe("remapFilePaths", () => {
  it("points copied files at their copies and leaves the rest", () => {
    expect(remapFilePaths(`![a](/api/files/${OLD_FILE}) /api/files/${OTHER_FILE}`, refs.fileIds)).toBe(
      `![a](/api/files/${NEW_FILE}) /api/files/${OTHER_FILE}`,
    );
    expect(remapFilePaths(`https://host/api/files/${OLD_FILE}?download=1`, refs.fileIds)).toBe(`https://host/api/files/${NEW_FILE}?download=1`);
  });
});

describe("copyPublishedBlocks", () => {
  it("turns people into text and drops reminders", () => {
    const [block] = copyPublishedBlocks(
      [paragraph([mention({ kind: "user", userId: "user-1", name: "Ayşe", id: "m1" }), mention({ kind: "date", date: "2026-10-01", remindAt: "2026-09-30T09:00:00Z" })])],
      refs,
    );
    const content = block.content as { type: string; text?: string; props?: Record<string, string> }[];
    expect(content[0]).toEqual({ type: "text", text: "@Ayşe", styles: {} });
    expect(content[1].props).toMatchObject({ kind: "date", date: "2026-10-01", remindAt: "" });
    expect(JSON.stringify(block)).not.toContain("user-1");
  });

  it("follows copied pages and shows the others as the publication did", () => {
    const [block] = copyPublishedBlocks(
      [paragraph([mention({ pageId: "inside" }), mention({ pageId: "published" }), mention({ pageId: "private" }), mention({ pageId: "unknown" })])],
      refs,
    );
    expect(block.content).toEqual([
      expect.objectContaining({ type: "mention", props: expect.objectContaining({ pageId: "copy-of-inside" }) }),
      { type: "link", href: "/s/acme/elsewhere-published", content: [{ type: "text", text: "Elsewhere", styles: {} }] },
      { type: "text", text: "No access", styles: {} },
    ]);
  });

  it("turns page links outside the copy into a line of text, keeps those inside", () => {
    const out = copyPublishedBlocks(
      [
        { id: "l1", type: "pageLink", props: { pageId: "inside" }, content: undefined, children: [] },
        { id: "l2", type: "pageLink", props: { pageId: "private" }, content: undefined, children: [] },
      ],
      refs,
    );
    expect(out[0]).toMatchObject({ type: "pageLink", props: { pageId: "copy-of-inside" } });
    expect(out[1]).toMatchObject({ type: "paragraph", content: [{ type: "text", text: "No access" }] });
  });

  it("keeps databases that were copied and leaves the others out", () => {
    const out = copyPublishedBlocks(
      [
        { id: "d1", type: "database", props: { databaseId: "db" }, children: [] },
        { id: "d2", type: "linkedView", props: { databaseId: "elsewhere", view: "{}" }, children: [paragraph([{ type: "text", text: "kept", styles: {} }])] },
      ],
      refs,
    );
    expect(out.map((b) => b.type)).toEqual(["database", "paragraph"]);
    expect(out[0].props).toMatchObject({ databaseId: "copy-of-db" });
  });

  it("leaves agent chats out, keeping what is nested in them", () => {
    const out = copyPublishedBlocks([{ id: "c1", type: "agentChat", props: { agentId: "a1", chatId: "chat1" }, children: [paragraph([{ type: "text", text: "kept", styles: {} }])] }], refs);
    expect(out.map((b) => b.type)).toEqual(["paragraph"]);
    expect(JSON.stringify(out)).not.toContain("a1");
  });

  it("keeps dashboard widgets whose database was copied", () => {
    const widget = (id: string, databaseId: string) => ({ id, databaseId, span: 1, view: { type: "list", config: {} } });
    const out = copyPublishedBlocks(
      [
        { id: "x1", type: "dashboard", props: { widgets: JSON.stringify([widget("a", "db"), widget("b", "elsewhere")]) }, children: [] },
        { id: "x2", type: "dashboard", props: { widgets: JSON.stringify([widget("c", "elsewhere")]) }, children: [] },
      ],
      refs,
    );
    expect(out.map((b) => b.id)).toEqual(["x1"]);
    expect(JSON.parse(String(out[0].props.widgets))).toEqual([widget("a", "copy-of-db")]);
  });

  it("points media, links and nested blocks at copied files", () => {
    const out = copyPublishedBlocks(
      [
        { id: "i", type: "image", props: { url: `/api/files/${OLD_FILE}`, caption: "" }, children: [] },
        paragraph([{ type: "link", href: `/api/files/${OLD_FILE}`, content: [{ type: "text", text: "file", styles: {} }] }], [
          { id: "n", type: "file", props: { url: `/api/files/${OLD_FILE}`, name: "x" }, children: [] },
        ]),
      ],
      refs,
    );
    const json = JSON.stringify(out);
    expect(json).not.toContain(OLD_FILE);
    expect(json.match(new RegExp(NEW_FILE, "g"))).toHaveLength(3);
  });

  it("walks table cells", () => {
    const [table] = copyPublishedBlocks(
      [
        {
          id: "t",
          type: "table",
          props: {},
          content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: [mention({ kind: "user", userId: "u", name: "Can" })] }] }] },
          children: [],
        },
      ],
      refs,
    );
    expect(JSON.stringify(table)).toContain("@Can");
    expect(JSON.stringify(table)).not.toContain('"userId":"u"');
  });
});

describe("mentionedPageIds", () => {
  it("finds page mentions and page links, in tables too", () => {
    expect(
      mentionedPageIds([
        paragraph([mention({ pageId: "a" }), mention({ kind: "user", userId: "u" })]),
        { id: "l", type: "pageLink", props: { pageId: "b" }, children: [] },
        {
          id: "t",
          type: "table",
          props: {},
          content: { type: "tableContent", rows: [{ cells: [[mention({ pageId: "c" })]] }] },
          children: [paragraph([mention({ pageId: "a" })])],
        },
      ]).sort(),
    ).toEqual(["a", "b", "c"]);
  });
});
