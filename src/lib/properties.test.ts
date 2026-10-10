import { describe, expect, it } from "vitest";
import type { ChecklistItem, FilterRule, PropertyOptions, PropertyType } from "@/db/schema/app";
import {
  applyView,
  boardGroupProperty,
  checklistProgress,
  computedValues,
  isGroupable,
  localDay,
  makeStatusOptions,
  phoneHref,
  sortStatusOptions,
  groupRowsByPerson,
  movePersonValue,
  newAssignees,
  defaultsFromFilters,
  displayValue,
  filterNeedsValue,
  filterOperators,
  groupRows,
  hiddenByDefault,
  isHiddenInView,
  orderGroups,
  orderProperties,
  moveProperty,
  toggleHiddenInView,
  isSortable,
  normalizeValue,
  positionBetween,
  PropertyValueError,
  type RowLike,
} from "./properties";

const prop = (type: PropertyType, options: PropertyOptions = {}) => ({ id: `p_${type}`, name: type, type, options });

const status = prop("select", {
  options: [
    { id: "o1", name: "Not started", color: "gray" },
    { id: "o2", name: "In progress", color: "blue" },
    { id: "o3", name: "Done", color: "green" },
  ],
});
const tags = prop("multi_select", {
  options: [
    { id: "t1", name: "Bug", color: "red" },
    { id: "t2", name: "UI", color: "purple" },
  ],
});

