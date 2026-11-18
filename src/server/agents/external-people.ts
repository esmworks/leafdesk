/**
 * Outside agents (kind `external`, see external.ts) as the people a person property can name: they
 * are teammates that get assigned work, though their users aren't people (workspacePeople leaves
 * agents out). Offered, and accepted in a value, only to someone who may use the agent (any level
 * on it, as its @ mention in comments is), never to guests.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { workspaceAgent } from "@/db/schema";
import { agentLevels } from "./sharing";

export type OutsideAgentPerson = { id: string; name: string; icon: string | null };

/** The workspace's live outside agents `userId` may use, by name; their user ids are what a person value holds. */
export async function outsideAgentPeople(userId: string, workspaceId: string): Promise<OutsideAgentPerson[]> {
  const rows = await db
    .select({ agentId: workspaceAgent.id, id: workspaceAgent.userId, name: workspaceAgent.name, icon: workspaceAgent.icon })
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.workspaceId, workspaceId), eq(workspaceAgent.kind, "external"), eq(workspaceAgent.enabled, true), isNull(workspaceAgent.archivedAt)))
    .orderBy(asc(workspaceAgent.name));
  if (!rows.length) return [];
  const levels = await agentLevels(userId, workspaceId, rows.map((r) => r.agentId));
  return rows.filter((r) => (levels.get(r.agentId) ?? "none") !== "none").map(({ id, name, icon }) => ({ id, name, icon }));
}
