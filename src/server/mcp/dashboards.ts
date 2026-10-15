import { DASHBOARD_BLOCK, parseDashboard, type DashboardWidget } from "@/lib/dashboard";
import { pageLabel } from "@/lib/labels";
import { AccessError } from "@/server/access";
import * as databases from "@/server/databases";
import { pageUrl } from "./format";
import { describeViewConfig } from "./query";

type Block = { id?: string; type?: string; props?: Record<string, unknown>; children?: Block[] };

export type FoundDashboard = { id: string; widgets: DashboardWidget[] };

/** The dashboards of a page body (in columns too), in reading order. */
export function dashboardsIn(blocks: unknown[]): FoundDashboard[] {
  const found: FoundDashboard[] = [];
  const visit = (list: Block[]) => {
    for (const block of list) {
      if (block.type === DASHBOARD_BLOCK && block.id) found.push({ id: block.id, widgets: parseDashboard(block.props?.widgets) });
      if (block.children?.length) visit(block.children);
    }
  };
  visit(blocks as Block[]);
  return found;
}

async function openDatabase(userId: string, databaseId: string) {
  try {
    const found = await databases.getDatabase(userId, databaseId);
    return { ...found, lookups: await databases.getLookups(userId, found.properties) };
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
}

/**
 * Widgets as the tools describe them: their place and width, and the view each shows with property
 * names. Seeing the page doesn't mean seeing a widget's database: its title and view stay private then.
 */
export async function describeWidgets(userId: string, widgets: DashboardWidget[]) {
  const opened = new Map<string, ReturnType<typeof openDatabase>>();
  return Promise.all(
    widgets.map(async (widget) => {
      if (!opened.has(widget.databaseId)) opened.set(widget.databaseId, openDatabase(userId, widget.databaseId));
      const found = await opened.get(widget.databaseId)!;
      const base = { id: widget.id, title: widget.title || null, width: widget.span, database_id: widget.databaseId };
      if (!found) return { ...base, accessible: false };
      const { database, properties, lookups } = found;
      return {
        ...base,
        accessible: true,
        database_title: pageLabel(database.title),
        in_trash: Boolean(database.archivedAt),
        type: widget.view.type,
        ...describeViewConfig(properties, widget.view.config, lookups, widget.view.type),
        url: pageUrl(database.workspaceId, database.id),
      };
    }),
  );
}

/** A page's dashboards for get_page. */
export async function dashboardsOutput(userId: string, blocks: unknown[]) {
  return Promise.all(dashboardsIn(blocks).map(async (d) => ({ id: d.id, widgets: await describeWidgets(userId, d.widgets) })));
}
