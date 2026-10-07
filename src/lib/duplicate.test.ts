import { describe, expect, it } from "vitest";
import { dropPropertyReferences, planDuplicate, remapViewConfig, type DuplicateInput, type SourcePage } from "./duplicate";

const pageOf = (id: string, parentId: string | null, extra: Partial<SourcePage> = {}): SourcePage => ({
  id,
  parentId,
  kind: "page",
  title: id,
  position: 1,
  properties: {},
  ...extra,
});

describe("dropPropertyReferences", () => {
  it("removes every reference to the properties that go, keeping the rest", () => {
    const gone = (id: string) => id === "person";
    const out = dropPropertyReferences(
      {
        groupBy: "person",
        dateBy: "due",
        sorts: [
          { propertyId: "person", direction: "asc" },
          { propertyId: "due", direction: "desc" },
        ],
        filters: [
          { propertyId: "person", op: "is_empty" },
          { type: "group", combinator: "or", rules: [{ propertyId: "person", op: "is_not_empty" }] },
          { propertyId: "due", op: "is_not_empty" },
        ],
        hidden: ["person", "due"],
        propertyOrder: ["due", "person", "notes"],
        columnWidths: { title: 320, person: 90, due: 240 },
        wrapped: ["title", "person", "due"],
        frozenThrough: "person",
        calculations: { person: "count_all", due: "count_all" },
        cover: { source: "property", propertyId: "person" },
      } as never,
      gone,
    );
    expect(out.groupBy).toBeUndefined();
    expect(out.dateBy).toBe("due");
    expect(out.sorts).toEqual([{ propertyId: "due", direction: "desc" }]);
    expect(out.filters).toEqual([{ propertyId: "due", op: "is_not_empty" }]);
    expect(out.hidden).toEqual(["due"]);
    expect(out.propertyOrder).toEqual(["due", "notes"]);
    expect(out.columnWidths).toEqual({ title: 320, due: 240 });
    expect(out.wrapped).toEqual(["title", "due"]);
    expect(out.frozenThrough).toBeUndefined();
    expect(out.calculations).toEqual({ due: "count_all" });
    expect(out.cover).toBeUndefined();
  });
});

/** Sequential ids so assertions can name them. */
const counter = () => {
  let n = 0;
  return () => `new${++n}`;
};

