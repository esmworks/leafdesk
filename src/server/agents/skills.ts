/**
 * Skills given to an agent: pages its owners chose for it to follow on every run, after its own
 * instructions. A skill's body is followed as instructions, so a run uses one only while no one but
 * the workspace's owners may edit it (members, teamspaces, groups, guests and agents, the agent
 * itself too, all count). Owners can't give an agent a skill others may edit, and a run checks
 * again: a skill that is no longer one, or that someone else may now edit, is left out and the run
 * says so in its steps.
 */
import { and, asc, eq, max, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentSkill, page } from "@/db/schema";
import { MAX_AGENT_SKILL_CHARS, MAX_AGENT_SKILLS, type AgentSkillRecord, type AgentSkillView } from "@/lib/agents";
import { pageLabel } from "@/lib/labels";
import { describeSkill } from "@/lib/skills";
import { AccessError, ConnectedAppReadOnlyError, editableByNonOwners, requirePageAccess } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { labelPageLinks } from "@/server/mentions";
import { AgentError, auditDetails, ownedAgent } from "./manage";

type SkillState = {
  id: string;
  title: string;
  icon: string | null;
  description: string;
  /** Still a skill of the workspace: marked, a page, not in the trash or a template. */
  skill: boolean;
  /** Someone besides the workspace's owners may edit it. */
  editable: boolean;
  /** The viewer may open it (no viewer: true). */
  visible: boolean;
};

/**
 * Where these pages stand as skills of the workspace, and whether `viewer` may open them. Who
 * else may edit a page is asked only of pages that are still skills: it is one access check per
 * member who isn't an owner.
 */
async function skillStates(workspaceId: string, pageIds: string[], viewer?: string): Promise<Map<string, SkillState>> {
  if (!pageIds.length) return new Map();
  const rows = await db.execute<{
    id: string;
    title: string;
    icon: string | null;
    skill_description: string;
    body: string;
    skill: boolean;
    editable: boolean;
    visible: boolean;
  }>(sql`
    select s.*, s.skill and ${editableByNonOwners(workspaceId, sql.raw(`"s"."id"`))} as editable
    from (
      select p.id, p.title, p.icon, p.skill_description, left(p.content_text, 400) as body,
        (p.workspace_id = ${workspaceId} and p.is_skill and p.kind = 'page' and p.archived_at is null
          and not p.is_template and not p.in_template) as skill,
        ${viewer ? sql`page_access_level(${viewer}, p.id) > 0` : sql`true`} as visible
      from ${page} p
      where p.id in (${sql.join(
        pageIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    ) s
  `);
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        title: r.title,
        icon: r.icon,
        description: describeSkill(r.skill_description, r.body).description,
        skill: r.skill,
        editable: r.editable,
        visible: r.visible,
      },
    ]),
  );
}

const attachedIds = async (agentId: string) =>
  (await db.select({ pageId: agentSkill.pageId }).from(agentSkill).where(eq(agentSkill.agentId, agentId)).orderBy(asc(agentSkill.position), asc(agentSkill.createdAt))).map(
    (r) => r.pageId,
  );

/** The agent's skills for an owner, in the order runs follow them; those they can't open are only counted. */
export async function listAgentSkills(userId: string, agentId: string): Promise<{ skills: AgentSkillView[]; hidden: number }> {
  const agent = await ownedAgent(userId, agentId);
  const ids = await attachedIds(agent.id);
  const states = await skillStates(agent.workspaceId, ids, userId);
  const skills: AgentSkillView[] = [];
  let hidden = 0;
  for (const id of ids) {
    const state = states.get(id);
    if (!state?.visible) {
      hidden += 1;
      continue;
    }
    skills.push({
      pageId: id,
      title: state.title,
      icon: state.icon,
      description: state.description,
      status: !state.skill ? "notASkill" : state.editable ? "editable" : "usable",
    });
  }
  return { skills, hidden };
}

/**
 * Gives the agent a skill of its workspace the owner may open. Refused when the page isn't a
 * skill, or when someone besides the workspace's owners may edit it: its body would become
 * the agent's orders.
 */
