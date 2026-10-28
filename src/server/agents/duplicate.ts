/**
 * Copying an agent: a new agent with the setup of one that works, to change for another team or
 * job. The copy takes how the agent behaves (its name numbered like a page's copy, icon,
 * description, instructions, model, web access, how it changes rows, monthly token limit, whether
 * it is paused, its skills, the agents it can ask and the tools of its connections), and none of
 * what it reaches or who uses it: no pages are shared with the copy, it is shared as a new agent
 * is (manage.ts createAgent), and it has no schedules, connection triggers, memory, runs, chats,
 * versions or usage of the source.
 *
 * Who may: whoever may create agents in the workspace and edit the agent (they can read its
 * instructions). An archived agent can be copied too; the copy is live. What the copier couldn't
 * give an agent themselves is left out and said so (`leftOut`): skills they can't open or others
 * may now edit, agents it can ask that aren't shared with them, and connection tools unless they
 * are an owner (only owners give those, connections/manage.ts setAgentGrant).
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agentGrant, agentSkill, workspaceAgent } from "@/db/schema";
import { numberedCopyTitle } from "@/lib/duplicate";
import type { AgentView, CopyLeftOut } from "@/lib/agents";
import { helperIdsOf } from "./helpers";
import { agentWithLevel, agentLevels, requireAgentCreator } from "./sharing";
import { copyableSkills } from "./skills";
import { createAgent, type AgentInput } from "./manage";

/**
 * Copies the agent for `userId`. `overrides` (a name, instructions…) replace what is copied; what
 * they leave out comes from the agent.
 */
export async function duplicateAgent(userId: string, agentId: string, overrides: AgentInput = {}): Promise<{ agent: AgentView; leftOut: CopyLeftOut }> {
  const { agent: source, owner } = await agentWithLevel(userId, agentId, "edit");
  await requireAgentCreator(userId, source.workspaceId);
  const workspaceId = source.workspaceId;

  const names = (await db.select({ name: workspaceAgent.name }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.name);
  const helpers = (await helperIdsOf([source.id])).get(source.id) ?? [];
  const live = new Set(
    (await db.select({ id: workspaceAgent.id }).from(workspaceAgent).where(and(eq(workspaceAgent.workspaceId, workspaceId), isNull(workspaceAgent.archivedAt)))).map((a) => a.id),
  );
  const levels = await agentLevels(userId, workspaceId, helpers);
  const keptHelpers = helpers.filter((id) => live.has(id) && levels.get(id) !== "none");
  const skills = (await db.select({ pageId: agentSkill.pageId }).from(agentSkill).where(eq(agentSkill.agentId, source.id)).orderBy(asc(agentSkill.position), asc(agentSkill.createdAt))).map(
    (s) => s.pageId,
  );
  const keptSkills = await copyableSkills(userId, workspaceId, skills);
  const grants = await db.select().from(agentGrant).where(eq(agentGrant.agentId, source.id));
  const keptGrants = owner ? grants : [];

  const input: AgentInput = {
    name: numberedCopyTitle(source.name, names) || source.name,
    icon: source.icon,
    description: source.description,
    instructions: source.instructions,
    // An archived agent was paused when it was archived; its copy starts working.
    enabled: source.archivedAt ? true : source.enabled,
    webAccess: source.webAccess,
    mailRecipients: source.mailRecipients,
    monthlyTokenLimit: source.monthlyTokenLimit,
    model: source.model,
    rowChanges: source.rowChanges,
    helperAgentIds: keptHelpers,
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
  };
  const agent = await createAgent(userId, workspaceId, input, {
    copiedFrom: source,
    setUp: async (tx, created) => {
      if (keptSkills.length) await tx.insert(agentSkill).values(keptSkills.map((pageId, position) => ({ agentId: created.id, pageId, position, addedBy: userId })));
      if (keptGrants.length) await tx.insert(agentGrant).values(keptGrants.map((g) => ({ agentId: created.id, connectionId: g.connectionId, tools: g.tools })));
    },
  });

  const leftOut: CopyLeftOut = {};
  if (keptSkills.length < skills.length) leftOut.skills = skills.length - keptSkills.length;
  if (keptHelpers.length < helpers.length) leftOut.helpers = helpers.length - keptHelpers.length;
  if (keptGrants.length < grants.length) leftOut.connections = grants.length - keptGrants.length;
  return { agent, leftOut };
}
