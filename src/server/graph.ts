/**
 * The workspace graph for someone (see lib/graph): the pages they can open, and the edges between
 * them. An edge needs both of its pages in the graph, so a page they can't open isn't hinted at,
 * not even by an edge; a relation counts only where they may see that property's value in that row
 * (property-access.ts).
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { page, pageLink } from "@/db/schema";
import { uniqueEdges, type GraphEdge, type GraphNode, type GraphNodeKind, type WorkspaceGraph } from "@/lib/graph";
import { atLeast } from "@/lib/property-access";
import { AccessError, getMembership, pageVisibleTo } from "@/server/access";
import { loadProperties } from "@/server/derived";
import { propertyAccessFor } from "@/server/property-access";

/** Pages the graph shows at most; past this the ones edited longest ago are left out. */
export const MAX_GRAPH_NODES = 3000;

const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function workspaceGraph(userId: string, workspaceId: string, { maxNodes = MAX_GRAPH_NODES } = {}): Promise<WorkspaceGraph> {
  // Members and guests (who see only what is shared with them); the workspace's sign-in policies apply.
  if (!(await getMembership(userId, workspaceId))) throw new AccessError();

  const parent = alias(page, "parent");
  const rows = await db
    .select({ id: page.id, title: page.title, icon: page.icon, kind: page.kind, parentId: page.parentId, parentKind: parent.kind })
    .from(page)
    .leftJoin(parent, eq(parent.id, page.parentId))
    .where(and(eq(page.workspaceId, workspaceId), isNull(page.archivedAt), eq(page.inTemplate, false), pageVisibleTo(userId)))
    .orderBy(desc(page.updatedAt), desc(page.id))
    .limit(maxNodes + 1);
  const truncated = rows.length > maxNodes;
  const shown = rows.slice(0, maxNodes);
  const kindOf = (r: (typeof shown)[number]): GraphNodeKind =>
    r.kind === "database" ? "database" : r.parentKind === "database" ? "row" : "page";
  const nodes: GraphNode[] = shown.map((r) => ({ id: r.id, title: r.title, icon: r.icon, kind: kindOf(r) }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];

  // The page tree.
  for (const r of shown) if (r.parentId) edges.push({ source: r.parentId, target: r.id, kind: "child" });

  // Links in page bodies (kept by server/mentions.ts as pages are saved), between pages shown.
  const shownIds = [...ids];
  const links = shownIds.length
    ? await db
        .select({ source: pageLink.sourceId, target: pageLink.targetId })
        .from(pageLink)
        .where(and(inArray(pageLink.sourceId, shownIds), inArray(pageLink.targetId, shownIds)))
    : [];
  for (const l of links) edges.push({ source: l.source, target: l.target, kind: "link" });

  // Relations: each database's relation properties, in the rows shown, where the viewer sees them.
  const databaseIds = shown.filter((r) => r.kind === "database").map((r) => r.id);
  const relationsOf = new Map(
    [...(await loadProperties(databaseIds))]
      .map(([databaseId, props]) => [databaseId, props.filter((p) => p.type === "relation")] as const)
      .filter(([, props]) => props.length),
  );
  const rowIds = shown.filter((r) => r.parentId && relationsOf.has(r.parentId)).map((r) => r.id);
  if (rowIds.length) {
    const values = await db
      .select({ id: page.id, parentId: page.parentId, properties: page.properties, createdBy: page.createdBy })
      .from(page)
      .where(inArray(page.id, rowIds));
    const byDatabase = [...Map.groupBy(values, (v) => v.parentId!)];
    const accessOf = await Promise.all(byDatabase.map(([databaseId]) => propertyAccessFor(userId, databaseId)));
    for (const [i, [databaseId, inDatabase]] of byDatabase.entries()) {
      const access = accessOf[i];
      for (const row of inDatabase) {
        for (const prop of relationsOf.get(databaseId) ?? []) {
          if (!atLeast(access.levelOf(prop.id, row), "view")) continue;
          for (const target of asIds(row.properties[prop.id])) edges.push({ source: row.id, target, kind: "relation" });
        }
      }
    }
  }

  return { nodes, edges: uniqueEdges(edges, ids), truncated };
}
