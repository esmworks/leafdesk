/**
 * Skills given to an agent: pages its owners chose for it to follow on every run, after its own
 * instructions. A skill's body is followed as instructions, so a run uses one only while no one but
 * the workspace's owners may edit it (members, teamspaces, groups, guests and agents, the agent
 * itself too, all count). Owners can't give an agent a skill others may edit, and a run checks
 * again: a skill that is no longer one, or that someone else may now edit, is left out and the run
 * says so in its steps. A run held to someone's access (the member whose change started it, or a
 * public form's publisher) also leaves out the skills that person can't open, as it does pages.
 */
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentSkill, page, workspaceAgent } from "@/db/schema";
import { MAX_AGENT_SKILL_CHARS, MAX_AGENT_SKILLS, type AgentSkillRecord, type AgentSkillSkip, type AgentSkillView } from "@/lib/agents";
import { pageLabel } from "@/lib/labels";
import { describeSkill } from "@/lib/skills";
import { AccessError, ConnectedAppReadOnlyError, pagesOthersMayEdit, requirePageAccess } from "@/server/access";
import { aiConfig, contentChars } from "@/server/ai";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { labelPageLinks } from "@/server/mentions";
import { expandSyncedMarkdown } from "@/server/synced-blocks";
import { isSkill } from "@/server/skills";
import { AgentError, auditDetails, agentFor } from "./manage";
import { recordAgentVersion } from "./version-record";

type SkillState = {
  id: string;
  title: string;
  icon: string | null;
  description: string;
  /** Still a skill of the workspace: marked, a page, not in the trash or a template. */
  skill: boolean;
  /** Someone besides the workspace's owners may edit it. */
  editable: boolean;
  /** `viewer` may open it (no viewer: true). */
  visible: boolean;
};

/** Where these pages stand as skills of the workspace, and whether `viewer` may open them. */
async function skillStates(workspaceId: string, pageIds: string[], viewer?: string): Promise<Map<string, SkillState>> {
  if (!pageIds.length) return new Map();
  const rows = await db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      skillDescription: page.skillDescription,
      body: sql<string>`left(${page.contentText}, 400)`,
      skill: sql<boolean>`(${page.workspaceId} = ${workspaceId} and ${isSkill("page")})`,
      visible: viewer ? sql<boolean>`page_access_level(${viewer}, ${page.id}) > 0` : sql<boolean>`true`,
    })
    .from(page)
    .where(inArray(page.id, pageIds));
  // Who else may edit is asked only of pages that are still skills.
  const editable = await pagesOthersMayEdit(
    workspaceId,
    rows.filter((r) => r.skill).map((r) => r.id),
  );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        title: r.title,
        icon: r.icon,
        description: describeSkill(r.skillDescription, r.body).description,
        skill: r.skill,
        editable: editable.has(r.id),
        visible: r.visible,
      },
    ]),
  );
}

/** What the <skill> tag around a skill adds to the prompt, about. */
const SKILL_OVERHEAD = 40;

/** How much of a run's prompt its skills may take, together. */
export const agentSkillRoom = () => Math.min(MAX_AGENT_SKILL_CHARS, Math.floor(contentChars(aiConfig().limits) / 4));

const attachedIds = async (agentId: string) =>
  (await db.select({ pageId: agentSkill.pageId }).from(agentSkill).where(eq(agentSkill.agentId, agentId)).orderBy(asc(agentSkill.position), asc(agentSkill.createdAt))).map(
    (r) => r.pageId,
  );

type Fitted = { pageId: string; title: string } & ({ body: string } | { reason: AgentSkillSkip });

/**
 * The agent's skills in order, each with its body as a run reads it (Markdown, page links named as
 * the agent may see them), or why a run leaves it out: `leftOut` says so for one it can't follow,
 * and a skill that doesn't fit in `room` with the ones before it is left out whole, never cut.
 * The bodies are read together.
 */
async function fitSkills(
  agent: { userId: string },
  ids: string[],
  states: Map<string, SkillState>,
  room: number,
  leftOut: (state: SkillState) => AgentSkillSkip | null,
): Promise<Fitted[]> {
  const read = new Map(
    await Promise.all(
      ids
        .filter((id) => {
          const state = states.get(id);
          return state && !leftOut(state);
        })
        .map(async (id) => {
          const content = await getCollab().readPage(id);
          const body = (await labelPageLinks(agent.userId, await expandSyncedMarkdown(agent.userId, id, content.markdown))).trim();
          return [id, { title: pageLabel(content.title || states.get(id)!.title), body }] as const;
        }),
    ),
  );
  const fitted: Fitted[] = [];
  let left = room;
  for (const id of ids) {
    const state = states.get(id);
    if (!state) continue;
    const reason = leftOut(state);
    const found = read.get(id);
    if (reason || !found) {
      fitted.push({ pageId: id, title: pageLabel(state.title), reason: reason ?? "notASkill" });
      continue;
    }
    const size = found.body.length + found.title.length + SKILL_OVERHEAD;
    if (size > left) {
      fitted.push({ pageId: id, title: found.title, reason: "tooLong" });
      continue;
    }
    left -= size;
    fitted.push({ pageId: id, title: found.title, body: found.body });
  }
  return fitted;
}

