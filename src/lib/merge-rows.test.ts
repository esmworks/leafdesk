import { describe, expect, it } from "vitest";
import {
  canCombine,
  combineValues,
  COMBINE,
  defaultChoice,
  defaultKept,
  defaultTitleChoice,
  isEmptyMergeValue,
  makesBlockerLoop,
  makesParentLoop,
  MERGE_TITLE,
  MergeChoiceError,
  mergedValues,
  pairedValue,
  relinkValue,
  repointedValue,
  type MergeProperty,
  type MergeRow,
} from "./merge-rows";

const DB = "db";
const prop = (id: string, type: MergeProperty["type"], relation?: MergeProperty["options"]["relation"]): MergeProperty => ({
  id,
  name: id,
  type,
  options: relation ? { relation } : {},
});
const phone = prop("phone", "text");
const tags = prop("tags", "multi_select");
const done = prop("done", "checkbox");
const deals = prop("deals", "relation", { databaseId: "deals", pairedPropertyId: "company" });
const parent = prop("parent", "relation", { databaseId: DB, role: "parent" });
const related = prop("related", "relation", { databaseId: DB });
const formula = prop("total", "formula");

const rows: MergeRow[] = [
  { id: "a", title: "Acme", createdAt: "2026-01-01T00:00:00Z", properties: { tags: ["lead"], deals: ["d1"] } },
  { id: "b", title: "Acme Inc.", createdAt: "2026-02-01T00:00:00Z", properties: { phone: "555", tags: ["partner", "lead"], deals: ["d2", "d3"], done: true } },
  { id: "c", title: "", createdAt: "2025-12-01T00:00:00Z", properties: { phone: "556", related: ["a", "x"] } },
];
const everything = () => true;
const merge = (choices: Record<string, string> = {}, keptId = "a", canEdit: (id: string) => boolean = everything) =>
  mergedValues({ databaseId: DB, keptId, rows, properties: [phone, tags, done, deals, parent, related, formula], choices, canEdit, sees: everything });

describe("defaults", () => {
  it("keeps the oldest row", () => {
    expect(defaultKept(rows)).toBe("c");
  });

  it("takes the kept row's value, or the first other row's that has one", () => {
    expect(defaultChoice(phone, rows, "a")).toBe("b");
    expect(defaultChoice(phone, rows, "c")).toBe("c");
    expect(defaultChoice(tags, rows, "a")).toBe("a");
  });

  it("skips rows whose value the merger can't see", () => {
    expect(defaultChoice(phone, rows, "a", (id) => id !== "b")).toBe("c");
  });

  it("combines relations, but not a row's parent", () => {
    expect(defaultChoice(deals, rows, "a")).toBe(COMBINE);
    expect(canCombine(parent)).toBe(false);
    expect(canCombine(tags)).toBe(true);
    expect(canCombine(phone)).toBe(false);
  });

  it("takes the kept row's title unless it has none", () => {
    expect(defaultTitleChoice(rows, "a")).toBe("a");
    expect(defaultTitleChoice(rows, "c")).toBe("a");
  });

  it("counts an unticked checkbox as empty", () => {
    expect(isEmptyMergeValue("checkbox", false)).toBe(true);
    expect(isEmptyMergeValue("checkbox", true)).toBe(false);
    expect(isEmptyMergeValue("text", "")).toBe(true);
    expect(isEmptyMergeValue("multi_select", [])).toBe(true);
  });
});

describe("mergedValues", () => {
  it("takes the values picked, combines lists and fills in empty ones", () => {
    const out = merge({ [MERGE_TITLE]: "b", phone: "c", tags: COMBINE });
    expect(out.title).toBe("Acme Inc.");
    expect(out.properties.phone).toBe("556");
    expect(out.properties.tags).toEqual(["lead", "partner"]);
    expect(out.properties.deals).toEqual(["d1", "d2", "d3"]);
    expect(out.properties.done).toBe(true);
  });

  it("drops a value picked from a row that has none", () => {
    const out = merge({ tags: "c" });
    expect(out.properties).not.toHaveProperty("tags");
  });

  it("leaves what the merger may not edit as the kept row has it", () => {
    const out = merge({ phone: "b", tags: "b" }, "a", (id) => id !== "tags");
    expect(out.properties.phone).toBe("555");
    expect(out.properties.tags).toEqual(["lead"]);
    expect(out.choices.tags).toBe("a");
  });

  it("points links between the merged rows at the kept one, never at itself", () => {
    const out = merge({ related: "c" });
    expect(out.properties.related).toEqual(["x"]);
  });

  it("refuses values from outside the merge, and combining what isn't a list", () => {
    expect(() => merge({ phone: "z" })).toThrow(MergeChoiceError);
    expect(() => merge({ phone: COMBINE })).toThrow(MergeChoiceError);
    expect(() => merge({ [MERGE_TITLE]: COMBINE })).toThrow(MergeChoiceError);
  });

  it("refuses a value the merger can't see", () => {
    expect(() =>
      mergedValues({ databaseId: DB, keptId: "a", rows, properties: [phone], choices: { phone: "b" }, canEdit: everything, sees: (_p, row) => row !== "b" }),
    ).toThrow(MergeChoiceError);
  });

  it("leaves values worked out from the row alone", () => {
    expect(merge().choices).not.toHaveProperty("total");
  });
});

describe("combineValues", () => {
  it("lists files once each", () => {
    const one = { name: "a.pdf", type: "application/pdf", url: `/api/files/${"a".repeat(24)}` };
    const two = { name: "b.pdf", type: "application/pdf", url: `/api/files/${"b".repeat(24)}` };
    expect(combineValues("files", [[one], [one, two]])).toHaveLength(2);
  });

  it("keeps a checklist item once, and gives a different one with the same id an id of its own", () => {
    const out = combineValues("checklist", [
      [{ id: "1", text: "Call", checked: false }],
      [
        { id: "1", text: "Call", checked: false },
        { id: "1", text: "Email", checked: true },
      ],
    ]) as { id: string; text: string }[];
    expect(out.map((i) => i.text)).toEqual(["Call", "Email"]);
    expect(new Set(out.map((i) => i.id)).size).toBe(2);
  });

  it("is empty when no row holds anything", () => {
    expect(combineValues("person", [null, []])).toBeNull();
  });
});

describe("links of other rows", () => {
  const merged = new Set(["b", "c"]);
  it("two-way: lists the kept row once when the kept row lists it", () => {
    expect(pairedValue(["b", "c", "z"], merged, "a", true)).toEqual(["z", "a"]);
    expect(pairedValue(["a", "b"], merged, "a", false)).toEqual([]);
  });

  it("one-way: links to the merged rows point at the kept one", () => {
    expect(repointedValue(["b", "a", "z", "c"], merged, "a")).toEqual(["a", "z"]);
    expect(relinkValue(["b", "z"], merged, "a")).toEqual(["z"]);
  });

  it("finds loops of parents and blockers", () => {
    expect(makesParentLoop(new Map([["a", "b"], ["b", "a"]]))).toBe(true);
    expect(makesParentLoop(new Map([["a", "b"], ["b", null]]))).toBe(false);
    expect(makesBlockerLoop(new Map([["a", ["b"]], ["b", ["a"]]]))).toBe(true);
    expect(makesBlockerLoop(new Map([["a", ["b"]], ["b", []]]))).toBe(false);
  });
});
