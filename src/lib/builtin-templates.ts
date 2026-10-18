import type {
  ChartSort,
  ChartType,
  FilterOp,
  GroupDateBy,
  GroupStatusBy,
  NumberFormat,
  PropertyType,
  StatusGroup,
  ViewType,
} from "@/db/schema/app";
import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { loadLocaleFile, withFallback } from "@/i18n/messages";
import source from "@/i18n/messages/en/templates.json";
import type { AggregateFn, RollupFn } from "./aggregate";
import type { WidgetColor, WidgetSpan } from "./dashboard";
import { smallBusiness } from "./small-business-template";

/**
 * The built-in template gallery: a few starting points every workspace can use. They live here as
 * Markdown and plain data, not in the database; picking one creates an ordinary page (see
 * server/templates.ts `createFromBuiltin`), or for a kit several pages and databases. Each comes in
 * every UI language: the structure (kinds, icons, property types, which option each example row
 * has) is below, the texts are in `i18n/messages/<locale>/templates.json`.
 */

export const BUILTIN_TEMPLATE_KEYS = ["meeting-notes", "weekly-plan", "project-tracker", "wins-log", "small-business"] as const;
export type BuiltinTemplateKey = (typeof BUILTIN_TEMPLATE_KEYS)[number];

export const isBuiltinTemplateKey = (value: unknown): value is BuiltinTemplateKey =>
  typeof value === "string" && (BUILTIN_TEMPLATE_KEYS as readonly string[]).includes(value);

type Common = { key: BuiltinTemplateKey; icon: string; title: string; description: string };

export type BuiltinPageTemplate = Common & { kind: "page"; markdown: string };

export type BuiltinProperty = { name: string; type: PropertyType; options?: string[] };

/** A calculation over one property, named: a chart's measure or what a board's column headers add up. */
export type BuiltinAggregate = { fn: AggregateFn; property: string };

/**
 * A filter rule with its property named and, for a select or status, option names as its values
 * (relative date ranges for `is_within`, as in a view); or a group of them.
 */
export type BuiltinFilter =
  | { property: string; op: FilterOp; value?: string | string[]; days?: number }
  | { combinator: "and" | "or"; rules: BuiltinFilter[] };

/**
 * A view's settings with properties named rather than given by id (the database doesn't exist yet):
 * server/templates.ts turns the names into the new database's ids.
 */
export type BuiltinViewConfig = {
  groupBy?: string;
  stackBy?: string;
  /** Calendars: the date property that places rows on days. */
  dateBy?: string;
  groupDateBy?: GroupDateBy;
  groupStatusBy?: GroupStatusBy;
  chartType?: ChartType;
  chartSort?: ChartSort;
  chartAggregate?: BuiltinAggregate;
  boardAggregate?: BuiltinAggregate;
  showValues?: boolean;
  hideEmptyGroups?: boolean;
  sorts?: { property: string; direction: "asc" | "desc" }[];
  filters?: BuiltinFilter[];
  /** Tables: the calculation under each named property's column. */
  calculations?: Record<string, AggregateFn>;
};

export type BuiltinView = { name: string; type: ViewType; config: BuiltinViewConfig };

/** A dashboard widget of the template's database (see lib/dashboard). */
export type BuiltinWidget = { title: string; span: WidgetSpan; color?: WidgetColor; view: { type: "chart" | "list"; config: BuiltinViewConfig } };

export type BuiltinDatabaseTemplate = Common & {
  kind: "database";
  /** Names of the starter properties every new database gets (see pages.DatabaseSeedNames). */
  seedNames: { status: string; notStarted: string; inProgress: string; done: string; tags: string; table: string };
  /** False leaves out the starter Status and Tags properties: `seedNames` then only names the table. */
  seedProperties: boolean;
  /** Added after the starter ones. */
  properties: BuiltinProperty[];
  /** Views added after the starter table, in order. */
  views: BuiltinView[];
  /**
   * With a dashboard, picking the template makes a page (`title`, `icon`, the intro `markdown`)
   * holding the dashboard and, below it, the database inline, named `database`.
   */
  dashboard?: { database: string; markdown: string; widgets: BuiltinWidget[] };
  /** Becomes the database's default row template. Values are keyed by property name. */
  rowTemplate: { title: string; markdown: string; properties: Record<string, unknown> };
  /** A few example rows. */
  rows: { title: string; properties: Record<string, unknown> }[];
};

