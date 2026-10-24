/**
 * The sidebar's sections and how each person arranges them in each workspace: their order, which
 * are hidden and which are folded. Kept with each membership (see server/workspaces.ts), so a
 * personal workspace and a company one can look different, on every device.
 */

/**
 * The sections in their default order. "pages" is the workspace's default teamspace shown as its
 * plain pages, which only Leafdesk on one computer does (lib/env.ts localMode); elsewhere it is empty.
 * "meetings" and "tasks" are links to the Meetings and My tasks pages; an order saved before a
 * section existed has it after the sections it lists.
 */
export const SIDEBAR_SECTIONS = ["favorites", "tasks", "meetings", "pages", "teamspaces", "shared", "private"] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

export type SidebarLayout = {
  /** Sections in the order shown; ones it doesn't list follow in the default order. */
  order?: SidebarSection[];
  /** Sections left out of the sidebar. */
  hidden?: SidebarSection[];
  /** Sections showing only their heading. */
  folded?: SidebarSection[];
};

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
  return out;
}

/** The layout with `section` added to or taken out of one of its lists. */
export function withSection(layout: SidebarLayout, key: "hidden" | "folded", section: SidebarSection, on: boolean): SidebarLayout {
  const rest = (layout[key] ?? []).filter((s) => s !== section);
  return { ...layout, [key]: on ? [...rest, section] : rest };
}