/** Why no run follows the skill, whoever started it. */
const neverFollowed = (state: SkillState): AgentSkillSkip | null => (!state.skill ? "notASkill" : state.editable ? "editable" : null);

/**
 * The agent's skills for an owner, in the order runs follow them; those they can't open are only
 * counted. Whether one fits is told as a run started by an owner would count, so a run held to
 * someone who can't open some of the skills has more room than this says.
 */
export async function listAgentSkills(userId: string, agentId: string): Promise<{ skills: AgentSkillView[]; hidden: number }> {
  const agent = await agentFor(userId, agentId, "interact");
  const ids = await attachedIds(agent.id);
  const states = await skillStates(agent.workspaceId, ids, userId);
  const fitted = new Map((await fitSkills(agent, ids, states, agentSkillRoom(), neverFollowed)).map((f) => [f.pageId, f]));
  const skills: AgentSkillView[] = [];
  let hidden = 0;
  for (const id of ids) {
    const state = states.get(id);
    const fit = fitted.get(id);
    if (!state || !fit) continue;
    if (!state.visible) {
      hidden += 1;
      continue;
    }
    const status = "reason" in fit ? fit.reason : "usable";
    skills.push({
      pageId: id,
      title: state.title,
      icon: state.icon,
      description: state.description,
      status: status === "notASkill" || status === "editable" || status === "tooLong" ? status : "usable",
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
  const agent = await agentFor(userId, agentId, "edit");
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
  // One at a time per agent, so two owners adding at once can't go past the limit.
  const added = await db.transaction(async (tx) => {
    await tx.select({ id: workspaceAgent.id }).from(workspaceAgent).where(eq(workspaceAgent.id, agent.id)).for("update");
    const ids = (await tx.select({ pageId: agentSkill.pageId }).from(agentSkill).where(eq(agentSkill.agentId, agent.id))).map((r) => r.pageId);
    if (ids.includes(pageId)) return false;
    if (ids.length >= MAX_AGENT_SKILLS) throw new AgentError("tooManySkills", `An agent has at most ${MAX_AGENT_SKILLS} skills`, { max: String(MAX_AGENT_SKILLS) });
    const [last] = await tx.select({ position: max(agentSkill.position) }).from(agentSkill).where(eq(agentSkill.agentId, agent.id));
    await tx.insert(agentSkill).values({ agentId: agent.id, pageId, position: (last?.position ?? -1) + 1, addedBy: userId });
    return true;
  });
  if (!added) return;
  await recordAudit({
    workspaceId: agent.workspaceId,
    actorId: userId,
    action: "agent.updated",
    target: { type: "user", id: agent.userId, label: agent.name },
    details: { ...auditDetails(agent), previous: auditDetails(agent), skillAdded: { pageId, title } },
  });
  await recordAgentVersion(userId, agent.id);
}

/** Takes a skill from the agent (also one the owner can't open, or that is no longer a skill). */
export async function removeAgentSkill(userId: string, agentId: string, pageId: string) {
  const agent = await agentFor(userId, agentId, "edit");
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
  await recordAgentVersion(userId, agent.id);
}

/** A skill a run follows: its title and its body as Markdown. */
export type RunSkill = { pageId: string; title: string; body: string };

/**
 * The skills a run of the agent follows, checked now, and a step for each: used, or left out and
 * why. `bound` is whose access holds the run besides the agent's own (see processRun in run.ts):
 * skills they can't open are left out, as their content could end up in the row the run writes.
 */
export async function runSkills(
  agent: { id: string; workspaceId: string; userId: string },
  room: number,
  bound: string | null,
): Promise<{ skills: RunSkill[]; steps: AgentSkillRecord[] }> {
  const ids = await attachedIds(agent.id);
  const states = await skillStates(agent.workspaceId, ids, bound ?? undefined);
  const fitted = await fitSkills(agent, ids, states, room, (state) => neverFollowed(state) ?? (state.visible ? null : "hidden"));
  return {
    skills: fitted.flatMap((f) => ("body" in f ? [{ pageId: f.pageId, title: f.title, body: f.body }] : [])),
    steps: fitted.map((f): AgentSkillRecord =>
      "body" in f ? { kind: "skill", pageId: f.pageId, title: f.title, outcome: "used" } : { kind: "skill", pageId: f.pageId, title: f.title, outcome: "skipped", reason: f.reason },
    ),
  };
}
