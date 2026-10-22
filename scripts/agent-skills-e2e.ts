/**
 * End-to-end check of agents' skills against the database, with a fake OpenAI-compatible server
 * (src/server/ai/fake-openai.ts): owners (and those who can edit the agent) give an agent skills
 * of its workspace, only ones no one but the workspace's owners may edit (a member, a teamspace, a
 * guest or the agent itself editing one stops it); a run sends the skills' instructions after the
 * agent's own and says which it followed; a skill someone else may edit by the time of the run,
 * that is no longer a skill, that doesn't fit, or that the member who started the run can't open is
 * left out and the run says so; a run that goes on after waiting checks them again; members and
 * owners who can't open a skill don't see it named.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-skills-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, agentSkill, auditEvent, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { addProperty, createRows } = await import("@/server/databases");
const { removePageGroupPermission, removePagePermission, setPageGroupPermission, setPagePermission } = await import("@/server/permissions");
const { createGroup } = await import("@/server/groups");
const { setSkill } = await import("@/server/skills");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
const agents = await import("@/server/agents/manage");
const { addAgentSkill, listAgentSkills, removeAgentSkill } = await import("@/server/agents/skills");
const { flushAgentRuns } = await import("@/server/agents/run");
const automations = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");
const { MAX_AGENT_SKILLS } = await import("@/lib/agents");
type AgentSkillRecord = import("@/lib/agents").AgentSkillRecord;

const RUN = `agent-skills-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi(() => ({ text: "Done." }));
const aiEnv = {
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
};
setAiEnv(aiEnv);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

/** The AgentError code a promise fails with ("" when it doesn't fail, or fails otherwise). */
async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof agents.AgentError ? error.code : `other: ${String(error)}`;
  }
}

const systemOf = (request: FakeChatRequest) => textOf(request.messages.find((m) => m.role === "system")?.content ?? "");

