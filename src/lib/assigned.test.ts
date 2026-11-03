import { describe, expect, it } from "vitest";
import { assignedGroup, countTasks, groupAssigned, groupByDatabase, inTaskView, isTaskView, SHARED_PLACE, taskPlace, type TaskView } from "./assigned";
import { firstDoneOption, isDoneStatus } from "./properties";

describe("assignedGroup", () => {
  const today = "2026-10-09";

  it("puts a row by its date relative to today", () => {
    expect(assignedGroup("2026-10-08", today)).toBe("overdue");
    expect(assignedGroup("2025-12-31", today)).toBe("overdue");
    expect(assignedGroup("2026-10-09", today)).toBe("today");
    expect(assignedGroup("2026-10-10", today)).toBe("next7");
    expect(assignedGroup("2026-10-16", today)).toBe("next7");
    expect(assignedGroup("2026-10-17", today)).toBe("later");
  });

  it("is due today while today is within a range, and overdue once it ended", () => {
    expect(assignedGroup("2026-10-07", today, "2026-10-11")).toBe("today");
    expect(assignedGroup("2026-10-05", today, "2026-10-08")).toBe("overdue");
    expect(assignedGroup("2026-10-12", today, "2026-10-20")).toBe("next7");
  });

  it("counts across months and years", () => {
    expect(assignedGroup("2027-01-02", "2026-12-31")).toBe("next7");
    expect(assignedGroup("2026-02-28", "2026-03-01")).toBe("overdue");
  });

  it("treats a missing or malformed date as none", () => {
    expect(assignedGroup(null, today)).toBe("none");
    expect(assignedGroup("", today)).toBe("none");
    expect(assignedGroup("tomorrow", today)).toBe("none");
  });
});

describe("groupAssigned", () => {
  const at = (iso: string) => new Date(iso);

  it("orders groups, drops empty ones and sorts by date, then last edited", () => {
    const rows = [
      { id: "a", date: null, updatedAt: at("2026-10-01T00:00:00Z") },
      { id: "b", date: "2026-10-12", updatedAt: at("2026-10-01T00:00:00Z") },
      { id: "c", date: "2026-10-05", updatedAt: at("2026-10-01T00:00:00Z") },
      { id: "d", date: "2026-10-11", updatedAt: at("2026-10-01T00:00:00Z") },
      { id: "e", date: null, updatedAt: at("2026-10-08T00:00:00Z") },
      { id: "f", date: "2026-10-11", updatedAt: at("2026-10-07T00:00:00Z") },
    ];
    const groups = groupAssigned(rows, "2026-10-09");
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ["overdue", ["c"]],
      ["next7", ["f", "d", "b"]],
      ["none", ["e", "a"]],
    ]);
  });

  it("places rows and to-dos in pages together, by date", () => {
    const groups = groupAssigned(
      [
        { type: "row", id: "row", date: "2026-10-09", endDate: null, updatedAt: at("2026-10-01T00:00:00Z") },
        { type: "pageTask", id: "todo-today", date: "2026-10-09", endDate: null, updatedAt: at("2026-10-02T00:00:00Z") },
        { type: "pageTask", id: "todo-late", date: "2026-10-01", endDate: null, updatedAt: at("2026-10-02T00:00:00Z") },
        { type: "pageTask", id: "todo-undated", date: null, endDate: null, updatedAt: at("2026-10-03T00:00:00Z") },
        { type: "row", id: "undated", date: null, endDate: null, updatedAt: at("2026-10-01T00:00:00Z") },
      ],
      "2026-10-09",
    );
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ["overdue", ["todo-late"]],
      ["today", ["todo-today", "row"]],
      ["none", ["todo-undated", "undated"]],
    ]);
  });

  it("returns nothing for no rows", () => {
    expect(groupAssigned([], "2026-10-09")).toEqual([]);
  });
});

