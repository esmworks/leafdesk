import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, page, type PageKind, type SelectOption } from "@/db/schema";
import { groupAssigned, type AssignedGroupKey } from "@/lib/assigned";
import { dateDays } from "@/lib/date-value";
import { atLeast } from "@/lib/property-access";
import { isDoneStatus, optionOf } from "@/lib/properties";
import { dayString } from "@/lib/time-zone";
import { pageVisibleTo, requireMembership } from "@/server/access";
import { loadProperties } from "@/server/derived";
import { propertyAccessFor } from "@/server/property-access";

/** How many rows the home page lists: enough for a week's work, short enough to keep the page. */
export const ASSIGNED_LIMIT = 25;
/** How many assigned rows are looked at, last edited first, before done ones are left out. */
const CANDIDATE_LIMIT = 1000;

export type AssignedRow = {
  id: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  databaseId: string;
  /** Null when the viewer may open the row but not its database. */
  databaseTitle: string | null;
  /** The first day of the row's first date the viewer may see (`YYYY-MM-DD`), or null. */
  date: string | null;
  /** That date's last day when it is a range, else null. */
  endDate: string | null;
  /** The row's first status the viewer may see, or null. */
  status: SelectOption | null;
  updatedAt: Date;
};

export type AssignedRows = {
  groups: { key: AssignedGroupKey; rows: AssignedRow[] }[];
  /** Every open row assigned to the viewer, of which `groups` holds the first ASSIGNED_LIMIT. */
  total: number;
};

/**
 * The database rows of a workspace that a person property assigns to `userId` and that aren't
 * done, grouped by their date relative to `today` (the viewer's calendar day). Only rows the viewer
 * may open count, and only where they may see the person property that names them; a status or
 * date hidden from them neither shows nor decides anything.
 */
export async function assignedRows(userId: string, workspaceId: string, today: string, timeZone = "UTC"): Promise<AssignedRows> {
  await requireMembership(userId, workspaceId);
  const personProps = await db
    .select({ id: databaseProperty.id, databaseId: databaseProperty.databaseId })
    .from(databaseProperty)
    .innerJoin(page, eq(page.id, databaseProperty.databaseId))
    .where(
      and(
        eq(page.workspaceId, workspaceId),
        eq(page.kind, "database"),
        eq(databaseProperty.type, "person"),
        isNull(databaseProperty.deletedAt),
        isNull(page.archivedAt),
        eq(page.inTemplate, false),
      ),
    );
  if (!personProps.length) return { groups: [], total: 0 };

  const me = JSON.stringify([userId]);
  const candidates = await db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      kind: page.kind,
      parentId: page.parentId,
      properties: page.properties,
      createdBy: page.createdBy,
      updatedAt: page.updatedAt,
    })
    .from(page)
    .where(
      and(
        eq(page.workspaceId, workspaceId),
        isNull(page.archivedAt),
        eq(page.isTemplate, false),
        eq(page.inTemplate, false),
        or(...personProps.map((p) => and(eq(page.parentId, p.databaseId), sql`(${page.properties} -> ${p.id}) @> ${me}::jsonb`))),
        pageVisibleTo(userId),
      ),
    )
    .orderBy(desc(page.updatedAt))
    .limit(CANDIDATE_LIMIT);
  if (!candidates.length) return { groups: [], total: 0 };

  const databaseIds = [...new Set(candidates.map((r) => r.parentId!))];
  const [properties, databases, accessList] = await Promise.all([
    loadProperties(databaseIds),
    // A row can be shared without its database: then the database's name stays hidden too.
    db
      .select({ id: page.id, title: page.title })
      .from(page)
      .where(and(inArray(page.id, databaseIds), pageVisibleTo(userId))),
    Promise.all(databaseIds.map(async (id) => [id, await propertyAccessFor(userId, id)] as const)),
  ]);
  const titles = new Map(databases.map((d) => [d.id, d.title]));
  const access = new Map(accessList);

  const rows: AssignedRow[] = [];
  for (const row of candidates) {
    const databaseId = row.parentId!;
    const props = properties.get(databaseId) ?? [];
    const levels = access.get(databaseId)!;
    const sees = (propertyId: string) => atLeast(levels.levelOf(propertyId, row), "view");
    const value = (propertyId: string) => row.properties[propertyId];

    const namesMe = props.some(
      (p) => p.type === "person" && sees(p.id) && Array.isArray(value(p.id)) && (value(p.id) as unknown[]).includes(userId),
    );
    if (!namesMe) continue;

    const statuses = props.filter((p) => p.type === "status" && sees(p.id));
    if (statuses.some((p) => isDoneStatus(p, value(p.id)))) continue;

    const dateProp = props.find((p) => p.type === "date" && sees(p.id) && dateDays(value(p.id), timeZone));
    // Times count on their day in the viewer's zone.
    const days = dateProp ? dateDays(value(dateProp.id), timeZone) : null;
    rows.push({
      id: row.id,
      title: row.title,
      icon: row.icon,
      kind: row.kind,
      databaseId,
      databaseTitle: titles.get(databaseId) ?? null,
      date: days ? dayString(days.start) : null,
      endDate: days && days.end > days.start ? dayString(days.end) : null,
      status: statuses.map((p) => optionOf(p, value(p.id))).find(Boolean) ?? null,
      updatedAt: row.updatedAt,
    });
  }

  // Keep the first rows in group order, then group those again.
  const shown = groupAssigned(rows, today)
    .flatMap((g) => g.rows)
    .slice(0, ASSIGNED_LIMIT);
  return { groups: groupAssigned(shown, today), total: rows.length };
}
