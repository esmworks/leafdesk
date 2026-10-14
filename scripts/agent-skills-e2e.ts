/**
 * End-to-end check of agents' skills against the database, with a fake OpenAI-compatible server
 * (src/server/ai/fake-openai.ts): owners give an agent skills of its workspace, only ones no one
 * but the workspace's owners may edit (a member, a teamspace, a guest or the agent itself editing
 * one stops it); a run sends the skills' instructions after the agent's own and says which it
 * followed; a skill someone else may edit by the time of the run, or that is no longer a skill, is
 * left out and the run says so; members and owners who can't open a skill don't see it named.
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
const { removePagePermission, setPagePermission } = await import("@/server/permissions");
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
setAiEnv({
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
});

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
  check((await codeOf(addAgentSkill(ids.member, router.id, triage.id))) === "notFound", "members can't give an agent skills");
  check((await codeOf(listAgentSkills(ids.member, router.id))) === "notFound", "…nor see the skills it has");
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

  // ── A run follows them ──────────────────────────────────────────────────────────────────────
  fake.chats.length = 0;
  await createRows(ids.member, tickets.id, [{ title: "I want a refund" }]);
  await settle();
  let [run] = await db.select().from(agentRun).where(eq(agentRun.agentId, router.id));
  check(run?.status === "done", "the run ends", run);
  const system = systemOf(fake.chats[0]);
  check(system.includes("SKILL-TRIAGE") && system.includes("SKILL-OYA") && system.includes('<skill title="Triage rules">'), "the model gets the skills' instructions", system);
  check(system.indexOf("AGENT-OWN") < system.indexOf("SKILL-TRIAGE") && system.indexOf("SKILL-TRIAGE") < system.indexOf("SKILL-OYA"), "…after the agent's own, in the order they were given");
  check(!fake.chats.some((r) => r.messages.some((m) => m.role !== "system" && textOf(m.content).includes("SKILL-"))), "…as part of its orders, not as the row's data");
  const usedSteps = run.steps.filter((s): s is AgentSkillRecord => s.kind === "skill");
  check(usedSteps.length === 2 && usedSteps.every((s) => s.outcome === "used") && usedSteps[0].title === "Triage rules", "the run says which skills it followed", run.steps);
  const ownersView = (await agents.listAgentRuns(ids.owner, router.id))[0].steps.filter((s) => s.kind === "skill");
  check(
    ownersView.some((s) => s.kind === "skill" && s.pageId === othersSkill.id && s.title === "") && ownersView.some((s) => s.kind === "skill" && s.title === "Triage rules"),
    "an owner who can't open a skill sees it in a run without its title",
    ownersView,
  );
  await removeAgentSkill(ids.owner, router.id, othersSkill.id);
  check((await db.select().from(agentSkill).where(eq(agentSkill.agentId, router.id))).length === 1, "an owner takes away a skill they can't open");

  /** Starts a run with a new row and returns it, with the system prompt the model got. */
  async function runOnce(title: string) {
    await db.delete(agentRun).where(eq(agentRun.agentId, router.id));
    fake.chats.length = 0;
    await createRows(ids.member, tickets.id, [{ title }]);
    await settle();
    [run] = await db.select().from(agentRun).where(eq(agentRun.agentId, router.id));
    return { run, system: fake.chats.length ? systemOf(fake.chats[0]) : "", skills: run.steps.filter((s): s is AgentSkillRecord => s.kind === "skill") };
  }

  // ── Someone else may edit it by the time of the run ────────────────────────────────────────
  for (const [who, label] of [
    [ids.member, "a member"],
    [ids.guest, "a guest"],
    [router.userId, "the agent itself"],
  ] as const) {
    await setPagePermission(ids.owner, triage.id, who, "edit");
    const status = (await listAgentSkills(ids.owner, router.id)).skills[0]?.status;
    const { run: r, system: s, skills } = await runOnce(`Ticket for ${label}`);
    check(
      status === "editable" && r.status === "done" && !s.includes("SKILL-TRIAGE") && skills.length === 1 && skills[0].outcome === "skipped" && skills[0].reason === "editable",
      `once ${label} may edit a skill, owners see it left out and a run leaves it out and says why`,
      { status, steps: r.steps, run: r.status },
    );
    await removePagePermission(ids.owner, triage.id, who);
  }
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
  for (let i = 1; i < MAX_AGENT_SKILLS; i++) {
    const extra = await createPage(owner, { workspaceId, teamspaceId: null, title: `Extra ${i}`, markdown: `Extra ${i}` });
    await setSkill(ids.owner, extra.id, { skill: true });
    await addAgentSkill(ids.owner, router.id, extra.id);
  }
  const oneMore = await createPage(owner, { workspaceId, teamspaceId: null, title: "One more", markdown: "x" });
  await setSkill(ids.owner, oneMore.id, { skill: true });
  check((await codeOf(addAgentSkill(ids.owner, router.id, oneMore.id))) === "tooManySkills", `an agent has at most ${MAX_AGENT_SKILLS} skills`);
  const long = await createPage(owner, { workspaceId, teamspaceId: null, title: "Long", markdown: "word ".repeat(4_000) });
  await setSkill(ids.owner, long.id, { skill: true });
  await removeAgentSkill(ids.owner, router.id, triage.id);
  await addAgentSkill(ids.owner, router.id, long.id);
  const tooLong = await runOnce("A long skill");
  check(
    tooLong.run.status === "done" && tooLong.skills.find((s) => s.pageId === long.id)?.outcome === "skipped" && !tooLong.system.includes("word word"),
    "a skill that doesn't fit in what a run may read is left out whole, never cut",
    tooLong.skills,
  );

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