/** An option of a select or status: status options name their stage, and any may set its color. */
export type BuiltinOption = { name: string; group?: StatusGroup; color?: WidgetColor };

/** A property of a kit's database. The properties it reads are named: none of them exists yet. */
export type BuiltinKitProperty = {
  name: string;
  type: PropertyType;
  options?: BuiltinOption[];
  /** Numbers: how values show. */
  number?: NumberFormat;
  /** Relations, always two-way: the kit's database (by key) it links to, and the name of the property there that links back. */
  relation?: { database: string; pairedName: string };
  /** Rollups: `fn` over `target`, a property of the rows linked through `relation` (a relation of this database, by name). */
  rollup?: { relation: string; target: string; fn: RollupFn };
  /** Formulas: the expression, with property names in `prop("…")`. */
  formula?: string;
};

export type BuiltinKitDatabase = {
  /** How the kit's relations and widgets name it. */
  key: string;
  kind: "database";
  title: string;
  icon: string;
  properties: BuiltinKitProperty[];
  /** The first is a table: the one every new database starts with, named and set up as it says. */
  views: BuiltinView[];
  /** Becomes the database's default row template. Values are keyed by property name. */
  rowTemplate?: BuiltinDatabaseTemplate["rowTemplate"];
};

export type BuiltinKitPage = {
  key: string;
  kind: "page";
  title: string;
  icon: string;
  markdown: string;
  /** A dashboard under the Markdown, each widget over one of the kit's databases (by key). */
  dashboard?: (BuiltinWidget & { database: string })[];
};

/**
 * Pages and databases made together and linked to each other: they go side by side where a new page
 * would, in order, and the first is the one that opens.
 */
export type BuiltinKitTemplate = Common & { kind: "kit"; parts: (BuiltinKitPage | BuiltinKitDatabase)[] };

export type BuiltinTemplate = BuiltinPageTemplate | BuiltinDatabaseTemplate | BuiltinKitTemplate;

export type TemplateTexts = typeof source;
type Texts = TemplateTexts;
type TrackerTexts = Texts["project-tracker"];
type Status = "notStarted" | "inProgress" | "done";
type Priority = keyof TrackerTexts["options"];

const TRACKER_ROWS: { key: keyof TrackerTexts["rows"]; status: Status; priority: Priority }[] = [
  { key: "brief", status: "done", priority: "high" },
  { key: "milestone", status: "inProgress", priority: "high" },
  { key: "team", status: "notStarted", priority: "medium" },
];

type WinsTexts = Texts["wins-log"];
type WinType = keyof WinsTexts["types"];
type WinArea = keyof WinsTexts["areas"];
type WinImpact = keyof WinsTexts["impacts"];

/** The wins log's example rows, spread over the last three months so its charts show a trend. */
const WINS_ROWS: { key: keyof WinsTexts["rows"]; type: WinType; area: WinArea; impact: WinImpact; daysAgo: number }[] = [
  { key: "praise", type: "feedback", area: "customers", impact: "high", daysAgo: 6 },
  { key: "launch", type: "delivery", area: "product", impact: "high", daysAgo: 12 },
  { key: "response", type: "metric", area: "operations", impact: "medium", daysAgo: 38 },
  { key: "talk", type: "event", area: "team", impact: "low", daysAgo: 45 },
  { key: "thanks", type: "feedback", area: "sales", impact: "medium", daysAgo: 71 },
];