describe("planDuplicate", () => {
  // root (page) > tasks (db) > rows t1, t2; t1 > note; root > people (db) > row p1.
  // tasks.owner ↔ people.tasks is a two-way relation inside the copy; tasks.client points outside.
  const input: DuplicateInput = {
    rootId: "root",
    rootTitle: "Root (copy)",
    rootPosition: 1.5,
    pages: [
      pageOf("root", "parent", { properties: { outerProp: "kept" } }),
      pageOf("tasks", "root", { kind: "database", position: 2 }),
      pageOf("t1", "tasks", {
        properties: { status: "opt1", owner: ["p1", "p_gone"], client: ["c1"], stale: "x" },
      }),
      pageOf("t2", "tasks", { position: 2, properties: { status: "opt2" } }),
      pageOf("note", "t1"),
      pageOf("people", "root", { kind: "database", position: 3 }),
      pageOf("p1", "people", { properties: { tasksRel: ["t1"] } }),
    ],
    properties: [
      {
        id: "status",
        databaseId: "tasks",
        name: "Status",
        type: "select",
        position: 1,
        options: { options: [{ id: "opt1", name: "Todo", color: "gray" }] },
      },
      {
        id: "owner",
        databaseId: "tasks",
        name: "Owner",
        type: "relation",
        position: 2,
        options: { relation: { databaseId: "people", pairedPropertyId: "tasksRel" } },
      },
      {
        id: "client",
        databaseId: "tasks",
        name: "Client",
        type: "relation",
        position: 3,
        options: { relation: { databaseId: "clients", pairedPropertyId: "clientsRel" } },
      },
      {
        id: "tasksRel",
        databaseId: "people",
        name: "Tasks",
        type: "relation",
        position: 1,
        options: { relation: { databaseId: "tasks", pairedPropertyId: "owner" } },
      },
    ],
    views: [
      {
        id: "v1",
        databaseId: "tasks",
        name: "Board",
        type: "board",
        position: 1,
        config: {
          groupBy: "status",
          sorts: [{ propertyId: "title", direction: "asc" }],
          filters: [{ propertyId: "owner", op: "contains", value: "p1" }],
          hidden: ["client"],
          groupOrder: ["opt1", ""],
          hiddenGroups: ["opt2"],
        },
      },
    ],
  };
  const plan = planDuplicate(input, counter());
  const copyOf = (id: string) => plan.pageIds.get(id)!;
  const planned = (id: string) => plan.pages.find((p) => p.sourceId === id)!;
  const prop = (sourceDb: string, name: string) =>
    plan.properties.find((p) => p.databaseId === copyOf(sourceDb) && p.name === name)!;

  it("gives every page, property and view a new id", () => {
    const ids = [...plan.pages.map((p) => p.id), ...plan.properties.map((p) => p.id), ...plan.views.map((v) => v.id)];
    expect(new Set(ids).size).toBe(ids.length);
    const sourceIds = new Set([...input.pages, ...input.properties, ...input.views].map((x) => x.id));
    expect(ids.some((id) => sourceIds.has(id))).toBe(false);
  });

  it("keeps the root under the original parent with the new title and position", () => {
    const root = planned("root");
    expect(root).toMatchObject({ id: plan.rootId, parentId: "parent", title: "Root (copy)", position: 1.5 });
    // Its values belong to the parent database, which isn't copied.
    expect(root.properties).toEqual({ outerProp: "kept" });
  });

  it("rebuilds the tree from the copies and keeps child titles and positions", () => {
    expect(planned("tasks")).toMatchObject({ parentId: plan.rootId, title: "tasks", position: 2 });
    expect(planned("note").parentId).toBe(copyOf("t1"));
    expect(planned("t2")).toMatchObject({ parentId: copyOf("tasks"), position: 2 });
  });

  it("pairs relations inside the copy with each other", () => {
    const owner = prop("tasks", "Owner");
    const tasks = prop("people", "Tasks");
    expect(owner.options.relation).toEqual({ databaseId: copyOf("people"), pairedPropertyId: tasks.id });
    expect(tasks.options.relation).toEqual({ databaseId: copyOf("tasks"), pairedPropertyId: owner.id });
  });

  it("keeps relations to outside databases one-way", () => {
    expect(prop("tasks", "Client").options.relation).toEqual({ databaseId: "clients", pairedPropertyId: null });
  });

  it("keeps select options with their ids", () => {
    expect(prop("tasks", "Status").options.options).toEqual([{ id: "opt1", name: "Todo", color: "gray" }]);
  });

  it("rekeys row values and follows relation links into the copy", () => {
    expect(planned("t1").properties).toEqual({
      [prop("tasks", "Status").id]: "opt1",
      // p_gone was not copied (trashed or hidden), so the link is dropped.
      [prop("tasks", "Owner").id]: [copyOf("p1")],
      [prop("tasks", "Client").id]: ["c1"],
      stale: "x",
    });
    expect(planned("p1").properties).toEqual({ [prop("people", "Tasks").id]: [copyOf("t1")] });
  });

  it("remaps view configs", () => {
    const [view] = plan.views;
    expect(view.databaseId).toBe(copyOf("tasks"));
    expect(view.config).toEqual({
      groupBy: prop("tasks", "Status").id,
      sorts: [{ propertyId: "title", direction: "asc" }],
      filters: [{ propertyId: prop("tasks", "Owner").id, op: "contains", value: copyOf("p1") }],
      hidden: [prop("tasks", "Client").id],
      groupOrder: ["opt1", ""],
      hiddenGroups: ["opt2"],
    });
  });

  it("does not mutate its input", () => {
    expect(input.pages[2].properties.owner).toEqual(["p1", "p_gone"]);
    expect(input.views[0].config.groupBy).toBe("status");
    expect(input.properties[1].options.relation?.pairedPropertyId).toBe("tasksRel");
  });

  it("copies a lone row of an uncopied database as is", () => {
    const solo = planDuplicate(
      {
        rootId: "row",
        rootTitle: "Row (kopya)",
        rootPosition: 3,
        pages: [pageOf("row", "db", { properties: { status: "o1", rel: ["x"] } })],
        properties: [],
        views: [],
      },
      counter(),
    );
    expect(solo.pages).toEqual([
      {
        sourceId: "row",
        id: "new1",
        parentId: "db",
        kind: "page",
        title: "Row (kopya)",
        position: 3,
        properties: { status: "o1", rel: ["x"] },
      },
    ]);
  });
});

