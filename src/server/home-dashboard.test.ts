/**
 * The home dashboard's AI draft (home-dashboard.ts checkDraft): the model's widgets are kept only
 * when they show a database it was given, through properties that database has and that can group
 * or be measured; numbers come first and share the first row; lists show the rows edited last.
 */
import { describe, expect, it, vi } from "vitest";
import { checkDraft } from "./home-dashboard";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/access", () => ({ pageVisibleTo: () => null, requireMembership: async () => undefined }));
vi.mock("@/server/dashboards", () => ({ widgetStamps: async () => ({}) }));
vi.mock("@/server/databases", () => ({ getProperties: async () => [] }));
vi.mock("@/server/property-access", () => ({ propertyAccessFor: async () => ({ visible: (all: unknown[]) => all }) }));
vi.mock("@/server/workspaces", () => ({ workspaceSettings: async () => ({}) }));
vi.mock("@/server/ai-writing", () => ({ aiAvailable: async () => true }));

const QUOTES = "11111111-1111-4111-8111-111111111111";
const stored = [
  { id: "stage", name: "Stage", type: "status" as const, options: {} },
  { id: "amount", name: "Amount", type: "number" as const, options: {} },
  { id: "notes", name: "Notes", type: "files" as const, options: {} },
];
const sources = [{ id: QUOTES, title: "Quotes", rows: 10, properties: stored.map(({ id, name, type }) => ({ id, name, type })), stored }];

const number = (config = {}) => ({ databaseId: QUOTES, span: 1, view: { type: "chart", config: { chartType: "number", ...config } } });

describe("checkDraft", () => {
  it("keeps widgets of the databases given, numbers first sharing the first row", () => {
    const { widgets, problems } = checkDraft(
      {
        widgets: [
          { databaseId: QUOTES, span: 2, view: { type: "chart", config: { chartType: "donut", groupBy: "stage" } } },
          number(),
          number({ chartAggregate: { fn: "sum", propertyId: "amount" } }),
          { databaseId: QUOTES, span: 4, view: { type: "list", config: {} } },
        ],
      },
      sources,
    );
    expect(problems).toEqual([]);
    expect(widgets.map((w) => [w.view.type, w.view.config.chartType ?? null, w.span])).toEqual([
      ["chart", "number", 2],
      ["chart", "number", 2],
      ["chart", "donut", 2],
      ["list", null, 4],
    ]);
    expect(widgets[3].view.config.sorts?.[0].direction).toBe("desc");
    expect(new Set(widgets.map((w) => w.id)).size).toBe(4);
  });

  it("leaves out made-up databases and properties, saying why", () => {
    const { widgets, problems } = checkDraft(
      {
        widgets: [
          { ...number(), databaseId: "22222222-2222-4222-8222-222222222222" },
          { databaseId: QUOTES, span: 2, view: { type: "chart", config: { chartType: "bar", groupBy: "nope" } } },
          { databaseId: QUOTES, span: 2, view: { type: "chart", config: { chartType: "bar" } } },
          number({ chartAggregate: { fn: "sum", propertyId: "notes" } }),
          { databaseId: QUOTES, span: 4, view: { type: "board", config: {} } },
          number(),
        ],
      },
      sources,
    );
    expect(widgets).toHaveLength(1);
    expect(widgets[0].span).toBe(4);
    expect(problems).toHaveLength(5);
    expect(problems[0]).toContain("none of the databases given");
  });

  it("asks again for an answer that holds no widgets", () => {
    expect(checkDraft(null, sources).problems).toHaveLength(1);
    expect(checkDraft({ widgets: [] }, sources).widgets).toEqual([]);
  });
});
