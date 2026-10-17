import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { page } from "@/db/schema";
import { ownerSeesRun, runPageOf, type AgentRunSource } from "@/lib/agents";
import { pageVisibleTo, workspaceOwnerIds } from "@/server/access";

/**
 * Who answers the call an agent's run waits on: the owners the run is for (lib/agents
 * ownerSeesRun), since the call's input can quote what the run read. They alone are asked in
 * their inbox, see the call there and in the agent's runs, and may answer it. When the run is
 * for no owner (a row none of them can open), no one is asked and the call runs out of time,
 * sending nothing.
 */
export async function approversOf(run: { workspaceId: string; source: AgentRunSource }): Promise<string[]> {
  const owners = await workspaceOwnerIds(run.workspaceId);
  const pageId = runPageOf(run.source);
  const opens = pageId
    ? await Promise.all(owners.map(async (userId) => (await db.select({ id: page.id }).from(page).where(and(eq(page.id, pageId), pageVisibleTo(userId)))).length > 0))
    : owners.map(() => false);
  return owners.filter((userId, i) => ownerSeesRun(run.source, userId, opens[i]));
}

/** Of these runs, those whose waiting call `userId`, an owner of their workspace, answers (as approversOf). */
export async function runsAnsweredBy(userId: string, runs: { id: string; source: AgentRunSource }[]): Promise<Set<string>> {
  const pageIds = [...new Set(runs.flatMap((r) => runPageOf(r.source) ?? []))];
  const open = new Set(
    pageIds.length ? (await db.select({ id: page.id }).from(page).where(and(inArray(page.id, pageIds), pageVisibleTo(userId)))).map((p) => p.id) : [],
  );
  return new Set(
    runs.filter((r) => {
      const pageId = runPageOf(r.source);
      return ownerSeesRun(r.source, userId, pageId !== null && open.has(pageId));
    }).map((r) => r.id),
  );
}
