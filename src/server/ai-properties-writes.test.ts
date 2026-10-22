import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How AI autofill values reach the rest of the app: saved like any row write (activity,
 * automations, row listeners) and followed up only by the AI values reading them.
 */
const stored = { properties: {} as Record<string, unknown>, inTemplate: false };
const updates: Record<string, unknown>[] = [];
const afterRowWrites = vi.fn();
const rowChanged = vi.fn();

vi.mock("@/db", () => {
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ for: async () => [{ ...stored, properties: { ...stored.properties } }] }) }) }),
    update: () => ({
      set: (values: { properties: Record<string, unknown> }) => ({
        where: async () => {
          updates.push(values.properties);
        },
      }),
    }),
  };
  return { db: { transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } };
});
vi.mock("@/server/collab/bridge", () => ({ getCollab: vi.fn() }));
vi.mock("@/server/row-events", () => ({ onRowChanged: vi.fn(), rowChanged }));
vi.mock("@/server/databases", () => ({ afterRowWrites }));

const { autofillOutput, followUpTargets, mergeFollowUp, requirementsMet, saveValue } = await import("./ai-properties");

type Prop = Parameters<typeof followUpTargets>[0][number];
const prop = (id: string, name: string, type: string, options: Record<string, unknown> = {}) =>
  ({ id, name, type, options, databaseId: "db" }) as unknown as Prop;
const ai = (id: string, name: string, config: Record<string, unknown>) => prop(id, name, "text", { ai: { auto: true, ...config } });

beforeEach(() => {
  stored.properties = { notes: "Hello" };
  stored.inTemplate = false;
  updates.length = 0;
  afterRowWrites.mockClear();
  rowChanged.mockClear();
});

describe("saveValue", () => {
  const job = { rowId: "row", databaseId: "db", userId: "ada", chain: ["summary"] };

  it("saves a new value as an AI row write: activity and automations, then the row listeners", async () => {
    expect(await saveValue(job, "category", "Billing")).toBe(true);
    expect(updates).toEqual([{ notes: "Hello", category: "Billing" }]);
    expect(afterRowWrites).toHaveBeenCalledWith("ada", "db", [
      { rowId: "row", before: { notes: "Hello" }, after: { notes: "Hello", category: "Billing" } },
    ], { ai: true });
    expect(rowChanged).toHaveBeenCalledWith({
      rowId: "row",
      databaseId: "db",
      userId: "ada",
      autofill: { propertyId: "category", chain: ["summary", "category"] },
    });
  });

  it("changes nothing when the value is the one stored", async () => {
    stored.properties = { category: "Billing" };
    expect(await saveValue(job, "category", "Billing")).toBe(false);
    expect(updates).toEqual([]);
    expect(afterRowWrites).not.toHaveBeenCalled();
    expect(rowChanged).not.toHaveBeenCalled();
  });

  it("clears the value when there is nothing to fill in", async () => {
    stored.properties = { category: "Billing" };
    expect(await saveValue(job, "category", "")).toBe(true);
    expect(updates).toEqual([{}]);
  });

  it("saves values of other types as stored, and compares them as such", async () => {
    expect(await saveValue(job, "tags", ["opt1", "opt2"])).toBe(true);
    expect(updates.at(-1)).toEqual({ notes: "Hello", tags: ["opt1", "opt2"] });
    stored.properties = { tags: ["opt1", "opt2"], score: 0, done: false };
    expect(await saveValue(job, "tags", ["opt1", "opt2"])).toBe(false);
    expect(await saveValue(job, "score", 0)).toBe(false);
    expect(await saveValue(job, "done", false)).toBe(false);
    expect(await saveValue(job, "done", true)).toBe(true);
    expect(await saveValue(job, "score", null)).toBe(true);
    expect(updates.at(-1)).toEqual({ tags: ["opt1", "opt2"], done: false });
  });

  it("sets nothing off for rows of a database kept as a template", async () => {
    stored.inTemplate = true;
    await saveValue(job, "category", "Billing");
    expect(afterRowWrites).not.toHaveBeenCalled();
    expect(rowChanged).toHaveBeenCalled();
  });
});

