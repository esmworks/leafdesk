import { describe, expect, it } from "vitest";
import { applyView, PropertyValueError, type RowLike } from "@/lib/properties";
import {
  describeProperty,
  describeViewConfig,
  displayProperties,
  resolvePropertyKey,
  toFilterEntries,
  toFilterRule,
  toSortRule,
  type PropertyDef,
} from "./query";

const props: PropertyDef[] = [
  {
    id: "p_status",
    name: "Status",
    type: "select",
    options: {
      options: [
        { id: "o_todo", name: "Not started", color: "gray" },
        { id: "o_done", name: "Done", color: "green" },
      ],
    },
  },
  {
    id: "p_tags",
    name: "Tags",
    type: "multi_select",
    options: { options: [{ id: "o_urgent", name: "Urgent", color: "red" }] },
  },
  { id: "p_est", name: "Estimate", type: "number", options: {} },
  { id: "p_ok", name: "Approved", type: "checkbox", options: {} },
];

const row = (id: string, properties: Record<string, unknown>): RowLike => ({
  id,
  title: id,
  properties,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-02"),
});

describe("resolvePropertyKey", () => {
  it("matches ids, case-insensitive names and special keys", () => {
    expect(resolvePropertyKey(props, "p_est").key).toBe("p_est");
    expect(resolvePropertyKey(props, " status ").key).toBe("p_status");
    expect(resolvePropertyKey(props, "Title").key).toBe("title");
    expect(resolvePropertyKey(props, "created_at").key).toBe("created_at");
  });

  it("lists the available properties when the name is unknown", () => {
    expect(() => resolvePropertyKey(props, "Colour")).toThrowError(/Unknown property "Colour".*Status \(select\)/);
  });
});

