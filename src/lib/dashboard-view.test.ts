import { describe, expect, it } from "vitest";
import type { ViewConfig, ViewWidget } from "@/db/schema/app";
import { retypeViewConfig } from "./convert-property";
import { defaultDashboardWidgets, MAX_WIDGETS, RECENT_ROWS_SORT, viewWidgets, viewWidgetsConfig } from "./dashboard";
import { keepDeleted, withoutDeleted } from "./deleted-schema";
import { dropPropertyReferences, remapViewConfig } from "./duplicate";
import { checkLinkedView, LINKED_VIEW_TYPES } from "./embed-blocks";
import { applyView } from "./properties";
import { makeAccess, restoreReferences } from "./property-access-rows";
import { configsOf, layoutConfigError, VIEW_TYPES } from "./views";

// Dashboard views: a database view holding dashboard widgets, each a view of that database.

const number: ViewWidget = { id: "n", span: 1, view: { type: "chart", config: { chartType: "number", chartAggregate: { fn: "sum", propertyId: "amount" } } } };
const chart: ViewWidget = {
  id: "c",
  title: "Pipeline",
  span: 3,
  color: "blue",
  view: {
    type: "chart",
    config: {
      groupBy: "status",
      filters: [{ type: "group", combinator: "or", rules: [{ propertyId: "salary", op: "gt", value: 5 }, { propertyId: "status", op: "is_not_empty" }] }],
    },
  },
};
const list: ViewWidget = { id: "l", span: 4, view: { type: "list", config: { sorts: [{ propertyId: "salary", direction: "desc" }, { ...RECENT_ROWS_SORT }] } } };
const dashboard: ViewConfig = { widgets: [number, chart, list] };

describe("dashboard view type", () => {
  it("is a view type, but not a layout of linked views or widgets", () => {
    expect(VIEW_TYPES).toContain("dashboard");
    expect(LINKED_VIEW_TYPES).not.toContain("dashboard");
    expect(LINKED_VIEW_TYPES).not.toContain("form");
    expect(checkLinkedView({ type: "dashboard", config: dashboard })).toEqual({ type: "table", config: {} });
    // Only dashboard views hold widgets.
    expect(checkLinkedView({ type: "list", config: { widgets: [number], sorts: [] } })).toEqual({ type: "list", config: { sorts: [] } });
  });
});

describe("widgets in view settings", () => {
  it("accepts well-formed widgets", () => {
    expect(layoutConfigError(dashboard)).toBeNull();
    expect(layoutConfigError({ widgets: [] })).toBeNull();
  });

  it.each([
    ["not a list", { widgets: {} }, /must be a list/],
    ["too many", { widgets: Array.from({ length: MAX_WIDGETS + 1 }, (_, i) => ({ ...number, id: `w${i}` })) }, /up to 12 widgets/],
    ["a bad id", { widgets: [{ ...number, id: "no spaces" }] }, /needs an id/],
    ["the same id twice", { widgets: [number, { ...chart, id: "n" }] }, /Two widgets have the id "n"/],
    ["a database id", { widgets: [{ ...number, databaseId: "db-2" }] }, /unknown setting "databaseId"/],
    ["a bad span", { widgets: [{ ...number, span: 5 }] }, /span must be one of/],
    ["a long title", { widgets: [{ ...number, title: "x".repeat(121) }] }, /title must be text/],
    ["a bad color", { widgets: [{ ...number, color: "teal" }] }, /color must be one of/],
    ["a form", { widgets: [{ ...number, view: { type: "form", config: {} } }] }, /the view must be one of/],
    ["a dashboard", { widgets: [{ ...number, view: { type: "dashboard", config: {} } }] }, /the view must be one of/],
    ["nested widgets", { widgets: [{ ...number, view: { type: "chart", config: { widgets: [] } } }] }, /holds no widgets/],
    ["a bad layout", { widgets: [{ ...number, view: { type: "chart", config: { chartType: "pie" } } }] }, /Widget "n": Chart type must be/],
    ["a bad filter", { widgets: [{ ...number, view: { type: "chart", config: { filters: [{ propertyId: "x", op: "nope" }] } } }] }, /Widget "n"/],
  ])("refuses %s", (_, config, error) => {
    expect(layoutConfigError(config as ViewConfig)).toMatch(error);
  });

  it("reads them as widgets of the view's database, and stores them without it", () => {
    const read = viewWidgets({ widgets: [number, chart, { ...list, id: "n" }, { title: "no id" } as unknown as ViewWidget] }, "db-1");
    expect(read.map((w) => [w.id, w.databaseId, w.title, w.span])).toEqual([
      ["n", "db-1", "", 1],
      ["c", "db-1", "Pipeline", 3],
    ]);
    expect(viewWidgetsConfig(read)).toEqual([number, chart]);
    expect(viewWidgets({}, "db-1")).toEqual([]);
  });

  it("lists the view's own settings and its widgets'", () => {
    expect(configsOf(dashboard)).toEqual([dashboard, number.view.config, chart.view.config, list.view.config]);
    expect(configsOf({ groupBy: "x" })).toEqual([{ groupBy: "x" }]);
  });
});

