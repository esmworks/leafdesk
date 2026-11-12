/**
 * The sidebar's sections and how each person arranges them in each workspace: their order, which
 * are hidden and which are folded. Kept with each membership (see server/workspaces.ts), so a
 * personal workspace and a company one can look different, on every device.
 */

import { cleanAgentArrangement, type AgentArrangement } from "./agent-arrangement";

/**
 * The sections in their default order. "pages" is the workspace's default teamspace shown as its
 * plain pages, which only Leafdesk on one computer does (lib/env.ts localMode); elsewhere it is empty.
 * An order saved before a section existed has it after the sections it lists; "tasks", "meetings"
 * and "agents", sections once, are on the sidebar's rail now and dropped from saved layouts like any
 * unknown name.
 */
export const SIDEBAR_SECTIONS = ["favorites", "pages", "teamspaces", "shared", "private"] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

export type SidebarLayout = {
  /** Sections in the order shown; ones it doesn't list follow in the default order. */
  order?: SidebarSection[];
  /** Sections left out of the sidebar. */
  hidden?: SidebarSection[];
  /** Sections showing only their heading. */
  folded?: SidebarSection[];
  /** How the agents' list is grouped and ordered (lib/agent-arrangement.ts). */
  agents?: AgentArrangement;
  /** Teamspace ids in the order the person put them; ones it doesn't list follow in the usual order. */
  teamspaces?: string[];
};

/** At most this many teamspaces are kept in a saved order. */
export const MAX_TEAMSPACE_ORDER = 500;

export const isSidebarSection = (value: unknown): value is SidebarSection => SIDEBAR_SECTIONS.includes(value as SidebarSection);

/** Every section in the layout's order. */
export function sidebarOrder(layout: SidebarLayout): SidebarSection[] {
  const listed = (layout.order ?? []).filter(isSidebarSection);
  const order = [...new Set([...listed, ...SIDEBAR_SECTIONS])];
  // An order saved before "pages" existed: it goes where its teamspace was, just above the teamspaces.
  if (!listed.includes("pages")) {
    order.splice(order.indexOf("pages"), 1);
    order.splice(order.indexOf("teamspaces"), 0, "pages");
  }
  return order;
}

/** A layout from untrusted input: unknown sections and duplicates dropped, null when it isn't one. */
export function cleanSidebarLayout(input: unknown): SidebarLayout | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: SidebarLayout = {};
  for (const key of ["order", "hidden", "folded"] as const) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return null;
    out[key] = [...new Set(value.filter(isSidebarSection))];
  }
  const teamspaces = (input as Record<string, unknown>).teamspaces;
  if (teamspaces !== undefined) {
    if (!Array.isArray(teamspaces)) return null;
    const ids = teamspaces.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 100);
    out.teamspaces = [...new Set(ids)].slice(0, MAX_TEAMSPACE_ORDER);
  }
  const agents = (input as Record<string, unknown>).agents;
  if (agents !== undefined) {
    const arrangement = cleanAgentArrangement(agents);
    if (!arrangement) return null;
    out.agents = arrangement;
  }
  return out;
}

/** The layout with `section` added to or taken out of one of its lists. */
export function withSection(layout: SidebarLayout, key: "hidden" | "folded", section: SidebarSection, on: boolean): SidebarLayout {
  const rest = (layout[key] ?? []).filter((s) => s !== section);
  return { ...layout, [key]: on ? [...rest, section] : rest };
}

/** The teamspaces in the person's order (`order`, saved ids); the ones it doesn't name follow as they came. */
export function inTeamspaceOrder<T extends { id: string }>(spaces: T[], order: string[] | undefined): T[] {
  if (!order?.length) return spaces;
  const rank = new Map(order.map((id, index) => [id, index]));
  return spaces
    .map((space, index) => ({ space, index, rank: rank.get(space.id) ?? Infinity }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((s) => s.space);
}

/**
 * The teamspace ids `ids` (as shown) with `id` moved to `index`, a place between them counted
 * before the move (0: first, ids.length: last); unchanged when it isn't among them.
 */
export function moveTeamspace(ids: string[], id: string, index: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const rest = ids.filter((other) => other !== id);
  const to = Math.min(Math.max(index > from ? index - 1 : index, 0), rest.length);
  return [...rest.slice(0, to), id, ...rest.slice(to)];
}