describe("toFilterRule", () => {
  it("resolves select option names to ids", () => {
    expect(toFilterRule(props, { property: "Status", op: "equals", value: "done" })).toEqual({
      propertyId: "p_status",
      op: "equals",
      value: "o_done",
    });
    expect(toFilterRule(props, { property: "tags", op: "contains", value: "Urgent" }).value).toBe("o_urgent");
  });

  it("rejects unknown options with the option list", () => {
    expect(() => toFilterRule(props, { property: "Status", op: "equals", value: "Blocked" })).toThrowError(
      /Options: Not started, Done/,
    );
  });

  it("requires a value only for comparison ops", () => {
    expect(toFilterRule(props, { property: "Status", op: "is_empty" })).toEqual({ propertyId: "p_status", op: "is_empty" });
    expect(() => toFilterRule(props, { property: "Estimate", op: "gt" })).toThrow(PropertyValueError);
  });

  it("coerces checkbox and number values", () => {
    expect(toFilterRule(props, { property: "Approved", op: "equals", value: "true" }).value).toBe(true);
    expect(toFilterRule(props, { property: "Estimate", op: "gt", value: "5" }).value).toBe(5);
    expect(() => toFilterRule(props, { property: "Estimate", op: "lt", value: "many" })).toThrow(PropertyValueError);
  });

  it("refuses ordering ops on selects", () => {
    expect(() => toFilterRule(props, { property: "Status", op: "gt", value: "Done" })).toThrow(PropertyValueError);
  });

  it("produces rules that applyView understands", () => {
    const rows = [
      row("a", { p_status: "o_todo", p_est: 3, p_tags: ["o_urgent"] }),
      row("b", { p_status: "o_done", p_est: 8 }),
    ];
    const done = applyView(rows, { filters: [toFilterRule(props, { property: "Status", op: "equals", value: "Done" })] }, props);
    expect(done.map((r) => r.id)).toEqual(["b"]);
    const urgent = applyView(rows, { filters: [toFilterRule(props, { property: "Tags", op: "contains", value: "urgent" })] }, props);
    expect(urgent.map((r) => r.id)).toEqual(["a"]);
    const sorted = applyView(rows, { sorts: [toSortRule(props, { property: "estimate", direction: "desc" })] }, props);
    expect(sorted.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("display helpers", () => {
  it("keys values by name, shows option names and drops empties", () => {
    expect(displayProperties(props, { p_status: "o_done", p_tags: [], p_est: 0, p_ok: false })).toEqual({
      Status: "Done",
      Estimate: 0,
      Approved: false,
    });
  });

  it("describes view configs with names", () => {
    expect(
      describeViewConfig(props, {
        groupBy: "p_status",
        filters: [{ propertyId: "p_status", op: "equals", value: "o_done" }],
        sorts: [{ propertyId: "title", direction: "asc" }],
      }),
    ).toEqual({
      group_by: "Status",
      filters: [{ property: "Status", op: "equals", value: "Done" }],
      sorts: [{ property: "title", direction: "asc" }],
    });
  });

  it("describes the grouping settings that apply to the grouping property", () => {
    const due: PropertyDef = { id: "p_due", name: "Due", type: "date", options: {} };
    const stage: PropertyDef = { id: "p_stage", name: "Stage", type: "status", options: { options: [] } };
    const all = [...props, due, stage];
    expect(describeViewConfig(all, { groupBy: "p_due" })).toEqual({ group_by: "Due", group_date_by: "month" });
    expect(describeViewConfig(all, { groupBy: "p_due", groupDateBy: "year", hideEmptyGroups: true })).toEqual({
      group_by: "Due",
      group_date_by: "year",
      hide_empty_groups: true,
    });
    expect(describeViewConfig(all, { groupBy: "p_stage", groupStatusBy: "group" })).toEqual({
      group_by: "Stage",
      group_status_by: "group",
    });
    // Settings for another kind of grouping don't show.
    expect(describeViewConfig(all, { groupBy: "p_ok", groupDateBy: "week", groupStatusBy: "group" })).toEqual({ group_by: "Approved" });
  });
});

describe("relations", () => {
  const customer: PropertyDef = {
    id: "p_customer",
    name: "Customer",
    type: "relation",
    options: { relation: { databaseId: "db-customers", pairedPropertyId: "p_jobs" } },
  };
  const all = [...props, customer];
  const relations = {
    p_customer: {
      database: { id: "db-customers", title: "Customers" },
      pairedName: "Jobs",
      rows: [
        { id: "c1", title: "Acme" },
        { id: "c2", title: "Globex" },
        { id: "c3", title: "Globex" },
      ],
    },
  };
  const targets = { relations, people: [] };

  it("filters by related row id or unique title", () => {
    expect(toFilterRule(all, { property: "customer", op: "contains", value: "acme" }, targets)).toEqual({
      propertyId: "p_customer",
      op: "contains",
      value: "c1",
    });
    expect(toFilterRule(all, { property: "Customer", op: "not_equals", value: "c3" }, targets).value).toBe("c3");
    expect(() => toFilterRule(all, { property: "Customer", op: "contains", value: "Globex" }, targets)).toThrow(/2 rows/);
    expect(() => toFilterRule(all, { property: "Customer", op: "contains", value: "Nope" }, targets)).toThrow(/not a row/);
    expect(() => toFilterRule(all, { property: "Customer", op: "gt", value: "c1" }, targets)).toThrow(/supports contains/);
  });

  it("is not sortable", () => {
    expect(() => toSortRule(all, { property: "Customer" })).toThrow(/can't be sorted/);
  });

  it("shows linked rows as id and title, skipping rows that no longer exist", () => {
    expect(displayProperties(all, { p_customer: ["c2", "gone", "c1"] }, targets)).toEqual({
      Customer: [
        { id: "c2", title: "Globex" },
        { id: "c1", title: "Acme" },
      ],
    });
    expect(displayProperties(all, { p_customer: ["gone"] }, targets)).toEqual({});
  });

  it("describes the related database, pairing and calendar date property", () => {
    expect(describeProperty(customer, targets)).toMatchObject({
      type: "relation",
      related_database_id: "db-customers",
      related_database: "Customers",
      two_way: true,
      paired_property: "Jobs",
    });
    expect(
      describeViewConfig(all, { dateBy: "p_est", filters: [{ propertyId: "p_customer", op: "contains", value: "c1" }] }, targets),
    ).toEqual({ date_by: "Estimate", filters: [{ property: "Customer", op: "contains", value: "Acme" }] });
  });
});

describe("person properties", () => {
  const owner: PropertyDef = { id: "p_owner", name: "Owner", type: "person", options: {} };
  const all = [...props, owner];
  const lookups = {
    relations: {},
    people: [
      { id: "u1", name: "Ayşe Yılmaz", email: "ayse@example.com", active: true },
      { id: "u2", name: "Mehmet", email: "mehmet@example.com", active: true },
      { id: "u3", name: "Mehmet", email: "m2@example.com", active: true },
      { id: "u4", name: "Eski Üye", email: null, active: false },
    ],
  };

  it("filters by user id, email, unique name or me", () => {
    expect(toFilterRule(all, { property: "owner", op: "contains", value: "ayse@example.com" }, lookups)).toEqual({
      propertyId: "p_owner",
      op: "contains",
      value: "u1",
    });
    expect(toFilterRule(all, { property: "Owner", op: "contains", value: "ayşe yılmaz" }, lookups).value).toBe("u1");
    expect(toFilterRule(all, { property: "Owner", op: "not_equals", value: "u2" }, lookups).value).toBe("u2");
    // "me" is kept so a saved view shows each viewer their own rows.
    expect(toFilterRule(all, { property: "Owner", op: "contains", value: "Me" }, lookups).value).toBe("me");
    expect(() => toFilterRule(all, { property: "Owner", op: "contains", value: "Mehmet" }, lookups)).toThrow(/2 people/);
    expect(() => toFilterRule(all, { property: "Owner", op: "contains", value: "nobody" }, lookups)).toThrow(/not a person/);
    expect(() => toFilterRule(all, { property: "Owner", op: "equals", value: "u1" }, lookups)).toThrow(/supports contains/);
  });

  it("is sortable (by name)", () => {
    expect(toSortRule(all, { property: "Owner", direction: "desc" })).toEqual({ propertyId: "p_owner", direction: "desc" });
  });

  it("treats created by like a person, read-only", () => {
    const creator: PropertyDef = { id: "p_creator", name: "Created by", type: "created_by", options: {} };
    const withCreator = [...all, creator];
    expect(toFilterRule(withCreator, { property: "created by", op: "contains", value: "mehmet@example.com" }, lookups).value).toBe("u2");
    expect(toFilterRule(withCreator, { property: "Created by", op: "contains", value: "me" }, lookups).value).toBe("me");
    expect(() => toFilterRule(withCreator, { property: "Created by", op: "equals", value: "u1" }, lookups)).toThrow(
      /Created by "Created by" supports contains/,
    );
    expect(displayProperties(withCreator, { p_creator: ["u1"] }, lookups)).toEqual({ "Created by": [{ id: "u1", name: "Ayşe Yılmaz" }] });
    expect(describeProperty(creator, lookups)).toEqual({ id: "p_creator", name: "Created by", type: "created_by", read_only: true });
  });

  it("shows people as id and name, skipping unknown ids", () => {
    expect(displayProperties(all, { p_owner: ["u4", "gone", "u1"] }, lookups)).toEqual({
      Owner: [
        { id: "u4", name: "Eski Üye" },
        { id: "u1", name: "Ayşe Yılmaz" },
      ],
    });
  });

  it("lists assignable people and names people in view filters", () => {
    expect(describeProperty(owner, lookups)).toEqual({
      id: "p_owner",
      name: "Owner",
      type: "person",
      people: [
        { id: "u1", name: "Ayşe Yılmaz", email: "ayse@example.com" },
        { id: "u2", name: "Mehmet", email: "mehmet@example.com" },
        { id: "u3", name: "Mehmet", email: "m2@example.com" },
      ],
    });
    expect(
      describeViewConfig(
        all,
        {
          filters: [
            { propertyId: "p_owner", op: "contains", value: "me" },
            { propertyId: "p_owner", op: "not_equals", value: "u1" },
          ],
        },
        lookups,
      ),
    ).toEqual({
      filters: [
        { property: "Owner", op: "contains", value: "me" },
        { property: "Owner", op: "not_equals", value: "Ayşe Yılmaz" },
      ],
    });
  });
});

describe("system, status and checklist properties", () => {
  const edited: PropertyDef = { id: "p_edited", name: "Edited", type: "last_edited_time", options: {} };
  const editor: PropertyDef = { id: "p_editor", name: "Edited by", type: "last_edited_by", options: {} };
  const todo: PropertyDef = { id: "p_todo", name: "Todo", type: "checklist", options: {} };
  const stage: PropertyDef = {
    id: "p_stage",
    name: "Stage",
    type: "status",
    options: {
      options: [
        { id: "s1", name: "New", color: "gray", group: "todo" },
        { id: "s2", name: "Shipped", color: "green", group: "done" },
      ],
    },
  };
  const all = [edited, editor, todo, stage];
  const lookups = { relations: {}, people: [{ id: "u1", name: "Ayşe", email: "ayse@example.com" }] };

  it("filters timestamps by day", () => {
    expect(toFilterRule(all, { property: "edited", op: "gt", value: "2026-09-27T10:00:00Z" })).toEqual({
      propertyId: "p_edited",
      op: "gt",
      value: "2026-09-27",
    });
    expect(() => toFilterRule(all, { property: "Edited", op: "contains", value: "2026" })).toThrow(/supports equals/);
    expect(() => toFilterRule(all, { property: "Edited", op: "equals", value: "yesterday" })).toThrow(/YYYY-MM-DD/);
    expect(toFilterRule(all, { property: "Edited", op: "is_within", value: "past_n_days", days: 7 })).toEqual({
      propertyId: "p_edited",
      op: "is_within",
      value: "past_n_days",
      days: 7,
    });
    expect(() => toFilterRule(all, { property: "Edited by", op: "is_within", value: "today" })).toThrow(/only applies to date/);
  });

  it("treats last edited by like a person and names it in errors", () => {
    expect(toFilterRule(all, { property: "Edited by", op: "contains", value: "ayse@example.com" }, lookups).value).toBe("u1");
    expect(() => toFilterRule(all, { property: "Edited by", op: "equals", value: "u1" }, lookups)).toThrow(
      /Last edited by "Edited by"/,
    );
  });

  it("only checks checklists for emptiness", () => {
    expect(toFilterRule(all, { property: "Todo", op: "is_empty" })).toEqual({ propertyId: "p_todo", op: "is_empty" });
    expect(() => toFilterRule(all, { property: "Todo", op: "contains", value: "x" })).toThrow(/is_empty and is_not_empty/);
    expect(displayProperties(all, { p_todo: [{ id: "i", text: "Write", checked: true }] })).toEqual({
      Todo: [{ text: "Write", checked: true }],
    });
  });

  it("filters statuses by option name and describes their groups", () => {
    expect(toFilterRule(all, { property: "Stage", op: "equals", value: "shipped" }).value).toBe("s2");
    expect(describeProperty(stage)).toEqual({
      id: "p_stage",
      name: "Stage",
      type: "status",
      options: ["New", "Shipped"],
      status_groups: { todo: ["New"], in_progress: [], done: ["Shipped"] },
    });
    expect(describeProperty(edited)).toMatchObject({ read_only: true });
    expect(describeProperty(editor, lookups)).toEqual({ id: "p_editor", name: "Edited by", type: "last_edited_by", read_only: true });
  });
});

describe("filter groups and relative dates", () => {
  const all: PropertyDef[] = [...props, { id: "p_due", name: "Due", type: "date", options: {} }];

  it("converts nested groups and keeps plain rule lists as they were", () => {
    expect(
      toFilterEntries(all, [
        { property: "Status", op: "equals", value: "Done" },
        {
          type: "group",
          combinator: "or",
          rules: [
            { property: "Tags", op: "contains", value: "urgent" },
            { type: "group", rules: [{ property: "Estimate", op: "gt", value: "3" }] },
          ],
        },
      ]),
    ).toEqual([
      { propertyId: "p_status", op: "equals", value: "o_done" },
      {
        type: "group",
        combinator: "or",
        rules: [
          { propertyId: "p_tags", op: "contains", value: "o_urgent" },
          { type: "group", combinator: "and", rules: [{ propertyId: "p_est", op: "gt", value: 3 }] },
        ],
      },
    ]);
    expect(toFilterEntries(all, [{ property: "Status", op: "is_empty" }])).toEqual([{ propertyId: "p_status", op: "is_empty" }]);
  });

  it("rejects groups nested too deep, empty groups and bad rules inside groups", () => {
    const deep = { type: "group" as const, rules: [{ type: "group" as const, rules: [{ type: "group" as const, rules: [] }] }] };
    expect(() => toFilterEntries(all, [deep])).toThrowError(/at most 2 levels deep/);
    expect(() => toFilterEntries(all, [{ type: "group", rules: [] }])).toThrowError(/at least one rule/);
    expect(() =>
      toFilterEntries(all, [{ type: "group", rules: [{ property: "Status", op: "equals", value: "Blocked" }] }]),
    ).toThrowError(/not an option of "Status"/);
  });

  it("accepts relative date ranges on dates and timestamps", () => {
    expect(toFilterRule(all, { property: "Due", op: "is_within", value: "This_Week" })).toEqual({
      propertyId: "p_due",
      op: "is_within",
      value: "this_week",
    });
    expect(toFilterRule(all, { property: "Due", op: "is_within", value: "past_n_days", days: 14 })).toEqual({
      propertyId: "p_due",
      op: "is_within",
      value: "past_n_days",
      days: 14,
    });
    expect(toFilterRule(all, { property: "created_at", op: "is_within", value: "today" }).propertyId).toBe("created_at");
  });

  it("explains what is wrong with a relative date filter", () => {
    expect(() => toFilterRule(all, { property: "Estimate", op: "is_within", value: "today" })).toThrowError(/only applies to date/);
    expect(() => toFilterRule(all, { property: "Due", op: "is_within", value: "tomorrow" })).toThrowError(/today, this_week/);
    expect(() => toFilterRule(all, { property: "Due", op: "is_within", value: "next_n_days" })).toThrowError(/needs "days"/);
    expect(() => toFilterRule(all, { property: "Due", op: "is_within", value: "today", days: 3 })).toThrowError(
      /only applies to past_n_days/,
    );
    expect(() => toFilterRule(all, { property: "Due", op: "equals", value: "2026-01-01", days: 3 })).toThrowError(
      /only applies to is_within/,
    );
    expect(() => toFilterRule(all, { property: "Due", op: "is_within" })).toThrowError(/needs a value/);
  });

  it("describes groups, the top-level combinator and day counts by name", () => {
    expect(
      describeViewConfig(all, {
        filterCombinator: "or",
        filters: [
          { propertyId: "p_due", op: "is_within", value: "next_n_days", days: 7 },
          { type: "group", combinator: "and", rules: [{ propertyId: "p_status", op: "equals", value: "o_done" }] },
        ],
      }),
    ).toEqual({
      filters: [
        { property: "Due", op: "is_within", value: "next_n_days", days: 7 },
        { type: "group", combinator: "and", rules: [{ property: "Status", op: "equals", value: "Done" }] },
      ],
      filter_combinator: "or",
    });
  });
});

describe("files properties", () => {
  const id = "AbCdEfGhIjKlMnOpQrStUv_-";
  const all: PropertyDef[] = [...props, { id: "p_files", name: "Attachments", type: "files", options: {} }];

  it("shows values as {name, url}, absolute with the app's address", () => {
    const value = [{ url: `/api/files/${id}`, name: "photo.png", type: "image/png" }];
    expect(displayProperties(all, { p_files: value }, undefined, "https://app.example")).toEqual({
      Attachments: [{ name: "photo.png", url: `https://app.example/api/files/${id}` }],
    });
    expect(displayProperties(all, { p_files: [] })).toEqual({});
  });

  it("filters on empty only and sorts by count", () => {
    expect(toFilterRule(all, { property: "Attachments", op: "is_not_empty" })).toEqual({ propertyId: "p_files", op: "is_not_empty" });
    expect(() => toFilterRule(all, { property: "Attachments", op: "contains", value: "photo" })).toThrowError(
      /supports is_empty and is_not_empty/,
    );
    expect(toSortRule(all, { property: "Attachments", direction: "desc" })).toEqual({ propertyId: "p_files", direction: "desc" });
  });

  it("names a gallery's cover property", () => {
    expect(describeViewConfig(all, { cover: { source: "property", propertyId: "p_files" } })).toEqual({ cover: "Attachments" });
    // Rows open beside the view unless the view says otherwise; only that is described.
    expect(describeViewConfig(all, { openRows: "page" })).toEqual({ open_rows: "page" });
    expect(describeViewConfig(all, { openRows: "panel" })).toEqual({});
    expect(describeViewConfig(all, { cover: { source: "none" } })).toEqual({ cover: "none" });
  });
});

describe("board column calculations", () => {
  it("names what a board's column headers show unless it is the card count", () => {
    const due: PropertyDef = { id: "p_due", name: "Due", type: "date", options: {} };
    expect(describeViewConfig([due], { boardAggregate: { fn: "latest_date", propertyId: "p_due" } }, undefined, "board")).toEqual({
      aggregate: "latest_date",
      aggregate_property: "Due",
    });
    // A calculation the property no longer offers counts cards, as the board does.
    expect(describeViewConfig([due], { boardAggregate: { fn: "sum", propertyId: "p_due" } }, undefined, "board")).toEqual({});
    expect(describeViewConfig([due], {}, undefined, "board")).toEqual({});
  });
});

describe("list, comparison and does-not-contain operators", () => {
  const owner: PropertyDef = { id: "p_owner", name: "Owner", type: "person", options: {} };
  const customer: PropertyDef = {
    id: "p_customer",
    name: "Customer",
    type: "relation",
    options: { relation: { databaseId: "db-customers" } },
  };
  const due: PropertyDef = { id: "p_due", name: "Due", type: "date", options: {} };
  const edited: PropertyDef = { id: "p_edited", name: "Edited", type: "last_edited_time", options: {} };
  const all = [...props, owner, customer, due, edited];
  const lookups = {
    relations: { p_customer: { database: { id: "db-customers", title: "Customers" }, rows: [{ id: "c1", title: "Acme" }, { id: "c2", title: "Globex" }] } },
    people: [
      { id: "u1", name: "Ayşe", email: "ayse@example.com", active: true },
      { id: "u2", name: "Mehmet", email: "mehmet@example.com", active: true },
    ],
  };

  it("resolves each value of an any of / none of list", () => {
    expect(toFilterRule(all, { property: "Status", op: "is_any_of", value: ["done", "Not started"] })).toEqual({
      propertyId: "p_status",
      op: "is_any_of",
      value: ["o_done", "o_todo"],
    });
    expect(toFilterRule(all, { property: "Tags", op: "is_none_of", value: ["urgent"] }).value).toEqual(["o_urgent"]);
    expect(toFilterRule(all, { property: "Owner", op: "is_any_of", value: ["Me", "mehmet@example.com"] }, lookups).value).toEqual([
      "me",
      "u2",
    ]);
    expect(toFilterRule(all, { property: "Customer", op: "is_none_of", value: ["acme", "c2"] }, lookups).value).toEqual(["c1", "c2"]);
    // A single value is a list of one; repeats collapse.
    expect(toFilterRule(all, { property: "Status", op: "is_any_of", value: "Done" }).value).toEqual(["o_done"]);
    expect(toFilterRule(all, { property: "Status", op: "is_any_of", value: ["Done", "done"] }).value).toEqual(["o_done"]);
  });

  it("refuses lists where they don't fit", () => {
    expect(() => toFilterRule(all, { property: "Status", op: "is_any_of", value: ["Nope"] })).toThrow(/not an option/);
    expect(() => toFilterRule(all, { property: "Estimate", op: "is_any_of", value: ["1"] })).toThrow(/applies to select/);
    expect(() => toFilterRule(all, { property: "title", op: "is_none_of", value: ["x"] })).toThrow(/applies to select/);
    expect(() => toFilterRule(all, { property: "Status", op: "equals", value: ["Done"] })).toThrow(/single value/);
  });

  it("takes gte / lte on numbers and dates, and does_not_contain on text", () => {
    expect(toFilterRule(all, { property: "Estimate", op: "gte", value: "3" })).toEqual({ propertyId: "p_est", op: "gte", value: 3 });
    expect(toFilterRule(all, { property: "Estimate", op: "lte", value: 3 }).value).toBe(3);
    expect(() => toFilterRule(all, { property: "Estimate", op: "gte", value: "many" })).toThrow(/must be a number/);
    expect(toFilterRule(all, { property: "Due", op: "lte", value: "2026-10-01" }).value).toBe("2026-10-01");
    expect(toFilterRule(all, { property: "Edited", op: "gte", value: "2026-10-01T10:00:00Z" }).value).toBe("2026-10-01");
    expect(() => toFilterRule(all, { property: "Edited", op: "contains", value: "2026" })).toThrow(/gte \(on or after\)/);
    expect(() => toFilterRule(all, { property: "Status", op: "gte", value: "Done" })).toThrow(/not supported on select/);
    expect(toFilterRule(all, { property: "title", op: "does_not_contain", value: "draft" })).toEqual({
      propertyId: "title",
      op: "does_not_contain",
      value: "draft",
    });
  });

  it("filters rows the same way the app does", () => {
    const rows = [
      row("Draft A", { p_status: "o_done", p_est: 3, p_owner: ["u1"] }),
      row("Final B", { p_status: "o_todo", p_est: 5, p_owner: ["u2"] }),
      row("Final C", { p_est: 1 }),
    ];
    const filters = toFilterEntries(
      all,
      [
        { property: "Status", op: "is_none_of", value: ["Done"] },
        { property: "title", op: "does_not_contain", value: "c" },
        { property: "Estimate", op: "gte", value: 3 },
        { property: "Owner", op: "is_any_of", value: ["me"] },
      ],
      lookups,
    );
    expect(applyView(rows, { filters }, all, { viewerId: "u2" }).map((r) => r.id)).toEqual(["Final B"]);
  });

  it("describes list rules by name", () => {
    expect(
      describeViewConfig(
        all,
        {
          filters: [
            { propertyId: "p_status", op: "is_any_of", value: ["o_done", "o_todo"] },
            { propertyId: "p_owner", op: "is_none_of", value: ["me", "u1"] },
          ],
        },
        lookups,
      ),
    ).toEqual({
      filters: [
        { property: "Status", op: "is_any_of", value: ["Done", "Not started"] },
        { property: "Owner", op: "is_none_of", value: ["me", "Ayşe"] },
      ],
    });
  });
});