const ids = { owner: `${RUN}-owner`, other: `${RUN}-other`, member: `${RUN}-member`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

/** Runs what an automation queued: the automation's run, then the agent's. */
async function settle() {
  await flushAutomations();
  await flushAgentRuns();
  await flushAutomations();
}

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.other, name: "Owner Oya", email: `${ids.other}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
    { id: ids.guest, name: "Guest Gül", email: `${ids.guest}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.other, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const owner = { userId: ids.owner };

  const tickets = await createPage(owner, { workspaceId, teamspaceId: general.id, kind: "database", title: "Tickets" });
  await addProperty(ids.owner, tickets.id, { name: "Category", type: "select", options: ["Billing", "Bug"] });
  // A private page of the owner: no one else may open it, let alone edit it.
  const triage = await createPage(owner, { workspaceId, teamspaceId: null, title: "Triage rules", markdown: "Refunds are Billing. SKILL-TRIAGE" });
  await setSkill(ids.owner, triage.id, { skill: true, description: "How tickets are sorted" });
  // A skill in the teamspace, which its members may edit.
  const tone = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Tone", markdown: "Be cheerful. SKILL-TONE" });
  await setSkill(ids.owner, tone.id, { skill: true });
  const plain = await createPage(owner, { workspaceId, teamspaceId: null, title: "Just notes", markdown: "Not a skill" });
  const othersSkill = await createPage({ userId: ids.other }, { workspaceId, teamspaceId: null, title: "Oya's rules", markdown: "SKILL-OYA" });
  await setSkill(ids.other, othersSkill.id, { skill: true });

  const router = await agents.createAgent(ids.owner, workspaceId, { name: "Ticket router", instructions: "Sort new tickets. AGENT-OWN" });
  await automations.createAutomation(ids.owner, tickets.id, {
    name: "Triage new tickets",
    trigger: { type: "row_created" },
    actions: [{ type: "run_agent", agent: router.id, prompt: "Triage this ticket." }],
  });

  // ── Giving skills ───────────────────────────────────────────────────────────────────────────
  check((await codeOf(addAgentSkill(ids.member, router.id, triage.id))) === "notAllowed", "members who can only view and interact with an agent can't give it skills");
  check((await codeOf(listAgentSkills(ids.member, router.id))) === "", "…but see the skills it has");
  check((await codeOf(addAgentSkill(ids.owner, router.id, plain.id))) === "notASkill", "a page that isn't a skill can't be given");
  check((await codeOf(addAgentSkill(ids.owner, router.id, tone.id))) === "skillEditable", "a skill members may edit can't be given: it would become the agent's orders");
  check((await codeOf(addAgentSkill(ids.owner, router.id, othersSkill.id))) === "notAPage", "an owner can't give a skill they can't open");
  await addAgentSkill(ids.owner, router.id, triage.id);
  await addAgentSkill(ids.owner, router.id, triage.id);
  const given = await listAgentSkills(ids.owner, router.id);
  check(
    given.hidden === 0 && given.skills.length === 1 && given.skills[0].pageId === triage.id && given.skills[0].status === "usable" && given.skills[0].description === "How tickets are sorted",
    "an owner gives an agent a skill only owners may edit, once, and sees runs follow it",
    given,
  );
  await addAgentSkill(ids.other, router.id, othersSkill.id);
  const seen = await listAgentSkills(ids.owner, router.id);
  check(seen.skills.length === 1 && seen.hidden === 1, "a skill another owner gave that this owner can't open is only counted", seen);

  /** Starts a run with a new row `by` someone and returns it, with the system prompt the model got. */
  async function runOnce(title: string, by: string = ids.owner) {
    await db.delete(agentRun).where(eq(agentRun.agentId, router.id));
    fake.chats.length = 0;
    await createRows(by, tickets.id, [{ title }]);
    await settle();
    const [run] = await db.select().from(agentRun).where(eq(agentRun.agentId, router.id));
    return { run, system: fake.chats.length ? systemOf(fake.chats[0]) : "", skills: run.steps.filter((s): s is AgentSkillRecord => s.kind === "skill") };
  }
  const reasonOf = (skills: AgentSkillRecord[], pageId: string) => {
    const step = skills.find((s) => s.pageId === pageId);
    return step?.outcome === "skipped" ? step.reason : step?.outcome;
  };

  // ── A run held to someone leaves out what they can't open ─────────────────────────────────
  const byMember = await runOnce("A member's ticket", ids.member);
  check(
    byMember.run.status === "done" && !byMember.system.includes("SKILL-") && reasonOf(byMember.skills, triage.id) === "hidden" && reasonOf(byMember.skills, othersSkill.id) === "hidden",
    "a run a member started leaves out the skills they can't open, as it does pages, and says so",
    byMember.skills,
  );
  const ownersView = (await agents.listAgentRuns(ids.owner, router.id))[0].steps.filter((s) => s.kind === "skill");
  check(
    ownersView.some((s) => s.kind === "skill" && s.pageId === othersSkill.id && s.title === "") && ownersView.some((s) => s.kind === "skill" && s.title === "Triage rules"),
    "an owner who can't open a skill sees it in a run without its title",
    ownersView,
  );
  await setPagePermission(ids.owner, triage.id, ids.member, "view");
  const shown = await runOnce("Shared at view", ids.member);
  check(
    shown.system.includes("SKILL-TRIAGE") && reasonOf(shown.skills, triage.id) === "used" && (await listAgentSkills(ids.owner, router.id)).skills[0].status === "usable",
    "shared with the member at view, their runs follow it, and it stays a skill only owners may edit",
    shown.skills,
  );
  await removePagePermission(ids.owner, triage.id, ids.member);
  await removeAgentSkill(ids.owner, router.id, othersSkill.id);
  check((await db.select().from(agentSkill).where(eq(agentSkill.agentId, router.id))).length === 1, "an owner takes away a skill they can't open");

  // ── A run follows them ──────────────────────────────────────────────────────────────────────
  const second = await createPage(owner, { workspaceId, teamspaceId: null, title: "Second rules", markdown: "Then be brief. SKILL-SECOND" });
  await setSkill(ids.owner, second.id, { skill: true });
  await addAgentSkill(ids.owner, router.id, second.id);
  const first = await runOnce("I want a refund");
  check(first.run.status === "done", "the run ends", first.run);
  const system = first.system;
  check(system.includes("SKILL-TRIAGE") && system.includes("SKILL-SECOND") && system.includes('<skill title="Triage rules">'), "the model gets the skills' instructions", system);
  check(system.indexOf("AGENT-OWN") < system.indexOf("SKILL-TRIAGE") && system.indexOf("SKILL-TRIAGE") < system.indexOf("SKILL-SECOND"), "…after the agent's own, in the order they were given");
  check(!fake.chats.some((r) => r.messages.some((m) => m.role !== "system" && textOf(m.content).includes("SKILL-"))), "…as part of its orders, not as the row's data");
  check(
    first.skills.length === 2 && first.skills.every((s) => s.outcome === "used") && first.skills[0].title === "Triage rules",
    "the run says which skills it followed",
    first.run.steps,
  );

  // ── A run that goes on after waiting checks them again ─────────────────────────────────────
  // As a run an owner answered is taken again: its conversation so far and the steps it took.
  await db.delete(agentRun).where(eq(agentRun.agentId, router.id));
  fake.chats.length = 0;
  const gone: AgentSkillRecord = { kind: "skill", pageId: othersSkill.id, title: "Oya's rules", outcome: "used" };
  await db.insert(agentRun).values({
    agentId: router.id,
    workspaceId,
    source: first.run.source,
    context: first.run.context,
    prompt: first.run.prompt,
    steps: [...first.skills, gone],
    state: { messages: [{ role: "user", content: "The task, as the run started." }], queue: [], rounds: 1, writes: 0, externalChars: 0 },
  });
  await setPagePermission(ids.owner, second.id, ids.member, "edit");
  await flushAgentRuns();
  const [resumed] = await db.select().from(agentRun).where(eq(agentRun.agentId, router.id));
  const added = resumed.steps.slice(first.skills.length + 1).filter((s): s is AgentSkillRecord => s.kind === "skill");
  check(
    resumed.status === "done" &&
      added.length === 2 &&
      reasonOf(added, second.id) === "editable" &&
      reasonOf(added, othersSkill.id) === "removed" &&
      fake.chats.length > 0 &&
      systemOf(fake.chats[0]).includes("SKILL-TRIAGE") &&
      !systemOf(fake.chats[0]).includes("SKILL-SECOND"),
    "a run that goes on checks its skills again: one someone may now edit is dropped, one taken away is said, the rest isn't repeated",
    resumed.steps,
  );
  await removePagePermission(ids.owner, second.id, ids.member);
  await removeAgentSkill(ids.owner, router.id, second.id);

  // ── Someone else may edit it by the time of the run ────────────────────────────────────────
  const group = await createGroup(ids.owner, workspaceId, "Support", [ids.member]);
  const ways: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ["a member", () => setPagePermission(ids.owner, triage.id, ids.member, "edit"), () => removePagePermission(ids.owner, triage.id, ids.member)],
    ["a guest", () => setPagePermission(ids.owner, triage.id, ids.guest, "edit"), () => removePagePermission(ids.owner, triage.id, ids.guest)],
    ["the agent itself", () => setPagePermission(ids.owner, triage.id, router.userId, "edit"), () => removePagePermission(ids.owner, triage.id, router.userId)],
    ["a group", () => setPageGroupPermission(ids.owner, triage.id, group.id, "edit"), () => removePageGroupPermission(ids.owner, triage.id, group.id)],
    ["everyone", () => setPagePermission(ids.owner, triage.id, null, "edit"), () => removePagePermission(ids.owner, triage.id, null)],
  ];
  for (const [label, grant, revoke] of ways) {
    await grant();
    const status = (await listAgentSkills(ids.owner, router.id)).skills[0]?.status;
    const { run: r, system: s, skills } = await runOnce(`Ticket for ${label}`);
    check(
      status === "editable" && r.status === "done" && !s.includes("SKILL-TRIAGE") && skills.length === 1 && reasonOf(skills, triage.id) === "editable",
      `once ${label} may edit a skill, owners see it left out and a run leaves it out and says why`,
      { status, steps: r.steps, run: r.status },
    );
    await revoke();
  }
  const folder = await createPage(owner, { workspaceId, teamspaceId: null, title: "Rules folder" });
  const nested = await createPage(owner, { workspaceId, parentId: folder.id, title: "Nested rules", markdown: "Nested" });
  await setSkill(ids.owner, nested.id, { skill: true });
  await setPagePermission(ids.owner, folder.id, ids.member, "edit");
  check((await codeOf(addAgentSkill(ids.owner, router.id, nested.id))) === "skillEditable", "…also when the page above it is shared to edit");
  await removePagePermission(ids.owner, folder.id, ids.member);
  await setPagePermission(ids.owner, triage.id, ids.member, "comment");
  check((await runOnce("Commenting is fine")).system.includes("SKILL-TRIAGE"), "someone who may only comment on it doesn't stop it");
  await removePagePermission(ids.owner, triage.id, ids.member);

  // ── It's no longer a skill ──────────────────────────────────────────────────────────────────
  await setSkill(ids.owner, triage.id, { skill: false });
  const unmarked = await runOnce("After unmarking");
  check(
    (await listAgentSkills(ids.owner, router.id)).skills[0]?.status === "notASkill" && !unmarked.system.includes("SKILL-TRIAGE") && unmarked.skills[0]?.outcome === "skipped" && unmarked.skills[0].reason === "notASkill",
    "a page no longer marked as a skill is kept but left out, and the run says so",
    unmarked.run.steps,
  );
  check(!unmarked.system.includes("<skill"), "…and a run with no skills to follow doesn't mention any", unmarked.system);
  await setSkill(ids.owner, triage.id, { skill: true });
  check((await runOnce("Marked again")).system.includes("SKILL-TRIAGE"), "marked again, runs follow it again");

  // ── Limits ──────────────────────────────────────────────────────────────────────────────────
  const skillPage = async (title: string, markdown: string) => {
    const made = await createPage(owner, { workspaceId, teamspaceId: null, title, markdown });
    await setSkill(ids.owner, made.id, { skill: true });
    return made;
  };
  for (let i = 1; i < MAX_AGENT_SKILLS - 1; i++) await addAgentSkill(ids.owner, router.id, (await skillPage(`Extra ${i}`, `Extra ${i}`)).id);
  const [lastA, lastB] = [await skillPage("Last A", "a"), await skillPage("Last B", "b")];
  const raced = await Promise.all([codeOf(addAgentSkill(ids.owner, router.id, lastA.id)), codeOf(addAgentSkill(ids.owner, router.id, lastB.id))]);
  const count = (await db.select().from(agentSkill).where(eq(agentSkill.agentId, router.id))).length;
  check(
    count === MAX_AGENT_SKILLS && raced.filter((c) => c === "").length === 1 && raced.includes("tooManySkills"),
    `an agent has at most ${MAX_AGENT_SKILLS} skills, even when the last one is added twice at once`,
    { raced, count },
  );
  const long = await skillPage("Long", "word ".repeat(4_000));
  await removeAgentSkill(ids.owner, router.id, triage.id);
  await addAgentSkill(ids.owner, router.id, long.id);
  const longStatus = (await listAgentSkills(ids.owner, router.id)).skills.find((s) => s.pageId === long.id)?.status;
  check(longStatus === "tooLong", "owners see that a skill too long to fit is left out", longStatus);
  const tooLong = await runOnce("A long skill");
  check(
    tooLong.run.status === "done" && reasonOf(tooLong.skills, long.id) === "tooLong" && !tooLong.system.includes("word word"),
    "a skill that doesn't fit in what a run may read is left out whole, never cut",
    tooLong.skills,
  );
  // A smaller model allowance gives skills less room: the tab tells as the run counts.
  await removeAgentSkill(ids.owner, router.id, long.id);
  const medium = await skillPage("Medium", "word ".repeat(1_600));
  await addAgentSkill(ids.owner, router.id, medium.id);
  check((await listAgentSkills(ids.owner, router.id)).skills.find((s) => s.pageId === medium.id)?.status === "usable", "an 8,000-character skill fits the usual room");
  setAiEnv({ ...aiEnv, AI_MAX_INPUT_CHARS: "24000" });
  const smallStatus = (await listAgentSkills(ids.owner, router.id)).skills.find((s) => s.pageId === medium.id)?.status;
  const small = await runOnce("Less room");
  check(
    smallStatus === "tooLong" && reasonOf(small.skills, medium.id) === "tooLong",
    "with a quarter of a smaller allowance, owners and runs both see it left out",
    { smallStatus, steps: small.skills },
  );
  setAiEnv(aiEnv);

  await agents.archiveAgent(ids.owner, router.id);
  check((await codeOf(addAgentSkill(ids.owner, router.id, triage.id))) === "archived", "an archived agent gets no skills");

  const audit = await db.select({ action: auditEvent.action, details: auditEvent.details }).from(auditEvent).where(eq(auditEvent.workspaceId, workspaceId));
  check(
    audit.some((a) => a.action === "agent.updated" && JSON.stringify(a.details).includes("skillAdded")) &&
      audit.some((a) => a.action === "agent.updated" && JSON.stringify(a.details).includes("skillRemoved")),
    "the audit log records giving and taking skills",
    audit.map((a) => a.action),
  );

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...userIds, ...botUsers]));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
