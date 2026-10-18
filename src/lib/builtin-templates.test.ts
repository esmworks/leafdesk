import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/config";
import {
  BUILTIN_TEMPLATE_KEYS,
  builtinTemplates,
  type BuiltinDatabaseTemplate,
  type BuiltinFilter,
  type BuiltinKitDatabase,
  type BuiltinKitPage,
  type BuiltinKitTemplate,
  type BuiltinViewConfig,
} from "./builtin-templates";
import { MAX_WIDGETS, parseDashboard, serializeDashboard, type DashboardWidget } from "./dashboard";
import { parseFormula } from "./formula";
import { quote } from "./formula/lexer";
import { checkNumberFormat } from "./number-format";

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

  it.each(LOCALES)("%s: the small business kit names its own databases, properties and options everywhere", async (locale) => {
    const kit = (await builtinTemplates(locale)).find((t): t is BuiltinKitTemplate => t.key === "small-business")!;
    expect(kit.kind).toBe("kit");
    expect(kit.parts.map((p) => p.key)).toEqual(["dashboard", "customers", "quotes", "jobs", "balance", "weekly-plan"]);
    const titles = kit.parts.map((p) => p.title);
    expect(new Set(titles).size).toBe(titles.length);
    const databases = new Map(kit.parts.filter((p): p is BuiltinKitDatabase => p.kind === "database").map((d) => [d.key, d]));

    // A database's columns: its own properties and those the relations of the others pair with it.
    type Column = { name: string; type: string; options: string[]; relatesTo?: string };
    const columns = new Map<string, Column[]>();
    for (const [key, database] of databases) {
      const own = database.properties.map((p) => ({ name: p.name, type: p.type, options: (p.options ?? []).map((o) => o.name), relatesTo: p.relation?.database }));
      const paired = [...databases.values()].flatMap((other) =>
        other.properties
          .filter((p) => p.relation?.database === key)
          .map((p) => ({ name: p.relation!.pairedName, type: "relation", options: [], relatesTo: other.key })),
      );
      columns.set(key, [...own, ...paired]);
    }
    const column = (database: string, name: string | undefined, where: string) => {
      const found = columns.get(database)!.find((c) => c.name === name);
      expect(found, `${locale}: ${where} names "${name}", which ${database} doesn't have`).toBeDefined();
      return found!;
    };

    for (const [key, database] of databases) {
      const names = columns.get(key)!.map((c) => c.name);
      expect(new Set(names).size, `${locale}: ${key} has a property name twice`).toBe(names.length);
      for (const c of columns.get(key)!) {
        expect(c.name.trim()).toBe(c.name);
        expect(c.name.length).toBeGreaterThan(0);
        expect(new Set(c.options).size, `${locale}: ${key}.${c.name} has an option twice`).toBe(c.options.length);
        for (const option of c.options) expect(option.trim().length).toBeGreaterThan(0);
        if (c.relatesTo) expect(databases.has(c.relatesTo)).toBe(true);
      }
      for (const p of database.properties) {
        if (p.number) expect(checkNumberFormat(p.number).ok, `${locale}: ${p.number.currency}`).toBe(true);
        if (p.rollup) {
          const relation = column(key, p.rollup.relation, `${key}.${p.name}`);
          expect(relation.type).toBe("relation");
          expect(column(relation.relatesTo!, p.rollup.target, `${key}.${p.name}`).type).toBe("number");
        }
        if (p.formula !== undefined) {
          const parsed = parseFormula(p.formula);
          expect(parsed.error, `${locale}: ${p.formula}`).toBeNull();
          for (const ref of parsed.refs) column(key, ref, `${key}.${p.name}`);
          // The side it subtracts is an option of the side property.
          const side = column(key, parsed.refs.find((ref) => column(key, ref, p.name).type === "select"), p.name);
          expect(side.options.some((o) => p.formula!.includes(quote(o)))).toBe(true);
        }
      }

      const viewNames = database.views.map((v) => v.name);
      expect(database.views[0].type).toBe("table");
      expect(new Set(viewNames).size, `${locale}: ${key} has a view name twice`).toBe(viewNames.length);
      for (const view of database.views) checkConfig(key, view.config, `${key} view "${view.name}"`);

      for (const [name, value] of Object.entries(database.rowTemplate?.properties ?? {})) {
        expect(column(key, name, `${key}'s row template`).options).toContain(value);
      }
    }

    function checkConfig(database: string, config: BuiltinViewConfig, where: string) {
      for (const name of [config.groupBy, config.stackBy, config.dateBy]) if (name !== undefined) column(database, name, where);
      if (config.dateBy !== undefined) expect(column(database, config.dateBy, where).type).toBe("date");
      if (config.groupDateBy !== undefined) expect(column(database, config.groupBy, where).type).toBe("date");
      for (const aggregate of [config.chartAggregate, config.boardAggregate]) {
        if (aggregate) expect(["number", "formula"]).toContain(column(database, aggregate.property, where).type);
      }
      for (const sort of config.sorts ?? []) column(database, sort.property, where);
      for (const name of Object.keys(config.calculations ?? {})) column(database, name, where);
      const checkFilter = (filter: BuiltinFilter) => {
        if ("combinator" in filter) return filter.rules.forEach(checkFilter);
        const target = column(database, filter.property, where);
        if (["select", "status"].includes(target.type) && filter.value !== undefined) {
          for (const value of [filter.value].flat()) expect(target.options, `${locale}: ${where}`).toContain(value);
        }
      };
      (config.filters ?? []).forEach(checkFilter);
    }

    const [dashboard, ...rest] = kit.parts;
    expect(dashboard.kind).toBe("page");
    const widgets = (dashboard as BuiltinKitPage).dashboard!;
    expect(widgets.length).toBeLessThanOrEqual(MAX_WIDGETS);
    expect(new Set(widgets.map((w) => w.title)).size).toBe(widgets.length);
    for (const widget of widgets) {
      expect(databases.has(widget.database)).toBe(true);
      expect(widget.title.trim().length).toBeGreaterThan(0);
      checkConfig(widget.database, widget.view.config, `widget "${widget.title}"`);
    }
    for (const page of rest.filter((p): p is BuiltinKitPage => p.kind === "page")) expect(page.markdown.trim().length).toBeGreaterThan(0);
  });

  it("uses English for unknown languages", async () => {
    expect((await builtinTemplates("xx"))[0].title).toBe("Meeting notes");
    expect((await builtinTemplates("tr"))[0].title).toBe("Toplantı notları");
  });
});