/** The day `days` before `today`, as a date property stores a day (YYYY-MM-DD, UTC). */
function dayBefore(today: Date, days: number) {
  return new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function build(texts: Texts, today: Date): BuiltinTemplate[] {
  const tracker = texts["project-tracker"];
  const { seedNames, properties: names, options } = tracker;
  const values = (status: Status, priority: Priority) => ({
    [seedNames.status]: seedNames[status],
    [names.priority]: options[priority],
  });
  const wins = texts["wins-log"];
  const w = wins.properties;
  const win = (row: Pick<(typeof WINS_ROWS)[number], "type" | "area" | "impact">) => ({
    [w.type]: wins.types[row.type],
    [w.area]: wins.areas[row.area],
    [w.impact]: wins.impacts[row.impact],
  });
  return [
    { key: "meeting-notes", kind: "page", icon: "📝", ...texts["meeting-notes"] },
    { key: "weekly-plan", kind: "page", icon: "🗓️", ...texts["weekly-plan"] },
    {
      key: "project-tracker",
      kind: "database",
      icon: "📋",
      title: tracker.title,
      description: tracker.description,
      seedNames,
      seedProperties: true,
      properties: [
        { name: names.priority, type: "select", options: [options.high, options.medium, options.low] },
        { name: names.owner, type: "person" },
        { name: names.due, type: "date" },
      ],
      // The board groups by the status every new database starts with.
      views: [{ name: tracker.board, type: "board", config: { groupBy: seedNames.status } }],
      rowTemplate: { ...tracker.rowTemplate, properties: values("notStarted", "medium") },
      rows: TRACKER_ROWS.map((row) => ({ title: tracker.rows[row.key], properties: values(row.status, row.priority) })),
    },
    {
      key: "wins-log",
      kind: "database",
      icon: "🏆",
      title: wins.title,
      description: wins.description,
      // Only the table's name is used: a win has no status to move through.
      seedNames: { ...tracker.seedNames, table: wins.table },
      seedProperties: false,
      properties: [
        { name: w.type, type: "select", options: Object.values(wins.types) },
        { name: w.area, type: "select", options: Object.values(wins.areas) },
        { name: w.date, type: "date" },
        { name: w.impact, type: "select", options: Object.values(wins.impacts) },
        { name: w.source, type: "url" },
        { name: w.person, type: "person" },
      ],
      views: [{ name: wins.board, type: "board", config: { groupBy: w.type } }],
      dashboard: {
        database: wins.database,
        markdown: wins.markdown,
        widgets: [
          { title: wins.widgets.total, span: 1, view: { type: "chart", config: { chartType: "number" } } },
          {
            title: wins.widgets.byMonth,
            span: 3,
            view: { type: "chart", config: { chartType: "bar", groupBy: w.date, groupDateBy: "month", stackBy: w.type } },
          },
          { title: wins.widgets.byArea, span: 2, view: { type: "chart", config: { chartType: "horizontal_bar", groupBy: w.area, showValues: true } } },
          { title: wins.widgets.byImpact, span: 2, view: { type: "chart", config: { chartType: "donut", groupBy: w.impact } } },
        ],
      },
      rowTemplate: { ...wins.rowTemplate, properties: { [w.impact]: wins.impacts.medium } },
      rows: WINS_ROWS.map((row) => ({ title: wins.rows[row.key], properties: { ...win(row), [w.date]: dayBefore(today, row.daysAgo) } })),
    },
    smallBusiness(texts["small-business"], texts["weekly-plan"]),
  ];
}

/** The gallery in the given UI language; English for any other, and for texts a language lacks. */
export async function builtinTemplates(locale: string | undefined, today = new Date()): Promise<BuiltinTemplate[]> {
  if (!isLocale(locale) || locale === DEFAULT_LOCALE) return build(source, today);
  return build(withFallback(source, await loadLocaleFile(locale, "templates")), today);
}

export async function builtinTemplate(key: BuiltinTemplateKey, locale: string | undefined, today = new Date()): Promise<BuiltinTemplate> {
  return (await builtinTemplates(locale, today)).find((t) => t.key === key)!;
}