describe("groupByDatabase", () => {
  const at = (iso: string) => new Date(iso);
  const row = (id: string, databaseId: string, databaseTitle: string | null, date: string | null, edited = "2026-10-01") => ({
    id,
    databaseId,
    databaseTitle,
    date,
    updatedAt: at(`${edited}T00:00:00Z`),
  });

  it("groups by database, names in order and rows of databases the viewer can't open last, together", () => {
    const groups = groupByDatabase([
      row("a", "d2", "Tasks", "2026-10-12"),
      row("b", "d1", "Bugs", null),
      row("c", "d3", null, "2026-10-01"),
      row("d", "d2", "Tasks", "2026-10-03"),
      row("e", "d1", "Bugs", "2026-11-01"),
      row("f", "d4", null, null),
    ]);
    expect(groups.map((g) => [g.databaseId, g.databaseTitle, g.rows.map((r) => r.id)])).toEqual([
      ["d1", "Bugs", ["e", "b"]],
      ["d2", "Tasks", ["d", "a"]],
      [null, null, ["c", "f"]],
    ]);
  });

  it("puts to-dos in pages under their page, sorted by its title among the databases", () => {
    const task = (id: string, pageId: string, pageTitle: string, date: string | null) => ({
      type: "pageTask" as const,
      id,
      pageId,
      pageTitle,
      date,
      updatedAt: at("2026-10-01T00:00:00Z"),
    });
    const groups = groupByDatabase<ReturnType<typeof row> | ReturnType<typeof task>>([
      row("a", "d2", "Tasks", "2026-10-12"),
      task("t1", "p1", "Launch plan", null),
      row("c", "d3", null, "2026-10-01"),
      task("t2", "p1", "Launch plan", "2026-10-02"),
      task("t3", "p2", "Bugs and more", null),
      row("b", "d1", "Bugs", null),
    ]);
    expect(groups.map((g) => [g.databaseId, g.databaseTitle, g.rows.map((r) => r.id)])).toEqual([
      ["d1", "Bugs", ["b"]],
      ["p2", "Bugs and more", ["t3"]],
      ["p1", "Launch plan", ["t2", "t1"]],
      ["d2", "Tasks", ["a"]],
      [null, null, ["c"]],
    ]);
  });

  it("puts rows without a date last, the one edited last first", () => {
    const groups = groupByDatabase([
      row("a", "d", "Tasks", null, "2026-10-01"),
      row("b", "d", "Tasks", null, "2026-10-05"),
      row("c", "d", "Tasks", "2026-12-01"),
    ]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("returns nothing for no rows", () => {
    expect(groupByDatabase([])).toEqual([]);
  });
});

describe("task views", () => {
  const today = "2026-10-09";
  const updatedAt = new Date("2026-10-01T00:00:00Z");
  const row = (id: string, databaseId: string, databaseTitle: string | null, date: string | null) => ({ id, databaseId, databaseTitle, date, updatedAt });
  const task = (id: string, pageId: string, pageTitle: string, date: string | null) => ({ type: "pageTask" as const, id, pageId, pageTitle, date, updatedAt });
  const items = [
    row("late", "d1", "Tasks", "2026-10-02"),
    row("now", "d1", "Tasks", today),
    row("soon", "d2", "Bugs", "2026-10-12"),
    row("far", "d2", "Bugs", "2026-11-30"),
    row("shared", "d3", null, null),
    task("t1", "p1", "Daily note", null),
    task("t2", "p1", "Daily note", "2026-10-15"),
  ];
  const ids = (view: TaskView) => items.filter((item) => inTaskView(item, view, today)).map((item) => item.id);

  it("puts items in each view by their date and kind", () => {
    expect(ids("all")).toEqual(["late", "now", "soon", "far", "shared", "t1", "t2"]);
    expect(ids("today")).toEqual(["late", "now"]);
    expect(ids("soon")).toEqual(["late", "now", "soon", "t2"]);
    expect(ids("undated")).toEqual(["shared", "t1"]);
    expect(ids("rows")).toEqual(["late", "now", "soon", "far", "shared"]);
    expect(ids("todos")).toEqual(["t1", "t2"]);
  });

  it("files rows under their database, to-dos under their page and rows without a database together", () => {
    expect(items.map(taskPlace)).toEqual(["d1", "d1", "d2", "d2", SHARED_PLACE, "p1", "p1"]);
  });

  it("counts views and places, the fullest place first and shared rows last", () => {
    const { views, places } = countTasks([...items, row("more", "d2", "Bugs", null)], today);
    expect(views).toEqual({ all: 8, today: 2, soon: 4, undated: 3, rows: 6, todos: 2 });
    expect(places).toEqual([
      { id: "d2", title: "Bugs", count: 3 },
      { id: "p1", title: "Daily note", count: 2 },
      { id: "d1", title: "Tasks", count: 2 },
      { id: SHARED_PLACE, title: null, count: 1 },
    ]);
  });

  it("knows its views", () => {
    expect(isTaskView("today")).toBe(true);
    expect(isTaskView("later")).toBe(false);
    expect(isTaskView(undefined)).toBe(false);
  });
});

describe("firstDoneOption", () => {
  const status = (options: { id: string; group?: "todo" | "in_progress" | "done" }[]) => ({
    options: { options: options.map((o) => ({ ...o, name: o.id, color: "gray" })) },
  });

  it("picks the first option of the done group", () => {
    const prop = status([{ id: "new", group: "todo" }, { id: "doing", group: "in_progress" }, { id: "shipped", group: "done" }, { id: "dropped", group: "done" }]);
    expect(firstDoneOption(prop)?.id).toBe("shipped");
    expect(isDoneStatus(prop, firstDoneOption(prop)?.id)).toBe(true);
  });

  it("finds none when no option is done (options without a group count as to do)", () => {
    expect(firstDoneOption(status([{ id: "new" }, { id: "doing", group: "in_progress" }]))).toBeUndefined();
    expect(firstDoneOption({ options: {} })).toBeUndefined();
  });
});
