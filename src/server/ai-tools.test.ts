import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatFileContent } from "./ai-chat-files";

/**
 * search_pages in the AI chat: a page the text search found without a passage gets the indexed
 * passage with the most of the query's words, cited at its block, rather than a snippet; a page
 * without an index gets that part of its body's text.
 */
type Result = { id: string; title: string; parent_id: string | null; snippet: string; passage?: string | null; block_id?: string | null };
const results: Result[] = [];
const chunks = new Map<string, { blockId: string | null; position: number; text: string }[]>();
/** The body text (page.content_text) of pages, by id. */
const bodies = new Map<string, string>();

vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => [...bodies].map(([id, text]) => ({ id, text })) }) }) },
}));
vi.mock("@/server/collab/bridge", () => ({ getCollab: vi.fn() }));
vi.mock("@/server/pages", () => ({ getTree: vi.fn() }));
vi.mock("@/server/databases", () => ({ normalizeRowProperties: vi.fn() }));
const searchCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("@/server/operations", async () => ({
  rowValue: (await import("zod")).z.any(),
  search: async (...args: unknown[]) => {
    searchCalls.push(args);
    return { results };
  },
}));
/** Archived scope pages, by id (server/page-outdated). */
const outdatedScopes = vi.hoisted(() => new Set<string>());
vi.mock("@/server/page-outdated", () => ({
  outdatedState: async (_userId: string, pageId: string) => (outdatedScopes.has(pageId) ? { pageId, own: true } : null),
}));
vi.mock("@/server/semantic-search", () => ({
  inSubtree: vi.fn(),
  chunksOfPages: async (ids: string[]) => new Map([...chunks].filter(([id]) => ids.includes(id))),
}));

const { prepareWrite, runTool } = await import("./ai-tools");

const search = async (query: string, scopeId?: string) => {
  const registry = { sources: [], byKey: new Map() };
  const outcome = await runTool({ userId: "u" } as never, "w", scopeId, { name: "search_pages", arguments: { query } }, registry, 50_000);
  return { outcome, sources: registry.sources as { pageId: string; blockId: string | null; text: string }[] };
};

beforeEach(() => {
  results.length = 0;
  searchCalls.length = 0;
  outdatedScopes.clear();
  chunks.clear();
  bodies.clear();
});

describe("search_pages passages", () => {
  it("sends a page found by its words with the passage that has them, cited at its block", async () => {
    results.push({ id: "p1", title: "2026 plan", parent_id: null, snippet: "…late deliveries from…" });
    chunks.set("p1", [
      { blockId: "b0", position: 0, text: "Sales › 2026 plan\n\nWe grow the team." },
      { blockId: "b4", position: 1, text: "Sales › 2026 plan\nRisks\n\nSuppliers may deliver late; deliveries slip." },
    ]);
    const { outcome, sources } = await search("Which supplier deliveries are late?");
    expect(sources).toEqual([expect.objectContaining({ pageId: "p1", blockId: "b4", text: "Suppliers may deliver late; deliveries slip." })]);
    // Where the passage is (the pages above) never reaches the model.
    expect(outcome.content).not.toContain("Sales ›");
  });

  it("keeps the passage semantic search found", async () => {
    results.push({ id: "p1", title: "Plan", parent_id: null, snippet: "s", passage: "By meaning.", block_id: "b9" });
    chunks.set("p1", [{ blockId: "b0", position: 0, text: "Plan\n\nSupplier words." }]);
    const { sources } = await search("supplier");
    expect(sources).toEqual([expect.objectContaining({ blockId: "b9", text: "By meaning." })]);
  });

  it("cuts the passage from the body of a page that isn't indexed, without a block", async () => {
    results.push({ id: "p2", title: "Notes", parent_id: null, snippet: "…supplier list…" });
    const filler = Array.from({ length: 40 }, (_, i) => `Line ${i} about the kitchen rota.`).join("\n");
    bodies.set("p2", `${filler}\nThe supplier list is in the shared drive.\n${filler}`);
    const { sources } = await search("supplier");
    expect(sources).toEqual([expect.objectContaining({ pageId: "p2", blockId: null })]);
    expect(sources[0].text).toContain("The supplier list is in the shared drive.");
    expect(sources[0].text).not.toMatch(/^Line 0 /);
  });

  it("falls back to the snippet for a page with no text", async () => {
    results.push({ id: "p3", title: "Empty", parent_id: null, snippet: "…supplier…" });
    bodies.set("p3", "");
    const { sources } = await search("supplier");
    expect(sources).toEqual([expect.objectContaining({ pageId: "p3", blockId: null, text: "…supplier…" })]);
  });
});

describe("search_pages and archived pages", () => {
  const included = () => (searchCalls.at(-1)![1] as { include_archived?: boolean }).include_archived;

  it("leaves archived pages out, unless the chat is about an archived page", async () => {
    await search("prices");
    expect(included()).toBe(false);
    await search("prices", "live-page");
    expect(included()).toBe(false);
    outdatedScopes.add("old-page");
    await search("prices", "old-page");
    expect(included()).toBe(true);
    expect(searchCalls.at(-1)![2]).toMatchObject({ withinPageId: "old-page" });
  });
});

/**
 * CSV files attached to the conversation: read_attachment reads on from a row, and
 * create_database_from_csv shows the columns it would make, their types guessed from the values
 * unless the model gives them. create_database checks what it is asked for before asking.
 */