describe("remapViewConfig", () => {
  it("leaves an empty config empty", () => {
    expect(remapViewConfig({}, new Map(), () => null)).toEqual({});
  });

  it("maps calendar and shown ids and keeps unknown ids", () => {
    const ids = new Map([["date", "date2"]]);
    expect(remapViewConfig({ dateBy: "date", shown: ["date", "gone"], propertyOrder: ["gone", "date"] }, ids, () => null)).toEqual({
      dateBy: "date2",
      shown: ["date2", "gone"],
      propertyOrder: ["gone", "date2"],
    });
  });

  it("maps filter rules inside groups and keeps the combinators", () => {
    const ids = new Map([
      ["status", "status2"],
      ["link", "link2"],
    ]);
    const rows = new Map([["r1", "r1copy"]]);
    expect(
      remapViewConfig(
        {
          filterCombinator: "or",
          filters: [
            { propertyId: "status", op: "equals", value: "o1" },
            { type: "group", combinator: "and", rules: [{ propertyId: "link", op: "contains", value: "r1" }] },
          ],
        },
        ids,
        (id) => (id === "link" ? rows : null),
      ),
    ).toEqual({
      filterCombinator: "or",
      filters: [
        { propertyId: "status2", op: "equals", value: "o1" },
        { type: "group", combinator: "and", rules: [{ propertyId: "link2", op: "contains", value: "r1copy" }] },
      ],
    });
  });

  it("maps timeline start, end and swimlane properties and keeps layout settings", () => {
    const ids = new Map([
      ["start", "start2"],
      ["end", "end2"],
      ["status", "status2"],
    ]);
    expect(
      remapViewConfig({ dateBy: "start", endDateBy: "end", groupBy: "status", zoom: "month", showTable: false }, ids, () => null),
    ).toEqual({ dateBy: "start2", endDateBy: "end2", groupBy: "status2", zoom: "month", showTable: false });
  });

  it("maps a chart's group, stack and measured properties and keeps its settings", () => {
    const ids = new Map([
      ["status", "status2"],
      ["owner", "owner2"],
      ["amount", "amount2"],
    ]);
    expect(
      remapViewConfig(
        { chartType: "horizontal_bar", groupBy: "status", stackBy: "owner", chartAggregate: { fn: "sum", propertyId: "amount" }, showValues: true },
        ids,
        () => null,
      ),
    ).toEqual({
      chartType: "horizontal_bar",
      groupBy: "status2",
      stackBy: "owner2",
      chartAggregate: { fn: "sum", propertyId: "amount2" },
      showValues: true,
    });
  });

  it("maps footer calculations to the copied properties", () => {
    const ids = new Map([["amount", "amount2"]]);
    expect(remapViewConfig({ calculations: { amount: "sum", title: "count_all" } }, ids, () => null)).toEqual({
      calculations: { amount2: "sum", title: "count_all" },
    });
  });

  it("maps group keys of a relation grouping to the copied rows, and keeps option keys", () => {
    const ids = new Map([
      ["link", "link2"],
      ["status", "status2"],
    ]);
    const rows = new Map([["r1", "r1copy"]]);
    const rowIdsFor = (id: string) => (id === "link" ? rows : null);
    const groups = { groupOrder: ["r1", "", "outside"], hiddenGroups: ["r1"], collapsedGroups: ["outside", "r1"] };
    expect(remapViewConfig({ groupBy: "link", ...groups }, ids, rowIdsFor)).toEqual({
      groupBy: "link2",
      groupOrder: ["r1copy", "", "outside"],
      hiddenGroups: ["r1copy"],
      collapsedGroups: ["outside", "r1copy"],
    });
    expect(remapViewConfig({ groupBy: "status", groupOrder: ["o1"], hiddenGroups: ["o2"] }, ids, rowIdsFor)).toEqual({
      groupBy: "status2",
      groupOrder: ["o1"],
      hiddenGroups: ["o2"],
    });
  });

  it("maps a form's questions and default values to the copied properties and rows", () => {
    const ids = new Map([
      ["email", "email2"],
      ["status", "status2"],
      ["link", "link2"],
    ]);
    const rows = new Map([["r1", "r1copy"]]);
    const rowIdsFor = (id: string) => (id === "link" ? rows : null);
    expect(
      remapViewConfig(
        {
          form: {
            title: "Sign up",
            questions: [{ propertyId: "title", required: true }, { propertyId: "email", label: "Your email" }],
            defaults: { status: "o1", link: ["r1", "outside"] },
            allowAnother: false,
          },
        },
        ids,
        rowIdsFor,
      ),
    ).toEqual({
      form: {
        title: "Sign up",
        questions: [{ propertyId: "title", required: true }, { propertyId: "email2", label: "Your email" }],
        defaults: { status2: "o1", link2: ["r1copy"] },
        allowAnother: false,
      },
    });
  });
});