describe("typed values", () => {
  it("asks for what the property's type holds", () => {
    expect(autofillOutput(prop("p", "Genre", "select", { options: [{ id: "o1", name: "Romance" }] }))).toEqual({ type: "select", options: ["Romance"] });
    expect(autofillOutput(prop("p", "Share", "number", { number: { format: "percent" } }))).toEqual({ type: "number", percent: true });
    expect(autofillOutput(prop("p", "Pages", "number"))).toEqual({ type: "number" });
    expect(autofillOutput(prop("p", "Notes", "text"))).toEqual({ type: "text" });
  });

  it("waits for values the prompt may read", () => {
    const existing = new Set(["notes", "who", "secret"]);
    const inputs = new Set(["notes"]);
    expect(requirementsMet(undefined, existing, inputs, {})).toBe(true);
    expect(requirementsMet(["notes"], existing, inputs, { notes: "Hi" })).toBe(true);
    expect(requirementsMet(["notes"], existing, inputs, { notes: " " })).toBe(false);
    // Related rows, people and restricted values count as empty, whoever may see them.
    expect(requirementsMet(["who"], existing, inputs, { who: ["ada"] })).toBe(false);
    // A property deleted since is no longer waited for.
    expect(requirementsMet(["gone", "notes"], existing, inputs, { notes: "Hi" })).toBe(true);
  });
});

describe("follow-ups", () => {
  // Summary reads the row; Category reads Summary through a formula; Tone reads the row only.
  const props = [
    prop("notes", "Notes", "text"),
    ai("summary", "Summary", { mode: "summary" }),
    prop("short", "Short", "formula", { formula: { expression: 'prop("summary")' } }),
    ai("category", "Category", { mode: "custom", prompt: "Classify {Short}" }),
    ai("tone", "Tone", { mode: "custom", prompt: "Tone of {Notes}" }),
    prop("manual", "Manual", "text", { ai: { mode: "summary", auto: false } }),
  ];
  const ids = (found: { property: Prop }[]) => found.map((t) => t.property.id);
  const change = (autofill?: { propertyId: string; chain: string[] }) => ({ rowId: "row", databaseId: "db", userId: "ada", autofill });

  it("updates every automatic value after a person's change", () => {
    const scope = mergeFollowUp(undefined, change(), false);
    expect(ids(followUpTargets(props, scope))).toEqual(["summary", "category", "tone"]);
  });

  it("after an AI value, updates only the values reading it", () => {
    const scope = mergeFollowUp(undefined, change({ propertyId: "summary", chain: ["summary"] }), false);
    expect(followUpTargets(props, scope).map((t) => t.chain)).toEqual([["summary"]]);
    expect(ids(followUpTargets(props, scope))).toEqual(["category"]);
    // Category's own value is read by no one: the cascade ends there.
    const next = mergeFollowUp(undefined, change({ propertyId: "category", chain: ["summary", "category"] }), false);
    expect(ids(followUpTargets(props, next))).toEqual([]);
  });

  it("never updates a value its cascade wrote already, even when values read each other", () => {
    // Settings stored before loops were refused: Summary and Category read each other.
    const looped = [ai("summary", "Summary", { mode: "custom", prompt: "Sum up {Category}" }), ai("category", "Category", { mode: "custom", prompt: "Classify {Summary}" })];
    const first = mergeFollowUp(undefined, change({ propertyId: "summary", chain: ["summary"] }), false);
    expect(ids(followUpTargets(looped, first))).toEqual(["category"]);
    const second = mergeFollowUp(undefined, change({ propertyId: "category", chain: ["summary", "category"] }), false);
    expect(ids(followUpTargets(looped, second))).toEqual([]);
  });

  it("keeps a person's change broad when an AI value lands while the row settles", () => {
    const person = mergeFollowUp(undefined, change(), false);
    const both = mergeFollowUp(person, change({ propertyId: "summary", chain: ["summary"] }), false);
    expect(both.broad).toBe(true);
    expect(ids(followUpTargets(props, both))).toEqual(["summary", "category", "tone"]);
  });

  it("keeps the cascades of AI values written while the row settles apart", () => {
    // A person's change updated Summary and Category side by side; Category read the old Summary.
    const one = mergeFollowUp(undefined, change({ propertyId: "summary", chain: ["summary"] }), false);
    const two = mergeFollowUp(one, change({ propertyId: "category", chain: ["category"] }), false);
    expect(two.broad).toBe(false);
    // Category wrote itself in its own cascade, not Summary's: it still updates after Summary.
    expect(followUpTargets(props, two)).toEqual([{ property: props[3], chain: ["summary"] }]);
  });

  it("runs as an automation only when every change was an automation's", () => {
    const byAutomation = mergeFollowUp(undefined, change(), true);
    expect(byAutomation.fromAutomation).toBe(true);
    expect(mergeFollowUp(byAutomation, change(), false).fromAutomation).toBe(false);
    expect(mergeFollowUp(mergeFollowUp(undefined, change(), false), change(), true).fromAutomation).toBe(false);
  });
});
