"use server";

import type { WorkspaceGraph } from "@/lib/graph";
import { workspaceGraph } from "@/server/graph";
import { requireUserId } from "@/server/session";

/** The workspace graph as the user may see it (server/graph), for the graph beside a page. */
export async function workspaceGraphAction(workspaceId: string): Promise<WorkspaceGraph> {
  const userId = await requireUserId();
  return workspaceGraph(userId, String(workspaceId));
}
