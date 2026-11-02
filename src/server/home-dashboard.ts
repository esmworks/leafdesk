/**
 * The dashboard on a workspace's home page: widgets as a dashboard block holds them (lib/dashboard),
 * kept in the workspace's settings (`homeDashboard`) rather than in a page, so it belongs to no
 * teamspace and needs no place in the page tree. Owners lay it out on the home page; everyone in
 * the workspace sees it, each reader only the widgets whose database they may open, and what each
 * one shows is worked out for them (server/dashboards widgetData), as for a dashboard on a page.
 *
 * "Set up with AI" drafts one from the databases the owner may see (draftHomeDashboard): nothing is
 * saved by drafting: the home page shows it to them to keep or change. It counts as AI usage
 * ("home.dashboard") and is held to the workspace's limits like any other request.
 */
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, workspace } from "@/db/schema";
import type { PropertyOptions, PropertyType, ViewConfig } from "@/db/schema/app";
import { readDraftJson } from "@/lib/agent-draft";
import { chartAggregateFunctionsOf } from "@/lib/chart";
import { DASHBOARD_COLUMNS, dashboardDatabaseIds, parseDashboard, RECENT_ROWS_SORT, serializeDashboard, type DashboardWidget, type WidgetSpan } from "@/lib/dashboard";
import { readDashboardPeriod, serializeDashboardPeriod } from "@/lib/dashboard-period";
import { isGroupableProperty } from "@/lib/properties";
import { pageVisibleTo, requireMembership } from "@/server/access";
import { AiError, complete, type AiMessage } from "@/server/ai";
import { homeDashboardPrompt, homeDashboardRepair, type DashboardSource } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { widgetStamps } from "@/server/dashboards";
import { getProperties } from "@/server/databases";
import { propertyAccessFor } from "@/server/property-access";
import { workspaceSettings } from "@/server/workspaces";

export type HomeDashboard = { widgets: DashboardWidget[]; period: string };

/** Why a draft couldn't be made: no database to show, or nothing of the model's that could be. */
export class HomeDashboardError extends Error {
  constructor(
    readonly code: "noDatabases" | "unusable",
    message: string,
  ) {
    super(message);
  }
}

/** Databases a draft is made from: the ones edited last, so a large workspace's prompt stays small. */
const DRAFT_DATABASES = 20;
/** Properties of each database described to the model, and option names of each select. */
const DRAFT_PROPERTIES = 25;
const DRAFT_OPTIONS = 8;

/**
 * The home dashboard as `userId` sees it: an owner every widget (one whose database they can't
 * open shows as unavailable while they lay it out), anyone else only the widgets whose database
 * they may open, so a widget's title never names a database to someone who can't see it.
 */
export async function homeDashboard(userId: string, workspaceId: string, { owner }: { owner: boolean }): Promise<HomeDashboard> {
  const stored = (await workspaceSettings(workspaceId)).homeDashboard;
  const widgets = parseDashboard(stored?.widgets);
  const period = stored?.period ?? "";
  if (owner || !widgets.length) return { widgets, period };
  const stamps = await widgetStamps({ userId }, dashboardDatabaseIds(widgets));
  return { widgets: widgets.filter((w) => stamps[w.databaseId] && stamps[w.databaseId] !== "none"), period };
}

/** Lays out the home dashboard. Owners only; widgets are checked as a dashboard block's are. */
export async function saveHomeDashboard(userId: string, workspaceId: string, input: { widgets: unknown; period: unknown }) {
  await requireMembership(userId, workspaceId, "owner");
  const widgets = parseDashboard(typeof input.widgets === "string" ? input.widgets : JSON.stringify(input.widgets ?? []));
  const period = readDashboardPeriod(input.period);
  const value = { widgets: serializeDashboard(widgets), period: period ? serializeDashboardPeriod(period) : "" };
  await db
    .update(workspace)
    .set({ settings: sql`${workspace.settings} || ${JSON.stringify({ homeDashboard: value })}::jsonb` })
    .where(eq(workspace.id, workspaceId));
}

/**
 * Widgets for the home dashboard drafted from the databases the owner may see, checked and not
 * saved. Throws AiError when the workspace has no AI or the request fails, HomeDashboardError
 * when it has no database to show or no widget of the model's passes even after it was told what is wrong.
 */