describe("attached files and new databases", () => {
  const file = {
    kind: "csv" as const,
    name: "orders.csv",
    headers: ["Customer", "Amount", "Due", "Paid", "Notes"],
    rows: Array.from({ length: 30 }, (_, i) => [`Customer ${i + 1}`, String((i + 1) * 10), `2026-11-${String(i + 1).padStart(2, "0")}`, i % 2 ? "yes" : "no", ""]),
  };
  const older = { kind: "csv" as const, name: "old.csv", headers: ["A"], rows: [["1"]] };
  const read = (args: Record<string, unknown>, attachments: ChatFileContent[] = [older, file]) =>
    runTool({ userId: "u" } as never, "w", undefined, { name: "read_attachment", arguments: args }, { sources: [], byKey: new Map() }, 50_000, { attachments });

  it("reads the latest file, or the one named, from a row on", async () => {
    const latest = await read({ from_row: 29 });
    expect(latest.isError).toBeUndefined();
    expect(latest.content).toMatch(/^Rows 29-30 of 30 of "orders.csv" \(the first line is the header\)\.\n<attachment name="orders.csv" rows="30" columns="5">\nCustomer,Amount,Due,Paid,Notes\nCustomer 29,290,/);
    expect((await read({ name: "OLD.csv" })).content).toContain("Rows 1-1 of 1 of \"old.csv\"");
  });

  it("reads on in a document's text from a character", async () => {
    const doc = { kind: "text" as const, name: "brief.pdf", text: "abcdefghij", partial: true };
    const out = await read({ name: "brief.pdf", from_char: 4 }, [doc, file]);
    expect(out.content).toBe('Characters 4-10 of 10 of "brief.pdf". The rest of this long document wasn\'t read.\n<attachment name="brief.pdf">\ndefghij\n</attachment>');
    expect((await read({ name: "brief.pdf", from_char: 11 }, [doc])).isError).toBe(true);
    // A database is made of CSV files only.
    const prepared = await prepareWrite({ userId: "u", actor: { userId: "u" } } as never, "w", null, { name: "create_database_from_csv", arguments: { attachment: "brief.pdf" } }, { attachments: [doc, file] });
    expect(prepared).toMatchObject({ isError: true, content: expect.stringContaining('The files: "orders.csv"') });
  });

  it("says which files there are when the one named isn't, and when there are none", async () => {
    expect(await read({ name: "nope.csv" })).toEqual({ content: 'No attached file has that name. The files: "old.csv", "orders.csv".', isError: true });
    expect(await read({}, [])).toEqual({ content: "No file is attached to this conversation.", isError: true });
    expect((await read({ from_row: 31 })).content).toBe('"orders.csv" has 30 rows.');
  });

  const prepare = (name: string, args: Record<string, unknown>, scopeId: string | null = null) =>
    prepareWrite({ userId: "u", actor: { userId: "u" } } as never, "w", scopeId, { name, arguments: args }, { attachments: [file] });

  it("shows the columns a CSV database gets, types guessed or given, before asking", async () => {
    const prepared = await prepare("create_database_from_csv", { column_types: { notes: "skip", paid: "checkbox" } });
    expect("action" in prepared && prepared.action).toMatchObject({
      action: "createDatabase",
      target: null,
      title: "orders",
      fromFile: { name: "orders.csv", rows: 30 },
      properties: [
        { name: "Customer", type: "title" },
        { name: "Amount", type: "number" },
        { name: "Due", type: "date" },
        { name: "Paid", type: "checkbox" },
      ],
    });
  });

  it("refuses columns the file doesn't have, and types it can't make", async () => {
    expect(await prepare("create_database_from_csv", { title_column: "Nope" })).toMatchObject({ isError: true, content: expect.stringContaining('the file has no column "Nope"') });
    expect(await prepare("create_database_from_csv", { column_types: { Amount: "formula" } })).toMatchObject({ isError: true, content: expect.stringContaining("column_types.Amount: use one of") });
    expect(await prepare("create_database_from_csv", { attachment: "other.csv" })).toMatchObject({ isError: true, content: expect.stringContaining('The files: "orders.csv"') });
  });

  it("checks a new database's properties before asking, and where it may go", async () => {
    const prepared = await prepare("create_database", { title: "Tasks", properties: [{ name: "Stage", type: "status" }, { name: "Priority", type: "select", options: ["High", "Low", "High", " "] }] });
    expect("action" in prepared && prepared.action).toMatchObject({
      action: "createDatabase",
      target: null,
      title: "Tasks",
      properties: [{ name: "Stage", type: "status" }, { name: "Priority", type: "select", options: ["High", "Low"] }],
    });
    expect(await prepare("create_database", { properties: [] })).toMatchObject({ content: "The change is not valid: give the database a title." });
    expect(await prepare("create_database", { title: "T", properties: [{ name: "Title", type: "text" }] })).toMatchObject({ content: expect.stringContaining('"Title" is taken') });
    expect(await prepare("create_database", { title: "T", properties: [{ name: "A", type: "text" }, { name: "a", type: "number" }] })).toMatchObject({ content: expect.stringContaining('"a" is taken') });
    expect(await prepare("create_database", { title: "T", properties: [{ name: "F", type: "formula" }] })).toMatchObject({ content: expect.stringContaining("type must be one of") });
    // Checked as every plan of databases is (lib/database-plan): a status needs a done option.
    expect(await prepare("create_database", { title: "T", properties: [{ name: "Stage", type: "status", options: ["Open"] }] })).toMatchObject({
      content: 'The change is not valid: property "Stage": a status needs at least one option in the "done" group.',
    });
    // In a page's chat, it goes under a page of that scope.
    expect(await prepare("create_database", { title: "T" }, "scope")).toMatchObject({ content: expect.stringContaining("give parent_id") });
  });
});
