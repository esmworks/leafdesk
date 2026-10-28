import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

const { findTools, isDocsAddress } = await import("./ai-more-tools");
type MoreTools = import("./ai-more-tools").MoreTools;

const tool = (name: string, title: string, description: string, writes = true) => ({ name, title, description, inputSchema: { type: "object" }, writes, eachTime: false });
const tools: MoreTools = {
  byName: new Map(
    [
      tool("create_database_view", "Create database view", "Add a view (table, board, calendar…) to a database."),
      tool("update_database_property", "Update database property", "Rename a property or change its options."),
      tool("move_page", "Move page", "Move a page under another page."),
      tool("list_trash", "List trash", "Pages in the trash.", false),
    ].map((t) => [t.name, t]),
  ),
  call: async () => ({ text: "", isError: false }),
  close: async () => undefined,
};

describe("find_tools", () => {
  it("shows the tools that fit best first, with their inputs, and names all of them", () => {
    const text = findTools(tools, "calendar views", 10_000);
    expect(text.startsWith("## create_database_view (Create database view, changes something)")).toBe(true);
    expect(text).toContain('Inputs (JSON schema): {"type":"object"}');
    expect(text).not.toContain("## move_page");
    expect(text).toContain("All of them: create_database_view, update_database_property, move_page, list_trash.");
  });

  it("finds a tool by the plural of a word in its name", () => {
    expect(findTools(tools, "pages", 10_000).startsWith("## move_page (")).toBe(true);
    expect(findTools(tools, "properties", 10_000).startsWith("## update_database_property (")).toBe(true);
  });

  it("says whether a tool only reads", () => {
    expect(findTools(tools, "trash", 10_000)).toContain("## list_trash (List trash, only reads)");
  });

  it("names them all when nothing fits, or nothing is asked", () => {
    expect(findTools(tools, "spaceship", 10_000)).toMatch(/^No tool fits those words\. All of them: /);
    expect(findTools(tools, "", 10_000)).toMatch(/^All of them: /);
  });

  it("names a tool that doesn't fit the room instead of showing it", () => {
    const text = findTools(tools, "page", 230);
    expect(text).toContain("## move_page: too long to show with the others; ask for it by its name.");
  });
});

describe("docs addresses", () => {
  it("are told apart from page ids", () => {
    expect(isDocsAddress("leafdesk://docs/views")).toBe(true);
    expect(isDocsAddress(" leafdesk://docs/filters")).toBe(true);
    expect(isDocsAddress("3f2c…")).toBe(false);
    expect(isDocsAddress(undefined)).toBe(false);
  });
});
