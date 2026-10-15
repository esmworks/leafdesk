import { describe, expect, it } from "vitest";
import {
  dashboardDatabaseIds,
  dashboardLine,
  defaultSpan,
  isComputedWidget,
  MAX_WIDGET_TITLE,
  MAX_WIDGETS,
  markdownDashboards,
  moveWidget,
  newWidget,
  newWidgetId,
  placeWidget,
  parseDashboard,
  parseDashboardLine,
  restoreDashboards,
  serializeDashboard,
  updateWidget,
  type DashboardWidget,
} from "./dashboard";

const DB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const widget = (id: string, databaseId = DB, extra: Partial<DashboardWidget> = {}): DashboardWidget => ({ ...newWidget(id, databaseId), ...extra });

describe("parseDashboard", () => {
  it("round-trips widgets", () => {
    const widgets = [
      widget("a"),
      widget("b", OTHER, { title: "Open bugs", span: 3, view: { type: "chart", config: { chartType: "donut", groupBy: "p" } } }),
      widget("c", DB, { span: 4, view: { type: "board", config: { groupBy: "s" } } }),
    ];
    expect(parseDashboard(serializeDashboard(widgets))).toEqual(widgets);
  });

  it("starts a new widget as a row count a quarter wide", () => {
    expect(newWidget("x", DB)).toEqual({ id: "x", databaseId: DB, title: "", span: 1, view: { type: "chart", config: { chartType: "number" } } });
  });

  it.each([
    ["no value", undefined],
    ["an empty string", ""],
    ["broken JSON", "[{"],
    ["an object", JSON.stringify({ widgets: [] })],
  ])("reads %s as no widgets", (_, value) => {
    expect(parseDashboard(value)).toEqual([]);
  });

  it("leaves out malformed widgets and repeated ids", () => {
    const value = JSON.stringify([
      { id: "a", databaseId: DB, span: 2, view: { type: "list", config: {} } },
      { id: "a", databaseId: OTHER, span: 1, view: { type: "list", config: {} } },
      { id: "bad id!", databaseId: DB, span: 1, view: { type: "list", config: {} } },
      { id: "c", databaseId: 3, span: 1, view: { type: "list", config: {} } },
      { id: "d", databaseId: DB, span: 1, view: { type: "form", config: {} } },
      "e",
      null,
    ]);
    // A form can't be a linked view: like one, it reads as a table.
    expect(parseDashboard(value).map((w) => [w.id, w.view.type])).toEqual([
      ["a", "list"],
      ["d", "table"],
    ]);
  });

  it("checks each view like a linked view and fixes widths and titles", () => {
    const value = JSON.stringify([
      { id: "a", databaseId: DB, span: 7, title: "x".repeat(500), view: { type: "chart", config: { chartType: "radar" } } },
      { id: "b", databaseId: DB, title: 4, view: { type: "nope" } },
    ]);
    const [a, b] = parseDashboard(value);
    expect(a.view).toEqual({ type: "chart", config: {} });
    expect(a.span).toBe(2);
    expect(a.title).toHaveLength(MAX_WIDGET_TITLE);
    // A view that isn't one reads as a table, like a linked view's.
    expect(b).toMatchObject({ title: "", span: 4, view: { type: "table", config: {} } });
  });

  it(`keeps at most ${MAX_WIDGETS} widgets`, () => {
    const many = Array.from({ length: MAX_WIDGETS + 3 }, (_, i) => widget(`w${i}`));
    expect(parseDashboard(JSON.stringify(many))).toHaveLength(MAX_WIDGETS);
    expect(JSON.parse(serializeDashboard(many))).toHaveLength(MAX_WIDGETS);
  });
});

describe("widget helpers", () => {
  const list = [widget("a"), widget("b", OTHER), widget("c")];

  it("sizes new widgets by layout", () => {
    expect(defaultSpan({ type: "chart", config: { chartType: "number" } })).toBe(1);
    expect(defaultSpan({ type: "chart", config: {} })).toBe(2);
    expect(defaultSpan({ type: "list", config: {} })).toBe(2);
    expect(defaultSpan({ type: "table", config: {} })).toBe(4);
  });

  it("works out numbers, charts and lists on the server, other layouts in the browser", () => {
    expect(["chart", "list", "table", "board", "calendar"].map((t) => isComputedWidget(t as never))).toEqual([true, true, false, false, false]);
  });

  it("lists each database once", () => {
    expect(dashboardDatabaseIds(list)).toEqual([DB, OTHER]);
  });

  it("moves, changes and removes a widget", () => {
    expect(moveWidget(list, "c", -1).map((w) => w.id)).toEqual(["a", "c", "b"]);
    expect(moveWidget(list, "a", -5).map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(moveWidget(list, "a", 9).map((w) => w.id)).toEqual(["b", "c", "a"]);
    expect(updateWidget(list, "b", (w) => ({ ...w, title: "T" }))[1].title).toBe("T");
    expect(updateWidget(list, "b", () => null).map((w) => w.id)).toEqual(["a", "c"]);
  });

  it("puts a widget next to another", () => {
    expect(placeWidget(list, "c", "a", "before").map((w) => w.id)).toEqual(["c", "a", "b"]);
    expect(placeWidget(list, "a", "c", "after").map((w) => w.id)).toEqual(["b", "c", "a"]);
    expect(placeWidget(list, "a", "zz", "after")).toBe(list);
  });

  it("makes ids no widget has", () => {
    const id = newWidgetId(list);
    expect(id).toMatch(/^[\w-]{1,64}$/);
    expect(list.map((w) => w.id)).not.toContain(id);
  });
});

describe("dashboards in Markdown", () => {
  it("reads only its own line", () => {
    expect(parseDashboardLine(dashboardLine("abc-1"))).toBe("abc-1");
    expect(parseDashboardLine(`text ${dashboardLine("abc")}`)).toBeNull();
    expect(parseDashboardLine("<!-- leafdesk:dashboard -->")).toBeNull();
  });

  it("finds the dashboards a page's Markdown names", () => {
    expect(markdownDashboards(`# Plan\n\n${dashboardLine("d1")}\n\ntext\n${dashboardLine("d2")}`)).toEqual(["d1", "d2"]);
    expect(markdownDashboards("no dashboards")).toEqual([]);
  });

  it("brings a named dashboard back whole and drops lines naming none", () => {
    const widgets = serializeDashboard([widget("a")]);
    const existing = [
      { id: "p1", type: "paragraph", props: {}, children: [] },
      { id: "d1", type: "dashboard", props: { widgets }, children: [] },
    ];
    const parsed = [
      { id: "d1", type: "dashboard", props: {}, children: [] },
      { id: "d1", type: "dashboard", props: {}, children: [] },
      { id: "zz", type: "dashboard", props: {}, children: [] },
      { id: "p2", type: "paragraph", props: {}, children: [] },
    ];
    expect(restoreDashboards(parsed, existing)).toEqual([
      { id: "d1", type: "dashboard", props: { widgets }, children: [] },
      { id: "p2", type: "paragraph", props: {}, children: [] },
    ]);
    expect(restoreDashboards(parsed, [])).toEqual([{ id: "p2", type: "paragraph", props: {}, children: [] }]);
  });
});