describe("defaultDashboardWidgets", () => {
  const props = [
    { id: "title-ish", type: "text" },
    { id: "amount", type: "number" },
    { id: "stage", type: "status" },
    { id: "kind", type: "select" },
  ];

  it("counts rows, sums the first number, charts the first select or status and lists the last edited rows", () => {
    const widgets = defaultDashboardWidgets(props);
    expect(widgets).toEqual([
      { id: "rows", span: 1, view: { type: "chart", config: { chartType: "number" } } },
      { id: "total", span: 1, view: { type: "chart", config: { chartType: "number", chartAggregate: { fn: "sum", propertyId: "amount" } } } },
      { id: "chart", span: 2, view: { type: "chart", config: { groupBy: "stage" } } },
      { id: "recent", span: 4, view: { type: "list", config: { sorts: [{ propertyId: "updated_at", direction: "desc" }] } } },
    ]);
    expect(layoutConfigError({ widgets })).toBeNull();
  });

  it("lists the rows edited last first", () => {
    const row = (id: string, updated: string) => ({ id, title: id, properties: {}, createdAt: new Date("2026-01-01"), updatedAt: new Date(updated) });
    const rows = [row("old", "2026-02-01"), row("new", "2026-03-01"), row("mid", "2026-02-15")];
    const recent = defaultDashboardWidgets([]).find((w) => w.id === "recent")!;
    expect(applyView(rows, recent.view.config, []).map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("fills the first row with what there is", () => {
    expect(defaultDashboardWidgets([{ id: "kind", type: "select" }]).map((w) => [w.id, w.span])).toEqual([
      ["rows", 1],
      ["chart", 3],
      ["recent", 4],
    ]);
    expect(defaultDashboardWidgets([{ id: "amount", type: "number" }]).map((w) => [w.id, w.span])).toEqual([
      ["rows", 1],
      ["total", 1],
      ["recent", 2],
    ]);
    expect(defaultDashboardWidgets([]).map((w) => [w.id, w.span])).toEqual([
      ["rows", 1],
      ["recent", 3],
    ]);
  });
});

describe("what widgets say about properties", () => {
  const gone = new Set(["salary"]);

  it("drops references to deleted properties from widgets too, and keeps them for a restore", () => {
    const shown = withoutDeleted(dashboard, gone);
    expect(shown.widgets?.[1].view.config.filters).toEqual([{ type: "group", combinator: "or", rules: [{ propertyId: "status", op: "is_not_empty" }] }]);
    expect(shown.widgets?.[2].view.config.sorts).toEqual([RECENT_ROWS_SORT]);
    // Saved from what was shown, with a widget's title changed: what the widgets said comes back.
    const edited = { ...shown, widgets: shown.widgets!.map((w) => (w.id === "l" ? { ...w, title: "Recent" } : w)) };
    const kept = keepDeleted(dashboard, edited, gone);
    expect(kept.widgets?.[1].view.config.filters).toEqual(chart.view.config.filters);
    expect(kept.widgets?.[2]).toMatchObject({ title: "Recent", view: { config: { sorts: [RECENT_ROWS_SORT, { propertyId: "salary", direction: "desc" }] } } });
  });

  it("hides properties a reader can't know of from widgets, and puts them back when they save", () => {
    const rule = { propertyId: "salary", userId: null, groupId: null, personPropertyId: null, level: "none" as const };
    const props = ["salary", "status", "amount"].map((id) => ({ id, name: id, type: "number" as const, options: {} }));
    const access = makeAccess(new Map([["salary", [rule]]]), { userId: "u1", groupIds: [], databaseLevel: "edit" }, props);
    const seen = access.viewConfig(dashboard);
    expect(JSON.stringify(seen)).not.toContain("salary");
    // A filter group naming the hidden property goes whole, so it comes back as it was.
    expect(seen.widgets?.[1].view.config.filters).toEqual([]);
    const saved = restoreReferences(dashboard, { ...seen, widgets: seen.widgets!.slice(1) }, gone);
    expect(saved.widgets?.map((w) => w.id)).toEqual(["c", "l"]);
    expect(saved.widgets?.[0].view.config.filters).toEqual(chart.view.config.filters);
    expect(saved.widgets?.[1].view.config.sorts).toEqual([RECENT_ROWS_SORT, { propertyId: "salary", direction: "desc" }]);
  });

  it("points widgets at copied properties, and forgets properties deleted for good", () => {
    const copied = remapViewConfig(dashboard, new Map([["amount", "amount-2"], ["status", "status-2"], ["salary", "salary-2"]]), () => null);
    expect(copied.widgets?.[0].view.config.chartAggregate).toEqual({ fn: "sum", propertyId: "amount-2" });
    expect(copied.widgets?.[1].view.config.groupBy).toBe("status-2");
    expect(dropPropertyReferences(dashboard, (id) => id === "amount").widgets?.[0].view.config.chartAggregate).toBeUndefined();
  });

  it("forgets what a widget said about a property whose new type can't do it", () => {
    const retyped = retypeViewConfig(dashboard, "status", "select", { type: "text", options: {} });
    expect(retyped.widgets?.[1].view.config.groupBy).toBeUndefined();
    expect(retyped.widgets?.[0]).toEqual(number);
  });
});
