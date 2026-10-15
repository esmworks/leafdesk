import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/config";
import { BUILTIN_TEMPLATE_KEYS, builtinTemplates, type BuiltinDatabaseTemplate } from "./builtin-templates";
import { parseDashboard, serializeDashboard, type DashboardWidget } from "./dashboard";

describe("built-in templates", () => {
  it.each(LOCALES)("%s: every template, with rows that use its own property and option names", async (locale) => {
    const templates = await builtinTemplates(locale);
    expect(templates.map((t) => t.key)).toEqual([...BUILTIN_TEMPLATE_KEYS]);
    const tracker = templates.find((t): t is BuiltinDatabaseTemplate => t.kind === "database")!;
    const { seedNames, properties } = tracker;
    const options = new Map<string, string[]>([
      [seedNames.status, [seedNames.notStarted, seedNames.inProgress, seedNames.done]],
      ...properties.filter((p) => p.options).map((p): [string, string[]] => [p.name, p.options!]),
    ]);
    // Distinct names, or rows would set the wrong property.
    expect(new Set([...options.keys(), seedNames.tags, ...properties.map((p) => p.name)]).size).toBe(2 + properties.length);
    for (const row of [tracker.rowTemplate, ...tracker.rows]) {
      expect(row.title.trim()).not.toBe("");
      for (const [name, value] of Object.entries(row.properties)) expect(options.get(name), `${locale}: ${name}`).toContain(value);
    }
  });

  it.each(LOCALES)("%s: the wins log names its own properties in its views, dashboard and rows", async (locale) => {
    const today = new Date("2026-10-15T12:00:00Z");
    const wins = (await builtinTemplates(locale, today)).find((t): t is BuiltinDatabaseTemplate => t.key === "wins-log")!;
    expect(wins.seedProperties).toBe(false);
    const names = wins.properties.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    const options = new Map(wins.properties.filter((p) => p.options).map((p) => [p.name, p.options!]));
    for (const options_ of options.values()) expect(new Set(options_).size).toBe(options_.length);
    const configs = [...wins.views.map((v) => v.config), ...wins.dashboard!.widgets.map((w) => w.view.config)];
    for (const config of configs) {
      for (const name of [config.groupBy, config.stackBy]) if (name !== undefined) expect(names, `${locale}: ${name}`).toContain(name);
    }
    const date = wins.properties.find((p) => p.type === "date")!.name;
    const days = new Set<string>();
    for (const row of [wins.rowTemplate, ...wins.rows]) {
      expect(row.title.trim()).not.toBe("");
      for (const [name, value] of Object.entries(row.properties)) {
        if (name === date) days.add(String(value));
        else expect(options.get(name), `${locale}: ${name}`).toContain(value);
      }
    }
    // Spread over months, all in the past.
    expect(new Set([...days].map((d) => d.slice(0, 7))).size).toBeGreaterThan(1);
    for (const day of days) expect(day < "2026-10-15").toBe(true);
    expect(wins.dashboard!.database.trim()).not.toBe("");
  });

  it("keeps every wins log widget as the dashboard stores it", async () => {
    const wins = (await builtinTemplates("en")).find((t): t is BuiltinDatabaseTemplate => t.key === "wins-log")!;
    const ids = (config: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(config).map(([k, v]) => [k, k === "groupBy" || k === "stackBy" ? `prop-${wins.properties.findIndex((p) => p.name === v)}` : v]));
    const widgets: DashboardWidget[] = wins.dashboard!.widgets.map((w, i) => ({
      id: `w${i}`,
      databaseId: "db-1",
      title: w.title,
      span: w.span,
      view: { type: w.view.type, config: ids(w.view.config) },
    }));
    expect(parseDashboard(serializeDashboard(widgets))).toEqual(widgets);
  });

  it("uses English for unknown languages", async () => {
    expect((await builtinTemplates("xx"))[0].title).toBe("Meeting notes");
    expect((await builtinTemplates("tr"))[0].title).toBe("Toplantı notları");
  });
});