export async function addAgentSkill(userId: string, agentId: string, pageId: string) {
  const agent = await ownedAgent(userId, agentId);
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to give it skills");
  const found = await requirePageAccess(userId, pageId, "view").catch((error) => {
    if (error instanceof AccessError && !(error instanceof ConnectedAppReadOnlyError)) throw new AgentError("notAPage", "Page not found");
    throw error;
  });
  if (found.workspaceId !== agent.workspaceId) throw new AgentError("notAPage", "Page not found");
  const state = (await skillStates(agent.workspaceId, [pageId])).get(pageId);
  if (!state?.skill) throw new AgentError("notASkill", "This page isn't a skill");
  const title = pageLabel(state.title);
  if (state.editable) throw new AgentError("skillEditable", "Someone besides the workspace's owners may edit this skill", { title });
  const ids = await attachedIds(agent.id);
  if (ids.includes(pageId)) return;
  if (ids.length >= MAX_AGENT_SKILLS) throw new AgentError("tooManySkills", `An agent has at most ${MAX_AGENT_SKILLS} skills`, { max: String(MAX_AGENT_SKILLS) });
  const [last] = await db.select({ position: max(agentSkill.position) }).from(agentSkill).where(eq(agentSkill.agentId, agent.id));
  await db
    .insert(agentSkill)
    .values({ agentId: agent.id, pageId, position: (last?.position ?? -1) + 1, addedBy: userId })
    .onConflictDoNothing();
  await recordAudit({
    workspaceId: agent.workspaceId,
    actorId: userId,
    action: "agent.updated",
    target: { type: "user", id: agent.userId, label: agent.name },
    details: { ...auditDetails(agent), previous: auditDetails(agent), skillAdded: { pageId, title } },
  });
}

/** Takes a skill from the agent (also one the owner can't open, or that is no longer a skill). */
export async function removeAgentSkill(userId: string, agentId: string, pageId: string) {
  const agent = await ownedAgent(userId, agentId);
  const removed = await db
    .delete(agentSkill)
    .where(and(eq(agentSkill.agentId, agent.id), eq(agentSkill.pageId, pageId)))
    .returning({ pageId: agentSkill.pageId });
  if (!removed.length) return;
  await recordAudit({
    workspaceId: agent.workspaceId,
    actorId: userId,
    action: "agent.updated",
    target: { type: "user", id: agent.userId, label: agent.name },
    details: { ...auditDetails(agent), previous: auditDetails(agent), skillRemoved: { pageId } },
  });
}

/** A skill a run follows: its title and its body as Markdown. */
export type RunSkill = { pageId: string; title: string; body: string };

/**
 * The skills a run of the agent follows, checked now, and a step for each: used, or left out and
 * why. Together they read at most `room` characters (and MAX_AGENT_SKILL_CHARS); a skill that
 * doesn't fit is left out whole, never cut. Page links are named as the agent may see them.
 */
export async function runSkills(
  agent: { id: string; workspaceId: string; userId: string },
  room: number,
): Promise<{ skills: RunSkill[]; steps: AgentSkillRecord[] }> {
  const ids = await attachedIds(agent.id);
  const states = await skillStates(agent.workspaceId, ids);
  const skills: RunSkill[] = [];
  const steps: AgentSkillRecord[] = [];
  let left = Math.min(MAX_AGENT_SKILL_CHARS, room);
  for (const id of ids) {
    const state = states.get(id);
    if (!state) continue;
    const title = pageLabel(state.title);
    if (!state.skill || state.editable) {
      steps.push({ kind: "skill", pageId: id, title, outcome: "skipped", reason: state.skill ? "editable" : "notASkill" });
      continue;
    }
    const content = await getCollab().readPage(id);
    const body = (await labelPageLinks(agent.userId, content.markdown)).trim();
    const name = pageLabel(content.title || state.title);
    if (body.length + name.length + 40 > left) {
      steps.push({ kind: "skill", pageId: id, title: name, outcome: "skipped", reason: "tooLong" });
      continue;
    }
    left -= body.length + name.length + 40;
    skills.push({ pageId: id, title: name, body });
    steps.push({ kind: "skill", pageId: id, title: name, outcome: "used" });
  }
  return { skills, steps };
}