export async function draftHomeDashboard(userId: string, workspaceId: string, { signal }: { signal?: AbortSignal } = {}): Promise<DashboardWidget[]> {
  await requireMembership(userId, workspaceId, "owner");
  if (!(await aiAvailable(workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
  const sources = await draftSources(userId, workspaceId);
  if (!sources.length) throw new HomeDashboardError("noDatabases", "The workspace has no databases to show");
  const prompt = homeDashboardPrompt(sources);
  const messages: AiMessage[] = [{ role: "user", content: prompt.prompt }];
  let best: DashboardWidget[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await complete({ feature: "home.dashboard", userId, workspaceId, system: prompt.system, messages, signal, skipRateLimit: attempt > 0 });
    const checked = result.stopReason === "length" ? null : checkDraft(readDraftJson(result.text), sources);
    if (checked && !checked.problems.length) return checked.widgets;
    if (checked && checked.widgets.length > best.length) best = checked.widgets;
    const problems = checked ? checked.problems : ["The answer was cut off: use fewer widgets."];
    messages.push(result.message, { role: "user", content: homeDashboardRepair(problems) });
  }
  if (best.length) return best;
  throw new HomeDashboardError("unusable", "The AI's dashboard couldn't be used");
}

/** A database a draft may show: as the model is told of it, with its properties as stored for checking. */
type Draftable = DashboardSource & { stored: { id: string; name: string; type: PropertyType; options: PropertyOptions }[] };

/** The databases a draft may show, edited last first, with what the owner may see of each. */
async function draftSources(userId: string, workspaceId: string): Promise<Draftable[]> {
  const found = await db
    .select({ id: page.id, title: page.title })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), eq(page.kind, "database"), eq(page.inTemplate, false), isNull(page.archivedAt), pageVisibleTo(userId)))
    .orderBy(desc(page.updatedAt))
    .limit(DRAFT_DATABASES);
  if (!found.length) return [];
  const rows = await db
    .select({ databaseId: page.parentId, n: count() })
    .from(page)
    .where(and(inArray(page.parentId, found.map((d) => d.id)), isNull(page.archivedAt), eq(page.isTemplate, false)))
    .groupBy(page.parentId);
  const counts = new Map(rows.map((r) => [r.databaseId, r.n]));
  return Promise.all(
    found.map(async (d) => {
      const [all, access] = await Promise.all([getProperties(d.id), propertyAccessFor(userId, d.id)]);
      const stored = access.visible(all).slice(0, DRAFT_PROPERTIES);
      return {
        id: d.id,
        title: d.title,
        rows: counts.get(d.id) ?? 0,
        properties: stored.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          ...(p.options.options?.length ? { options: p.options.options.slice(0, DRAFT_OPTIONS).map((o) => o.name) } : {}),
        })),
        stored,
      };
    }),
  );
}

/**
 * The model's widgets that can be shown, with what is wrong with the others. Each is checked as a
 * stored widget (parseDashboard) and then against the databases it was given: an id it made up, or
 * a property its database doesn't have or that can't group or be measured, leaves the widget out.
 */
export function checkDraft(answer: unknown, sources: Draftable[]): { widgets: DashboardWidget[]; problems: string[] } {
  const list = answer && typeof answer === "object" ? (answer as { widgets?: unknown }).widgets : null;
  if (!Array.isArray(list) || !list.length) return { widgets: [], problems: ['Answer with {"widgets": [...]}, at least two widgets.'] };
  const problems: string[] = [];
  const widgets: DashboardWidget[] = [];
  list.forEach((item, index) => {
    const n = index + 1;
    const withId = item && typeof item === "object" ? { ...(item as object), id: `w${n}` } : item;
    const [widget] = parseDashboard(JSON.stringify([withId]));
    if (!widget) return problems.push(`Widget ${n} isn't a widget: it needs databaseId, span and view.`);
    const source = sources.find((s) => s.id === widget.databaseId);
    if (!source) return problems.push(`Widget ${n}: ${widget.databaseId} is none of the databases given.`);
    if (widget.view.type !== "chart" && widget.view.type !== "list") return problems.push(`Widget ${n}: use a number, a chart or a list.`);
    const props = new Map(source.stored.map((p) => [p.id, p]));
    const config: ViewConfig = widget.view.config;
    const groupBy = config.groupBy ? props.get(config.groupBy) : undefined;
    if (config.groupBy && !groupBy) return problems.push(`Widget ${n}: ${config.groupBy} is no property of "${source.title}".`);
    if (widget.view.type === "chart" && config.chartType !== "number") {
      if (!groupBy) return problems.push(`Widget ${n}: a chart needs groupBy.`);
      if (!isGroupableProperty(groupBy)) return problems.push(`Widget ${n}: "${groupBy.name}" can't group rows.`);
    }
    const measure = config.chartAggregate;
    if (measure) {
      const prop = props.get(measure.propertyId);
      if (!prop) return problems.push(`Widget ${n}: ${measure.propertyId} is no property of "${source.title}".`);
      if (!chartAggregateFunctionsOf(prop).includes(measure.fn)) {
        return problems.push(`Widget ${n}: "${prop.name}" can't be measured with ${measure.fn}.`);
      }
    }
    const view = widget.view.type === "list" && !config.sorts?.length ? { ...widget.view, config: { ...config, sorts: [{ ...RECENT_ROWS_SORT }] } } : widget.view;
    widgets.push({ ...widget, id: crypto.randomUUID().slice(0, 8), view });
  });
  return { widgets: arranged(widgets), problems };
}

const isNumber = (w: DashboardWidget) => w.view.type === "chart" && w.view.config.chartType === "number";

/**
 * Numbers first, sharing the first row between them, then the rest as the model placed them: a
 * grid row is as tall as its tallest widget, so a number beside a chart would stand in an empty box.
 */
function arranged(widgets: DashboardWidget[]): DashboardWidget[] {
  const numbers = widgets.filter(isNumber);
  const rest = widgets.filter((w) => !isNumber(w));
  if (!numbers.length || numbers.length > DASHBOARD_COLUMNS) return [...numbers, ...rest];
  const base = Math.floor(DASHBOARD_COLUMNS / numbers.length);
  const spread = numbers.map((w, i) => ({ ...w, span: (i === numbers.length - 1 ? DASHBOARD_COLUMNS - base * i : base) as WidgetSpan }));
  return [...spread, ...rest];
}
