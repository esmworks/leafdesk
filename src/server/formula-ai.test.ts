/**
 * Writing a formula from a description (formula-ai.ts): only for someone who may change the
 * database's properties and only with AI on; the prompt names the properties the person may know of
 * (a related database's only when they may open it) and the engine's functions; the answer is
 * checked like a typed formula, sent back once with its error, and comes with a preview; and the
 * request counts as the formulas' AI usage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileFormulas, formulaForStorage } from "@/lib/derived";
import { FORMULA_FUNCTIONS } from "@/lib/formula";
import { FUNCTION_NOTES, formulaReference } from "@/lib/formula/reference";
import { AiError } from "@/server/ai";
import { formulaAnswer, formulaPrompt } from "@/server/ai/prompts";
import { installFauxAi, resetAi } from "@/server/ai/testing";
import { memoryAiUsageLedger } from "@/server/ai/usage";
import { suggestFormula } from "./formula-ai";

const aiOn = vi.hoisted(() => ({ value: true }));
const previews = vi.hoisted(() => ({ calls: [] as { stored: string; type: string }[] }));

class NotAllowed extends Error {}

type Prop = { id: string; name: string; type: string; options: Record<string, unknown> };

// The tasks database as the person may know it: the salary column is hidden from them, so it is
// not among their known properties.
const TASKS: Prop[] = [
  { id: "due", name: "Due", type: "date", options: {} },
  { id: "done", name: "Done", type: "checkbox", options: {} },
  { id: "stage", name: "Stage", type: "select", options: { options: [{ id: "o1", name: "Open" }, { id: "o2", name: "Closed" }] } },
  { id: "price", name: "Price", type: "number", options: {} },
  { id: "qty", name: "Qty", type: "number", options: {} },
  { id: "client", name: "Client", type: "relation", options: { relation: { databaseId: "clients" } } },
  { id: "total", name: "Total", type: "formula", options: { formula: { expression: 'prop("price") * prop("qty")', type: "number" } } },
];

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/ai-writing", () => ({ aiAvailable: async () => aiOn.value }));
vi.mock("@/server/databases", () => ({
  requireDatabase: async (userId: string, id: string, level: string) => {
    if (id === "tasks" && (level === "view" || userId !== "viewer")) return { id, kind: "database", workspaceId: "ws" };
    // Only the owner may open the clients database.
    if (id === "clients" && userId === "owner") return { id, kind: "database", workspaceId: "ws" };
    throw new NotAllowed("No access");
  },
  knownProperties: async (_userId: string, id: string) =>
    id === "tasks" ? TASKS : id === "clients" ? [{ id: "region", name: "Region", type: "text", options: {} }] : [],
  // The check as databases.checkFormula does it, without related schemas.
  checkFormula: async (_userId: string, expression: string, properties: Prop[], self: { id: string; name: string }, titleNames: string[]) => {
    const others = properties.filter((p) => p.id !== self.id);
    const stored = formulaForStorage(expression.trim(), [...others, self] as never, titleNames);
    const compiled = compileFormulas([...others, { ...self, type: "formula", options: { formula: { expression: stored } } }] as never).get(self.id);
    return { stored, type: compiled?.type ?? "text", error: compiled?.error ?? null };
  },
  previewFormula: async (_userId: string, _databaseId: string, _self: unknown, stored: string, type: string) => {
    previews.calls.push({ stored, type });
    return [
      { id: "r1", title: "Kickoff", value: 12, hidden: false },
      { id: "r2", title: "Review", value: null, hidden: false },
    ];
  },
}));

let ledger: ReturnType<typeof memoryAiUsageLedger>;
let requests: { system: string; prompt: string }[];
let answers: string[];

beforeEach(() => {
  aiOn.value = true;
  previews.calls = [];
  requests = [];
  answers = [];
  ledger = memoryAiUsageLedger();
  installFauxAi(
    (request) => {
      requests.push(request);
      return answers.shift() ?? 'prop("Price")';
    },
    { usage: ledger },
  );
});

afterEach(() => resetAi());

const ask = (userId: string, description: string, extra: Partial<Parameters<typeof suggestFormula>[1]> = {}) =>
  suggestFormula(userId, { databaseId: "tasks", propertyId: null, name: "Days left", description, titleName: "Name", ...extra });

describe("suggestFormula", () => {
  it("writes a checked formula, with property names, and what it gives on the first rows", async () => {
    answers = ['```\ndateBetween(prop("Due"), today(), "days")\n```'];
    const result = await ask("owner", "days left until it is due");
    expect(result).toEqual({
      expression: 'dateBetween(prop("Due"), today(), "days")',
      type: "number",
      error: null,
      preview: [
        { id: "r1", title: "Kickoff", value: 12, hidden: false },
        { id: "r2", title: "Review", value: null, hidden: false },
      ],
    });
    // The preview works out the formula as stored, with ids.
    expect(previews.calls).toEqual([{ stored: 'dateBetween(prop("due"), today(), "days")', type: "number" }]);
    expect(requests).toHaveLength(1);
  });

  it("tells the AI the language and the properties the person may know of, names and types only", async () => {
    await ask("owner", "days left until it is due");
    const [{ system, prompt }] = requests;
    expect(system).toContain("dateBetween(");
    expect(system).toContain('prop("Name")');
    expect(prompt).toContain('"Days left"');
    expect(prompt).toContain('- "Due"; date');
    expect(prompt).toContain('- "Stage"; select, reads as text; options: "Open", "Closed"');
    expect(prompt).toContain('- "Total"; formula, reads as number');
    // A related database the person may open: its properties too.
    expect(prompt).toContain('its rows\' properties: "Region" (text)');
    expect(prompt).toContain("<description>\ndays left until it is due\n</description>");
    expect(prompt).not.toMatch(/Salary/);
  });

  it("names a related database's properties only to someone who may open it", async () => {
    await ask("owner", "the client's region");
    expect(requests[0].prompt).toContain('"Region"');
    // An editor of the tasks who may not open the clients: the relation, but not its rows' properties.
    requests = [];
    await ask("editor", "the client's region");
    expect(requests[0].prompt).toContain('- "Client"; relation');
    expect(requests[0].prompt).not.toContain("Region");
  });

  it("sends a formula that doesn't work back once with its error, and takes the second", async () => {
    answers = ['prop("Cost") * 2', 'prop("Price") * 2'];
    const result = await ask("owner", "twice the price");
    expect(result).toMatchObject({ expression: 'prop("Price") * 2', type: "number", error: null });
    expect(requests).toHaveLength(2);
    expect(requests[1].prompt).toMatch(/That formula doesn't work: .*Cost/);
  });

  it("gives the error, not a suggestion, when the second try fails too", async () => {
    answers = ['prop("Cost") * 2', 'prop("Price") + "x" + ('];
    const result = await ask("owner", "twice the price");
    expect(result.error).not.toBeNull();
    expect(result).toMatchObject({ expression: 'prop("Price") + "x" + (', type: null, preview: [] });
    expect(requests).toHaveLength(2);
    expect(previews.calls).toHaveLength(0);
  });

  it("reads the Name column's label and \"title\" as the row's title", async () => {
    answers = ['prop("Name") + " (" + format(prop("Qty")) + ")"'];
    const result = await ask("owner", "the name with the quantity");
    expect(result).toMatchObject({ type: "text", error: null });
    expect(previews.calls[0].stored).toBe('prop("title") + " (" + format(prop("qty")) + ")"');
  });

  it("refuses without AI, without the right to change the database and without a description", async () => {
    aiOn.value = false;
    await expect(ask("owner", "days left")).rejects.toMatchObject({ code: "disabled" });
    aiOn.value = true;
    await expect(ask("viewer", "days left")).rejects.toThrow(NotAllowed);
    await expect(ask("owner", "   ")).rejects.toBeInstanceOf(AiError);
    expect(requests).toHaveLength(0);
  });

  it("refuses an answer with no formula in it", async () => {
    answers = ["```\n```"];
    await expect(ask("owner", "days left")).rejects.toMatchObject({ code: "empty" });
  });

  it("counts the requests as the person's formula writing", async () => {
    answers = ['prop("Cost")', 'prop("Price")'];
    await ask("owner", "the price");
    expect(ledger.rows.map((r) => [r.feature, r.requests])).toEqual([["formula.write", 2]]);
    expect(ledger.people.map((p) => p.userId)).toEqual(["owner", "owner"]);
  });

  it("is held to the workspace's limits", async () => {
    const limited = memoryAiUsageLedger({ ws: 0 });
    installFauxAi(() => 'prop("Price")', { usage: limited });
    await expect(ask("owner", "the price")).rejects.toMatchObject({ code: "limitReached" });
  });
});

describe("formulaAnswer", () => {
  it("takes the formula out of a fence, a label or backticks", () => {
    expect(formulaAnswer('```formula\nprop("A") + 1\n```')).toBe('prop("A") + 1');
    expect(formulaAnswer('Here it is:\n```\nprop("A")\n```\nThat works.')).toBe('prop("A")');
    expect(formulaAnswer('Formula: prop("A") * 2')).toBe('prop("A") * 2');
    expect(formulaAnswer('`prop("A")`')).toBe('prop("A")');
    expect(formulaAnswer('  if(prop("Done"), "✓", "")  ')).toBe('if(prop("Done"), "✓", "")');
    expect(formulaAnswer("")).toBe("");
  });
});

describe("formulaPrompt", () => {
  it("quotes names as formulas write them", () => {
    const { prompt } = formulaPrompt({
      description: "x",
      name: 'The "best"',
      properties: [{ name: 'Size "XL"', type: "select", reads: "text", options: ['A "b"'] }],
      reference: "",
      today: "2026-10-24",
    });
    expect(prompt).toContain('- "Size \\"XL\\""; select, reads as text; options: "A \\"b\\""');
    expect(prompt).toContain("Today is 2026-10-24.");
  });
});

describe("formulaReference", () => {
  it("lists every function of the engine, and notes only functions it has", () => {
    const reference = formulaReference();
    for (const f of FORMULA_FUNCTIONS) expect(reference).toContain(f.signature);
    const names = new Set(FORMULA_FUNCTIONS.map((f) => f.name));
    expect(Object.keys(FUNCTION_NOTES).filter((name) => !names.has(name))).toEqual([]);
  });
});