describe("normalizeValue", () => {
  it("clears on empty input", () => {
    expect(normalizeValue(prop("text"), "")).toBeNull();
    expect(normalizeValue(prop("number"), null)).toBeNull();
    expect(normalizeValue(prop("select"), undefined)).toBeNull();
  });

  it("parses numbers including comma decimals", () => {
    expect(normalizeValue(prop("number"), "3,5")).toBe(3.5);
    expect(normalizeValue(prop("number"), 7)).toBe(7);
    expect(() => normalizeValue(prop("number"), "abc")).toThrow(PropertyValueError);
  });

  it("validates urls", () => {
    expect(normalizeValue(prop("url"), " https://example.com ")).toBe("https://example.com");
    expect(normalizeValue(prop("url"), "mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(() => normalizeValue(prop("url"), "example.com")).toThrow(PropertyValueError);
  });

  it("accepts booleans and their string forms for checkboxes", () => {
    expect(normalizeValue(prop("checkbox"), true)).toBe(true);
    expect(normalizeValue(prop("checkbox"), "false")).toBe(false);
    expect(() => normalizeValue(prop("checkbox"), "yes")).toThrow(PropertyValueError);
  });

  it("keeps days as they are and stores times and ranges in ISO form", () => {
    expect(normalizeValue(prop("date"), "2026-09-26")).toBe("2026-09-26");
    expect(normalizeValue(prop("date"), "2026-09-26T10:00:00+03:00")).toBe("2026-09-26T07:00:00.000Z");
    expect(normalizeValue(prop("date"), { start: "2026-09-26", end: "2026-09-28" })).toBe("2026-09-26/2026-09-28");
    expect(() => normalizeValue(prop("date"), "26/09/2026")).toThrow(PropertyValueError);
    expect(() => normalizeValue(prop("date"), "2026-09-28/2026-09-26")).toThrow(PropertyValueError);
    expect(() => normalizeValue(prop("date"), "2026-09-26T10:00")).toThrow(PropertyValueError);
  });

  it("sorts dates by where they start", () => {
    const rows = ["2026-09-27", "2026-09-25/2026-09-30", "2026-09-26T10:00:00.000Z", "2026-09-26"].map((d, i) => ({
      id: String(i),
      title: d,
      properties: { p_date: d },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
    const sorted = applyView(rows, { sorts: [{ propertyId: "p_date", direction: "asc" }] }, [prop("date")]).map((r) => r.title);
    expect(sorted.slice(0, 2)).toEqual(["2026-09-25/2026-09-30", "2026-09-26"]);
    expect(sorted[3]).toBe("2026-09-27");
  });

  it("resolves select values by id or case-insensitive name", () => {
    expect(normalizeValue(status, "o2")).toBe("o2");
    expect(normalizeValue(status, "done")).toBe("o3");
    expect(() => normalizeValue(status, "Blocked")).toThrow(PropertyValueError);
    expect(normalizeValue(tags, ["Bug", "t2"])).toEqual(["t1", "t2"]);
    expect(normalizeValue(tags, "ui")).toEqual(["t2"]);
  });
});

describe("displayValue", () => {
  it("maps option ids to names", () => {
    expect(displayValue(status, "o3")).toBe("Done");
    expect(displayValue(tags, ["t1", "missing", "t2"])).toEqual(["Bug", "UI"]);
    expect(displayValue(prop("number"), 4)).toBe(4);
    expect(displayValue(status, null)).toBeNull();
  });
});

const row = (id: string, title: string, properties: Record<string, unknown> = {}, day = 1): RowLike => ({
  id,
  title,
  properties,
  createdAt: new Date(Date.UTC(2026, 0, day)),
  updatedAt: new Date(Date.UTC(2026, 0, day)),
});

describe("applyView", () => {
  const rows = [
    row("a", "Alpha", { p_number: 3, p_select: "o3", p_checkbox: true, p_multi_select: ["t1"] }, 1),
    row("b", "beta", { p_number: 10, p_select: "o1", p_checkbox: false }, 2),
    row("c", "Gamma", { p_select: "o2", p_multi_select: ["t1", "t2"] }, 3),
    row("d", "", {}, 4),
  ];
  const props = [prop("number"), status, prop("checkbox"), tags];

  it("filters by title contains, case-insensitively", () => {
    const out = applyView(rows, { filters: [{ propertyId: "title", op: "contains", value: "A" }] });
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("filters numbers with gt/lt", () => {
    expect(applyView(rows, { filters: [{ propertyId: "p_number", op: "gt", value: 5 }] }).map((r) => r.id)).toEqual(["b"]);
    expect(applyView(rows, { filters: [{ propertyId: "p_number", op: "lt", value: "5" }] }).map((r) => r.id)).toEqual(["a"]);
  });

  it("filters percentages in percent points and sorts them by value", () => {
    const share = prop("number", { number: { format: "percent" } });
    const shares = [row("a", "A", { p_number: 0.07 }), row("b", "B", { p_number: 0.5 }), row("c", "C", {})];
    const ids = (filters: FilterRule[]) => applyView(shares, { filters }, [share]).map((r) => r.id);
    expect(ids([{ propertyId: "p_number", op: "equals", value: 7 }])).toEqual(["a"]);
    expect(ids([{ propertyId: "p_number", op: "gt", value: 10 }])).toEqual(["b"]);
    expect(ids([{ propertyId: "p_number", op: "lt", value: 0.5 }])).toEqual([]);
    const sorted = applyView(shares, { sorts: [{ propertyId: "p_number", direction: "desc" }] }, [share]);
    expect(sorted.map((r) => r.id)).toEqual(["b", "a", "c"]);
    // A currency is only how the amount shows.
    const price = prop("number", { number: { format: "currency", currency: "TRY" } });
    expect(applyView(shares, { filters: [{ propertyId: "p_number", op: "gt", value: 0.1 }] }, [price]).map((r) => r.id)).toEqual(["b"]);
  });

  it("treats unchecked and untouched checkboxes as empty", () => {
    const unchecked = applyView(rows, { filters: [{ propertyId: "p_checkbox", op: "is_empty" }] });
    expect(unchecked.map((r) => r.id)).toEqual(["b", "c", "d"]);
    const checked = applyView(rows, { filters: [{ propertyId: "p_checkbox", op: "is_not_empty" }] });
    expect(checked.map((r) => r.id)).toEqual(["a"]);
  });

  it("matches multi-select contains / does not contain by option id", () => {
    const has = applyView(rows, { filters: [{ propertyId: "p_multi_select", op: "contains", value: "t2" }] });
    expect(has.map((r) => r.id)).toEqual(["c"]);
    const not = applyView(rows, { filters: [{ propertyId: "p_multi_select", op: "not_equals", value: "t1" }] });
    expect(not.map((r) => r.id)).toEqual(["b", "d"]);
  });

  it("combines filters with AND", () => {
    const out = applyView(rows, {
      filters: [
        { propertyId: "title", op: "is_not_empty" },
        { propertyId: "p_select", op: "not_equals", value: "o1" },
      ],
    });
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("sorts selects by option order and keeps empties last in both directions", () => {
    const asc = applyView(rows, { sorts: [{ propertyId: "p_select", direction: "asc" }] }, props);
    expect(asc.map((r) => r.id)).toEqual(["b", "c", "a", "d"]);
    const desc = applyView(rows, { sorts: [{ propertyId: "p_select", direction: "desc" }] }, props);
    expect(desc.map((r) => r.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("sorts titles naturally and by creation time", () => {
    const byTitle = applyView(rows, { sorts: [{ propertyId: "title", direction: "asc" }] });
    expect(byTitle.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    const newest = applyView(rows, { sorts: [{ propertyId: "created_at", direction: "desc" }] });
    expect(newest.map((r) => r.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("sorts checkboxes both ways", () => {
    const asc = applyView(rows, { sorts: [{ propertyId: "p_checkbox", direction: "asc" }] }, props);
    expect(asc.map((r) => r.id)).toEqual(["b", "c", "d", "a"]);
    const desc = applyView(rows, { sorts: [{ propertyId: "p_checkbox", direction: "desc" }] }, props);
    expect(desc.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("sorts multi-selects by option order, not by option id", () => {
    const opts = prop("multi_select", {
      options: [
        { id: "zz", name: "First", color: "red" },
        { id: "aa", name: "Second", color: "blue" },
      ],
    });
    const list = [row("x", "x", { p_multi_select: ["aa"] }, 1), row("y", "y", { p_multi_select: ["zz"] }, 2), row("z", "z", {}, 3)];
    const asc = applyView(list, { sorts: [{ propertyId: "p_multi_select", direction: "asc" }] }, [opts]);
    expect(asc.map((r) => r.id)).toEqual(["y", "x", "z"]);
    const desc = applyView(list, { sorts: [{ propertyId: "p_multi_select", direction: "desc" }] }, [opts]);
    expect(desc.map((r) => r.id)).toEqual(["x", "y", "z"]);
  });

  it("ignores rules the editor hasn't filled in yet", () => {
    const out = applyView(rows, { filters: [{ propertyId: "p_select", op: "equals" }] }, props);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("treats ids of deleted options as empty", () => {
    const stale = [row("s", "s", { p_select: "gone", p_multi_select: ["gone"] }, 1), ...rows];
    const noStatus = applyView(stale, { filters: [{ propertyId: "p_select", op: "is_empty" }] }, props);
    expect(noStatus.map((r) => r.id)).toEqual(["s", "d"]);
    const noTags = applyView(stale, { filters: [{ propertyId: "p_multi_select", op: "is_empty" }] }, props);
    expect(noTags.map((r) => r.id)).toEqual(["s", "b", "d"]);
  });

  it("does not mutate the input", () => {
    const copy = [...rows];
    applyView(rows, { sorts: [{ propertyId: "title", direction: "desc" }] });
    expect(rows).toEqual(copy);
  });
});

describe("filterOperators", () => {
  it("offers type-appropriate operators", () => {
    expect(filterOperators("checkbox").map((o) => o.op)).toEqual(["is_not_empty", "is_empty"]);
    expect(filterOperators("number").map((o) => o.op)).toContain("gt");
    expect(filterOperators("select").map((o) => o.op)).not.toContain("contains");
    expect(filterOperators("title")[0].op).toBe("contains");
  });

  it("knows which operators need a value", () => {
    expect(filterNeedsValue("contains")).toBe(true);
    expect(filterNeedsValue("is_empty")).toBe(false);
    expect(filterNeedsValue("is_not_empty")).toBe(false);
  });
});

describe("positionBetween", () => {
  it("returns a value strictly between neighbours", () => {
    expect(positionBetween(1, 2)).toBe(1.5);
    expect(positionBetween(5, null)).toBe(6);
    expect(positionBetween(undefined, 3)).toBe(2);
    expect(positionBetween()).toBe(1);
  });
});

describe("groupRows", () => {
  it("buckets by option order with an empty group first, preserving row order", () => {
    const rows = [
      row("a", "A", { p_select: "o3" }),
      row("b", "B", {}),
      row("c", "C", { p_select: "o1" }),
      row("d", "D", { p_select: "o3" }),
      row("e", "E", { p_select: "deleted-option" }),
    ];
    const groups = groupRows(rows, status);
    expect(groups.map((g) => g.option?.name ?? null)).toEqual([null, "Not started", "In progress", "Done"]);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([["b", "e"], ["c"], [], ["a", "d"]]);
  });
});

describe("relation values", () => {
  const rel = prop("relation", { relation: { databaseId: "db-2" } });

  it("keeps row references in order without duplicates and clears when empty", () => {
    expect(normalizeValue(rel, ["r2", " r1 ", "r2"])).toEqual(["r2", "r1"]);
    expect(normalizeValue(rel, "r1")).toEqual(["r1"]);
    expect(normalizeValue(rel, [])).toBeNull();
    expect(normalizeValue(rel, ["", " "])).toBeNull();
  });

  it("rejects values that are not row references", () => {
    expect(() => normalizeValue(rel, [1, 2])).toThrow(PropertyValueError);
    expect(() => normalizeValue(rel, true)).toThrow(PropertyValueError);
  });

  it("filters by linked row and is not sortable", () => {
    expect(filterOperators("relation").map((o) => o.op)).toEqual(["contains", "not_equals", "is_empty", "is_not_empty"]);
    expect(isSortable("relation")).toBe(false);
    expect(isSortable("date")).toBe(true);
    const rows = [row("a", "A", { p_relation: ["r1", "r2"] }), row("b", "B", { p_relation: ["r3"] }), row("c", "C")];
    const ids = (filters: FilterRule[]) => applyView(rows, { filters }).map((r) => r.id);
    expect(ids([{ propertyId: "p_relation", op: "contains", value: "r2" }])).toEqual(["a"]);
    expect(ids([{ propertyId: "p_relation", op: "not_equals", value: "r2" }])).toEqual(["b", "c"]);
    expect(ids([{ propertyId: "p_relation", op: "is_empty" }])).toEqual(["c"]);
  });
});

describe("view visibility", () => {
  const text = { id: "t", type: "text" as const };
  const sel = { id: "s", type: "select" as const };

  it("hides text and numbers on boards until shown", () => {
    expect(hiddenByDefault("board", "number")).toBe(true);
    expect(hiddenByDefault("table", "text")).toBe(false);
    expect(isHiddenInView({ type: "board", config: {} }, text)).toBe(true);
    expect(isHiddenInView({ type: "board", config: {} }, sel)).toBe(false);
    expect(isHiddenInView({ type: "table", config: {} }, text)).toBe(false);
    expect(isHiddenInView({ type: "board", config: { shown: ["t"] } }, text)).toBe(false);
  });

  it("shows only chosen properties on list rows and timeline bars, and hides long values on gallery cards", () => {
    expect(isHiddenInView({ type: "list", config: {} }, sel)).toBe(true);
    expect(isHiddenInView({ type: "timeline", config: {} }, sel)).toBe(true);
    expect(isHiddenInView({ type: "chart", config: {} }, sel)).toBe(true);
    expect(isHiddenInView({ type: "list", config: { shown: ["s"] } }, sel)).toBe(false);
    expect(isHiddenInView({ type: "chart", config: { shown: ["s"] } }, sel)).toBe(false);
    expect(isHiddenInView({ type: "gallery", config: {} }, text)).toBe(true);
    expect(isHiddenInView({ type: "gallery", config: {} }, sel)).toBe(false);
  });

  it("toggles between shown and hidden", () => {
    const board = { type: "board" as const, config: {} };
    const shown = toggleHiddenInView(board, text);
    expect(shown).toEqual({ hidden: [], shown: ["t"] });
    expect(toggleHiddenInView({ ...board, config: shown }, text)).toEqual({ hidden: ["t"], shown: [] });
    expect(toggleHiddenInView(board, sel)).toEqual({ hidden: ["s"], shown: [] });
    expect(toggleHiddenInView({ ...board, config: { hidden: ["s"] } }, sel)).toEqual({ hidden: [], shown: [] });
  });
});

describe("orderGroups", () => {
  it("follows the saved order and appends the rest", () => {
    const groups = groupRows([], status);
    const names = (order?: string[]) => orderGroups(groups, order).map((g) => g.option?.id ?? "");
    expect(names()).toEqual(["", "o1", "o2", "o3"]);
    expect(names(["o3", "", "o1"])).toEqual(["o3", "", "o1", "o2"]);
    expect(names(["gone", "o2"])).toEqual(["o2", "", "o1", "o3"]);
  });
});

describe("orderProperties", () => {
  const props = ["a", "b", "c", "d"].map((id) => ({ id }));
  const ids = (order?: string[]) => orderProperties(props, order).map((p) => p.id);

  it("keeps the database order without a saved one", () => {
    expect(ids()).toEqual(["a", "b", "c", "d"]);
    expect(ids([])).toEqual(["a", "b", "c", "d"]);
  });

  it("follows the saved order and skips ids that are gone", () => {
    expect(ids(["d", "c", "b", "a"])).toEqual(["d", "c", "b", "a"]);
    expect(ids(["gone", "c", "a", "b", "d"])).toEqual(["c", "a", "b", "d"]);
  });

  it("puts properties added since at the end, in database order", () => {
    expect(ids(["b", "a"])).toEqual(["b", "a", "c", "d"]);
    expect(ids(["d", "b"])).toEqual(["d", "b", "a", "c"]);
  });
});

describe("moveProperty", () => {
  const props = ["a", "b", "c", "d"].map((id) => ({ id }));

  it("moves a property before or after another", () => {
    expect(moveProperty(props, "d", "a", "before")).toEqual(["d", "a", "b", "c"]);
    expect(moveProperty(props, "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(moveProperty(props, "a", "b", "before")).toEqual(["a", "b", "c", "d"]);
  });

  it("changes nothing for a drop on itself or an unknown property", () => {
    expect(moveProperty(props, "b", "b", "after")).toEqual(["a", "b", "c", "d"]);
    expect(moveProperty(props, "b", "gone", "after")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("defaultsFromFilters", () => {
  const props = [status, tags, prop("checkbox"), prop("number"), prop("text")];

  it("fills values a new row needs to stay in the view", () => {
    const filters: FilterRule[] = [
      { propertyId: "p_select", op: "equals", value: "o2" },
      { propertyId: "p_multi_select", op: "contains", value: "t1" },
      { propertyId: "p_checkbox", op: "is_not_empty" },
      { propertyId: "p_number", op: "equals", value: 4 },
      { propertyId: "p_text", op: "contains", value: "abc" },
    ];
    expect(defaultsFromFilters(filters, props)).toEqual({
      p_select: "o2",
      p_multi_select: ["t1"],
      p_checkbox: true,
      p_number: 4,
      p_text: "abc",
    });
  });

  it("leaves rules alone that one value can't satisfy", () => {
    const filters: FilterRule[] = [
      { propertyId: "p_select", op: "not_equals", value: "o2" },
      { propertyId: "p_number", op: "gt", value: 4 },
      { propertyId: "p_text", op: "equals" },
      { propertyId: "title", op: "contains", value: "x" },
    ];
    expect(defaultsFromFilters(filters, props)).toEqual({});
  });
});

describe("created by properties", () => {
  const creator = prop("created_by");
  const rows = [
    row("a", "Mine", computedValues([creator], { createdBy: "u1" })),
    row("b", "Theirs", computedValues([creator], { createdBy: "u2" })),
    row("c", "Unknown", computedValues([creator], { createdBy: null })),
  ];

  it("holds the row's creator, filled in rather than stored", () => {
    expect(computedValues([creator, prop("text")], { createdBy: "u1" })).toEqual({ p_created_by: ["u1"] });
    expect(computedValues([creator], { createdBy: null })).toEqual({ p_created_by: null });
  });

  it("can't be written", () => {
    expect(() => normalizeValue(creator, ["u1"])).toThrow(PropertyValueError);
    expect(() => normalizeValue(creator, null)).toThrow(/set automatically/);
  });

  it("filters on me, sorts by name and groups boards like a person property", () => {
    const mine: FilterRule[] = [{ propertyId: "p_created_by", op: "contains", value: "me" }];
    expect(applyView(rows, { filters: mine }, [creator], { viewerId: "u2" }).map((r) => r.id)).toEqual(["b"]);
    const people = [
      { id: "u1", name: "Zeynep" },
      { id: "u2", name: "Ahmet" },
    ];
    expect(
      applyView(rows, { sorts: [{ propertyId: "p_created_by", direction: "asc" }] }, [creator], { people }).map((r) => r.id),
    ).toEqual(["b", "a", "c"]);
    expect(filterOperators("created_by").map((o) => o.op)).toEqual(["contains", "not_equals", "is_empty", "is_not_empty"]);
    expect(boardGroupProperty([prop("text"), creator])).toBe(creator);
    // New rows in a "created by me" view need nothing: they are the creator's anyway.
    expect(defaultsFromFilters(mine, [creator], { viewerId: "u1" })).toEqual({});
  });
});

describe("person properties", () => {
  const owner = prop("person");
  const rows = [
    row("a", "Mine", { p_person: ["u1"] }),
    row("b", "Shared", { p_person: ["u2", "u1"] }),
    row("c", "Theirs", { p_person: ["u2"] }),
    row("d", "Nobody's"),
  ];
  const ids = (filters: FilterRule[], viewerId?: string | null) => applyView(rows, { filters }, [owner], { viewerId }).map((r) => r.id);

  it("stores a deduplicated list of ids", () => {
    expect(normalizeValue(owner, [" u1", "u2", "u1"])).toEqual(["u1", "u2"]);
    expect(normalizeValue(owner, "u1")).toEqual(["u1"]);
    expect(normalizeValue(owner, [])).toBeNull();
    expect(() => normalizeValue(owner, [1])).toThrow(PropertyValueError);
  });

  it("filters on me as whoever looks at the view", () => {
    const mine: FilterRule[] = [{ propertyId: "p_person", op: "contains", value: "me" }];
    expect(ids(mine, "u1")).toEqual(["a", "b"]);
    expect(ids(mine, "u2")).toEqual(["b", "c"]);
    // A published page has no viewer: "me" is nobody.
    expect(ids(mine)).toEqual([]);
    expect(ids([{ propertyId: "p_person", op: "not_equals", value: "me" }], "u1")).toEqual(["c", "d"]);
  });

  it("filters on a given person and on emptiness", () => {
    expect(ids([{ propertyId: "p_person", op: "contains", value: "u2" }], "u1")).toEqual(["b", "c"]);
    expect(ids([{ propertyId: "p_person", op: "is_empty" }])).toEqual(["d"]);
    expect(ids([{ propertyId: "p_person", op: "is_not_empty" }])).toEqual(["a", "b", "c"]);
  });

  it("offers contains / does not contain / empty filters and sorting", () => {
    expect(filterOperators("person").map((o) => o.op)).toEqual(["contains", "not_equals", "is_empty", "is_not_empty"]);
    expect(isSortable("person")).toBe(true);
  });

  it("sorts by the names of the people, the first one counting most, empty rows last", () => {
    const people = [
      { id: "u1", name: "Zeynep" },
      { id: "u2", name: "Ahmet" },
    ];
    const sorted = (direction: "asc" | "desc") =>
      applyView(rows, { sorts: [{ propertyId: "p_person", direction }] }, [owner], { people }).map((r) => r.id);
    // Shared (Ahmet, Zeynep) and Theirs (Ahmet) both start with Ahmet; the second name breaks the tie.
    expect(sorted("asc")).toEqual(["c", "b", "a", "d"]);
    expect(sorted("desc")).toEqual(["a", "b", "c", "d"]);
    // Without names nobody is known, so the order stays as it was.
    expect(applyView(rows, { sorts: [{ propertyId: "p_person", direction: "asc" }] }, [owner]).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("assigns new rows of a me view to their creator", () => {
    const filters: FilterRule[] = [{ propertyId: "p_person", op: "contains", value: "me" }];
    expect(defaultsFromFilters(filters, [owner], { viewerId: "u1" })).toEqual({ p_person: ["u1"] });
    expect(defaultsFromFilters(filters, [owner])).toEqual({});
    expect(
      defaultsFromFilters([{ propertyId: "p_person", op: "contains", value: "u2" }], [owner], { viewerId: "u1" }),
    ).toEqual({ p_person: ["u2"] });
  });
});

describe("person boards", () => {
  const owner = prop("person");
  const people = [
    { id: "u1", name: "Ayşe", active: true },
    { id: "u2", name: "Mert", active: true },
    { id: "u3", name: "Eski", active: false },
    { id: "u4", name: "Yeni", active: true },
  ];

  it("groups by the view's choice, else the first select, else the first person property", () => {
    expect(boardGroupProperty([owner, status])?.id).toBe("p_select");
    expect(boardGroupProperty([owner, status], "p_person")?.id).toBe("p_person");
    expect(boardGroupProperty([owner, prop("text")])?.id).toBe("p_person");
    expect(boardGroupProperty([prop("text")], "p_text")).toBeUndefined();
  });

  it("shows a card in each assignee's column and former members only while assigned", () => {
    const rows = [
      row("a", "A", { p_person: ["u1", "u2"] }),
      row("b", "B", { p_person: ["u2", "gone"] }),
      row("c", "C", { p_person: ["gone"] }),
      row("d", "D"),
    ];
    const groups = groupRowsByPerson(rows, owner, people);
    expect(groups.map((g) => [g.option?.id ?? "", g.rows.map((r) => r.id)])).toEqual([
      ["", ["c", "d"]],
      ["u1", ["a"]],
      ["u2", ["a", "b"]],
      ["u4", []],
    ]);
    expect(groups[1].person).toEqual(people[0]);
    const withFormer = groupRowsByPerson([row("e", "E", { p_person: ["u3"] })], owner, people);
    expect(withFormer.map((g) => g.option?.id ?? "")).toEqual(["", "u1", "u2", "u3", "u4"]);
  });

  it("moves a card by swapping the column's person", () => {
    expect(movePersonValue(["u1", "u2"], "u1", "u4")).toEqual(["u4", "u2"]);
    expect(movePersonValue(["u1", "u2"], "u1", "u2")).toEqual(["u2"]);
    expect(movePersonValue(undefined, null, "u1")).toEqual(["u1"]);
    expect(movePersonValue(["u2"], null, "u1")).toEqual(["u2", "u1"]);
    expect(movePersonValue(["u1", "u2"], "u1", null)).toEqual([]);
  });
});

describe("created and last edited properties", () => {
  const created = prop("created_time");
  const edited = prop("last_edited_time");
  const editor = prop("last_edited_by");
  const props = [created, edited, editor];
  // Local times, so the expected days hold in any time zone.
  const at = (day: number, hour: number) => new Date(2026, 8, day, hour, 30);
  const source = (day: number, hour: number, updatedBy: string | null) => ({
    createdBy: "u1",
    updatedBy,
    createdAt: at(1, 9),
    updatedAt: at(day, hour),
  });
  const rows = [
    row("a", "A", computedValues(props, source(27, 23, "u2"))),
    row("b", "B", computedValues(props, source(26, 8, "u1"))),
    row("c", "C", computedValues(props, source(28, 0, null))),
  ];

  it("fills in when and by whom, never stored or written", () => {
    expect(computedValues(props, source(27, 23, "u2"))).toEqual({
      p_created_time: at(1, 9).toISOString(),
      p_last_edited_time: at(27, 23).toISOString(),
      p_last_edited_by: ["u2"],
    });
    // Sources without the columns (older callers) compute to empty.
    expect(computedValues(props, { createdBy: "u1" })).toEqual({
      p_created_time: null,
      p_last_edited_time: null,
      p_last_edited_by: null,
    });
    for (const p of props) expect(() => normalizeValue(p, "2026-01-01")).toThrow(/set automatically/);
  });

  it("filters timestamps by local day and sorts them by time", () => {
    const on = (op: FilterRule["op"], value: string) =>
      applyView(rows, { filters: [{ propertyId: "p_last_edited_time", op, value }] }, props).map((r) => r.id);
    expect(on("equals", "2026-09-27")).toEqual(["a"]);
    expect(on("lt", "2026-09-27")).toEqual(["b"]);
    expect(on("gt", "2026-09-27")).toEqual(["c"]);
    expect(
      applyView(rows, { sorts: [{ propertyId: "p_last_edited_time", direction: "desc" }] }, props).map((r) => r.id),
    ).toEqual(["c", "a", "b"]);
    expect(filterOperators("created_time")).toEqual(filterOperators("date"));
  });

  it("filters timestamps by relative dates on their local day", () => {
    const within = (value: string, days?: number) =>
      applyView(rows, { filters: [{ propertyId: "p_last_edited_time", op: "is_within", value, days }] }, props, {
        now: at(27, 12),
      }).map((r) => r.id);
    expect(within("today")).toEqual(["a"]);
    expect(within("past_n_days", 1)).toEqual(["a", "b"]);
    expect(within("next_n_days", 1)).toEqual(["a", "c"]);
    const created: FilterRule[] = [{ propertyId: "p_created_time", op: "is_within", value: "this_month" }];
    expect(applyView(rows, { filters: created }, props, { now: at(30, 12) })).toHaveLength(3);
    expect(applyView(rows, { filters: created }, props, { now: new Date(2026, 9, 1) })).toHaveLength(0);
    // Nothing to write into a new row: it is created (and edited) today anyway.
    expect(defaultsFromFilters(created, props, { now: at(30, 12) })).toEqual({});
  });

  it("treats last edited by like created by", () => {
    const mine: FilterRule[] = [{ propertyId: "p_last_edited_by", op: "contains", value: "me" }];
    expect(applyView(rows, { filters: mine }, props, { viewerId: "u1" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterOperators("last_edited_by")).toEqual(filterOperators("created_by"));
    expect(boardGroupProperty([created, editor])).toBe(editor);
    const people = [
      { id: "u1", name: "Zeynep" },
      { id: "u2", name: "Ahmet" },
    ];
    expect(
      applyView(rows, { sorts: [{ propertyId: "p_last_edited_by", direction: "asc" }] }, props, { people }).map((r) => r.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("finds the local day of a timestamp", () => {
    expect(localDay(at(27, 23).toISOString())).toBe("2026-09-27");
    expect(localDay("nope")).toBeNull();
    expect(localDay(null)).toBeNull();
  });
});

describe("status properties", () => {
  const ids = ["s1", "s2", "s3", "s4"];
  const next = () => ids.shift()!;
  const stage = { ...prop("status"), options: { options: makeStatusOptions(["Not started", "Doing", "Review", "Done"], next) } };

  it("spreads named options over the groups and keeps them in group order", () => {
    expect(stage.options.options.map((o) => [o.name, o.group, o.color])).toEqual([
      ["Not started", "todo", "gray"],
      ["Doing", "in_progress", "blue"],
      ["Review", "in_progress", "blue"],
      ["Done", "done", "green"],
    ]);
    expect(makeStatusOptions([], () => "x").map((o) => o.name)).toEqual(["Not started", "In progress", "Done"]);
    expect(makeStatusOptions([{ name: "Blocked", group: "in_progress" }, "Idea"], () => "x").map((o) => o.group)).toEqual([
      "in_progress",
      "done",
    ]);
    expect(
      sortStatusOptions([
        { id: "d", name: "Done", color: "green", group: "done" },
        { id: "n", name: "New", color: "gray" },
        { id: "w", name: "Working", color: "blue", group: "in_progress" },
      ]).map((o) => [o.id, o.group]),
    ).toEqual([
      ["n", "todo"],
      ["w", "in_progress"],
      ["d", "done"],
    ]);
  });

  it("stores option ids and reads like a select", () => {
    expect(normalizeValue(stage, "review")).toBe("s3");
    expect(() => normalizeValue(stage, "Later")).toThrow(PropertyValueError);
    expect(displayValue(stage, "s4")).toBe("Done");
    expect(filterOperators("status")).toEqual(filterOperators("select"));
    expect(defaultsFromFilters([{ propertyId: stage.id, op: "equals", value: "s2" }], [stage])).toEqual({ [stage.id]: "s2" });
  });

  it("sorts by group, filters by option and groups boards", () => {
    // Stored out of order: sorting still follows the groups.
    const shuffled = { ...stage, options: { options: [...stage.options.options].reverse() } };
    const rows = [row("a", "A", { p_status: "s4" }), row("b", "B", { p_status: "s1" }), row("c", "C", { p_status: "s2" }), row("d", "D")];
    expect(applyView(rows, { sorts: [{ propertyId: stage.id, direction: "asc" }] }, [shuffled]).map((r) => r.id)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
    expect(applyView(rows, { filters: [{ propertyId: stage.id, op: "equals", value: "s4" }] }, [stage]).map((r) => r.id)).toEqual([
      "a",
    ]);
    expect(isGroupable("status")).toBe(true);
    expect(boardGroupProperty([prop("person"), stage])).toBe(stage);
    const groups = groupRows(rows, shuffled);
    // Groups first, then the stored order within each group.
    expect(groups.map((g) => g.option?.id ?? "")).toEqual(["", "s1", "s3", "s2", "s4"]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["d"]);
  });
});

describe("checklist properties", () => {
  const list = prop("checklist");

  it("accepts texts or items, keeps ids and drops blanks", () => {
    const value = normalizeValue(list, ["Buy milk", { text: " Call  Bob ", checked: true, id: "i2" }, "  "]) as ChecklistItem[];
    expect(value.map(({ text, checked }) => [text, checked])).toEqual([
      ["Buy milk", false],
      ["Call Bob", true],
    ]);
    expect(value[1].id).toBe("i2");
    expect(value[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(normalizeValue(list, [])).toBeNull();
    expect(normalizeValue(list, ["  "])).toBeNull();
    expect(() => normalizeValue(list, "Buy milk")).toThrow(PropertyValueError);
    expect(() => normalizeValue(list, [{ text: "x", checked: "yes" }])).toThrow(PropertyValueError);
    expect(() => normalizeValue(list, [42])).toThrow(PropertyValueError);
  });

  it("shows progress, displays items and sorts by completion", () => {
    const half = [
      { id: "1", text: "a", checked: true },
      { id: "2", text: "b", checked: false },
    ];
    const done = [{ id: "3", text: "c", checked: true }];
    const none = [{ id: "4", text: "d", checked: false }];
    expect(checklistProgress(half)).toEqual({ done: 1, total: 2 });
    expect(checklistProgress(undefined)).toBeNull();
    expect(displayValue(list, half)).toEqual([
      { text: "a", checked: true },
      { text: "b", checked: false },
    ]);
    const rows = [row("h", "H", { p_checklist: half }), row("e", "E"), row("d", "D", { p_checklist: done }), row("n", "N", { p_checklist: none })];
    expect(applyView(rows, { sorts: [{ propertyId: list.id, direction: "desc" }] }, [list]).map((r) => r.id)).toEqual([
      "d",
      "h",
      "n",
      "e",
    ]);
    expect(filterOperators("checklist").map((o) => o.op)).toEqual(["is_empty", "is_not_empty"]);
    expect(applyView(rows, { filters: [{ propertyId: list.id, op: "is_empty" }] }, [list]).map((r) => r.id)).toEqual(["e"]);
  });
});

describe("email and phone properties", () => {
  it("validates emails loosely and drops mailto:", () => {
    expect(normalizeValue(prop("email"), " mailto:Ada@Example.com ")).toBe("Ada@Example.com");
    expect(() => normalizeValue(prop("email"), "ada@example")).toThrow(expect.objectContaining({ code: "invalidEmail" }));
    expect(() => normalizeValue(prop("email"), "ada example.com")).toThrow(PropertyValueError);
  });

  it("validates phone numbers loosely and links them", () => {
    expect(normalizeValue(prop("phone"), " +90 (212)  555-01-23 ")).toBe("+90 (212) 555-01-23");
    expect(normalizeValue(prop("phone"), "555 0123 ext. 12")).toBe("555 0123 ext. 12");
    expect(() => normalizeValue(prop("phone"), "call me")).toThrow(expect.objectContaining({ code: "invalidPhone" }));
    expect(() => normalizeValue(prop("phone"), "12")).toThrow(PropertyValueError);
    expect(phoneHref("+90 (212) 555-01-23")).toBe("tel:+902125550123");
    expect(phoneHref("555 0123 x12")).toBe("tel:5550123");
    expect(filterOperators("email")).toEqual(filterOperators("text"));
  });
});

describe("newAssignees", () => {
  const props = [{ id: "p_owner" }, { id: "p_reviewer" }];

  it("lists people added to person properties, except the one who added them", () => {
    expect(
      newAssignees(props, { p_owner: ["u1"] }, { p_owner: ["u1", "u2", "me-id"], p_reviewer: ["u3"] }, "me-id"),
    ).toEqual([
      { propertyId: "p_owner", userId: "u2" },
      { propertyId: "p_reviewer", userId: "u3" },
    ]);
  });

  it("ignores removals, unchanged values and other properties", () => {
    expect(newAssignees(props, { p_owner: ["u1", "u2"] }, { p_owner: ["u2"], p_text: ["u9"] }, "me-id")).toEqual([]);
  });
});
