import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * search_pages in the AI chat: a page the text search found without a passage gets the indexed
 * passage with the most of the query's words, cited at its block, rather than a snippet.
 */
type Result = { id: string; title: string; parent_id: string | null; snippet: string; passage?: string | null; block_id?: string | null };
const results: Result[] = [];
const chunks = new Map<string, { blockId: string | null; position: number; text: string }[]>();

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: vi.fn() }));
vi.mock("@/server/pages", () => ({ getTree: vi.fn() }));
vi.mock("@/server/databases", () => ({ normalizeRowProperties: vi.fn() }));
vi.mock("@/server/operations", () => ({ search: async () => ({ results }) }));
vi.mock("@/server/semantic-search", () => ({
  inSubtree: vi.fn(),
  chunksOfPages: async (ids: string[]) => new Map([...chunks].filter(([id]) => ids.includes(id))),
}));

const { runTool } = await import("./ai-tools");

const search = async (query: string) => {
  const registry = { sources: [], byKey: new Map() };
  const outcome = await runTool({ userId: "u" } as never, "w", undefined, { name: "search_pages", arguments: { query } }, registry, 50_000);
  return { outcome, sources: registry.sources as { pageId: string; blockId: string | null; text: string }[] };
};

beforeEach(() => {
  results.length = 0;
  chunks.clear();
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

  it("falls back to the snippet, without a block, for a page that isn't indexed", async () => {
    results.push({ id: "p2", title: "Notes", parent_id: null, snippet: "…supplier list…" });
    const { sources } = await search("supplier");
    expect(sources).toEqual([expect.objectContaining({ pageId: "p2", blockId: null, text: "…supplier list…" })]);
  });
});
