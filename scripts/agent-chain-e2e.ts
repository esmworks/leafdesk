/**
 * End-to-end check of chains of agents (server/agents/chains.ts) against the database and a fake
 * OpenAI-compatible server: an owner sets up a chain of two agents (invalid names, steps, agents
 * and databases are refused; a member who can't edit its agents neither sees nor runs it); Run now
 * queues its first step's run, held to whoever ran it; when that run ends, the next agent's run is
 * queued with the answer before it in its prompt, framed as outside data; only the last step's run
 * is reported to that person, and the chain's run ends done. A chain still running can't be run
 * again; a step ending with finish_run nothing_new ends the chain there (stopped, nothingNew); a
 * step that read someone's mail ends it too (privateRead); an archived next agent fails it
 * (agentGone). On a schedule, a due chain starts the same way. listTriggers lists the chain for
 * each of its agents. Deleting it leaves its agents.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-chain-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the schedules and runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, desc } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentChainRun, agentRun, notification, schedule, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
const agents = await import("@/server/agents/manage");
const chains = await import("@/server/agents/chains");
const { flushAgentRuns } = await import("@/server/agents/run");
const { runDueSchedules } = await import("@/server/schedules");
const { listTriggers } = await import("@/server/triggers");

const RUN = `agent-chain-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
setAiEnv({ AI_PROVIDER: "openai-compatible", AI_MODEL: "fake-chat", AI_BASE_URL: fake.baseUrl, AI_WORKSPACE_RATE_LIMIT: "1000", AI_RATE_LIMIT: "1000" });

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

async function failsWith(promise: Promise<unknown>, code: string, reason?: string) {
  return promise.then(
    () => false,
    (error: unknown) => {
      const e = error as { code?: unknown; params?: Record<string, string> };
      return e.code === code && (reason === undefined || e.params?.reason === reason);
    },
  );
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const ZONE = "Europe/Istanbul";
const daily = { frequency: "daily", interval: 1, weekdays: [], time: "08:00" };

const runsOf = (agentId: string) => db.select().from(agentRun).where(eq(agentRun.agentId, agentId)).orderBy(desc(agentRun.createdAt));
const chainRuns = (chainId: string) => db.select().from(agentChainRun).where(eq(agentChainRun.scheduleId, chainId)).orderBy(desc(agentChainRun.createdAt));
const reports = async () =>
  (await db.select().from(notification).where(and(eq(notification.workspaceId, workspaceId), eq(notification.userId, ids.owner), eq(notification.kind, "agent_report")))).map((n) => n.agentRunId);
/** The text of every message a request to the model carried. */
const said = (request: FakeChatRequest) => request.messages.map((m) => textOf(m.content)).join("\n");

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const owner = { userId: ids.owner };
  const board = await createPage(owner, { workspaceId, teamspaceId: general.id, kind: "database", title: "Customers" });
  const notes = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Notes" });

  const researcher = await agents.createAgent(ids.owner, workspaceId, { name: "Researcher", instructions: "Find out what changed." });
  const writer = await agents.createAgent(ids.owner, workspaceId, { name: "Writer", instructions: "Write short reports." });
  await agents.setAgentAccess(ids.owner, writer.id, board.id, "edit");

  // ── Setting a chain up ────────────────────────────────────────────────────────────────────────
  const steps = [
    { agentId: researcher.id, task: "List what changed this week.", databaseId: null },
    { agentId: writer.id, task: "Turn the list into a short report.", databaseId: board.id },
  ];
  const input = { name: "Weekly report", steps, repeats: false, rule: daily, timeZone: ZONE };
  check(await failsWith(chains.setAgentChain(ids.owner, workspaceId, null, { ...input, name: " " }), "invalid", "chainName"), "a chain needs a name");
  check(await failsWith(chains.setAgentChain(ids.owner, workspaceId, null, { ...input, steps: steps.slice(0, 1) }), "invalid", "chainSteps"), "a chain needs two steps");
  check(
    await failsWith(chains.setAgentChain(ids.owner, workspaceId, null, { ...input, steps: [steps[0], { ...steps[1], task: "" }] }), "invalid", "task"),
    "each step needs a task",
  );
  check(
    await failsWith(chains.setAgentChain(ids.owner, workspaceId, null, { ...input, steps: [steps[0], { ...steps[1], agentId: `${RUN}-nobody` }] }), "invalid", "chainAgent"),
    "an agent of no one's is refused",
  );
  check(await failsWith(chains.setAgentChain(ids.owner, workspaceId, null, { ...input, steps: [steps[0], { ...steps[1], databaseId: notes.id }] }), "notADatabase"), "a page that isn't a database is refused");
  check(await failsWith(chains.setAgentChain(ids.member, workspaceId, null, input), "invalid", "chainAgent"), "a member who can't edit the agents can't chain them");

  const chainId = await chains.setAgentChain(ids.owner, workspaceId, null, input);
  let listed = await chains.listAgentChains(ids.owner, workspaceId);
  check(
    listed.length === 1 &&
      listed[0].id === chainId &&
      listed[0].name === "Weekly report" &&
      listed[0].steps.map((s) => s.agentName).join() === "Researcher,Writer" &&
      listed[0].steps[1].databaseTitle === "Customers" &&
      !listed[0].repeats &&
      listed[0].nextRunAt === null &&
      listed[0].run === null,
    "an owner sets up a chain of two agents that runs only when asked",
    listed,
  );
  check((await chains.listAgentChains(ids.member, workspaceId)).length === 0, "a member who can't edit its agents doesn't see it");
  check(await failsWith(chains.runAgentChain(ids.member, workspaceId, chainId), "chainNotFound"), "…nor run it");

  const writerTriggers = await listTriggers(ids.owner, workspaceId, writer.id);
  const chainTrigger = writerTriggers.find((t) => t.kind === "chain");
  check(chainTrigger?.kind === "chain" && chainTrigger.id === chainId && chainTrigger.steps.join() === "2" && chainTrigger.total === 2, "the writer's triggers list the chain, as its step 2", writerTriggers);

  // ── Run now: one step after another ───────────────────────────────────────────────────────────
  const FINDINGS = "Three customers renewed; Acme asked for a discount.";
  const REPORT = "Weekly report: renewals are up, and one discount request waits.";
  fake.chats.length = 0;
  fake.setChat((request) => ({ text: said(request).includes("Turn the list into a short report.") ? REPORT : FINDINGS }));
  await chains.runAgentChain(ids.owner, workspaceId, chainId);
  let [chainRun] = await chainRuns(chainId);
  const [first] = await runsOf(researcher.id);
  check(
    chainRun?.status === "running" &&
      chainRun.step === 0 &&
      chainRun.trigger === "click" &&
      chainRun.startedBy === ids.owner &&
      chainRun.runId === first?.id &&
      first.status === "pending" &&
      first.source.kind === "schedule" &&
      first.source.scheduledBy === ids.owner &&
      first.source.chain?.runId === chainRun.id &&
      first.source.chain.step === 0 &&
      first.prompt === steps[0].task,
    "Run now queues the first agent's run, held to whoever ran the chain",
    { chainRun, first },
  );
  check(await failsWith(chains.runAgentChain(ids.owner, workspaceId, chainId), "chainRunning"), "a chain still running can't be run again");

  await flushAgentRuns();
  [chainRun] = await chainRuns(chainId);
  const [firstDone] = await runsOf(researcher.id);
  const [second] = await runsOf(writer.id);
  check(firstDone.status === "done" && firstDone.answer?.includes(FINDINGS), "the first agent answers", firstDone);
  check(
    second?.status === "done" &&
      second.source.kind === "schedule" &&
      second.source.chain?.step === 1 &&
      second.source.chain.after === firstDone.id &&
      second.source.databaseId === board.id &&
      second.prompt === steps[1].task &&
      second.answer?.includes(REPORT),
    "its answer starts the second agent's run, on the second step's database",
    second,
  );
  const writerRequest = fake.chats.find((c) => said(c).includes("Turn the list into a short report."));
  check(writerRequest && said(writerRequest).includes(FINDINGS), "the second agent is handed the first one's answer", writerRequest?.messages);
  check(
    (second.steps ?? []).some((s) => s.kind === "handoff" && s.received === true && s.agentId === researcher.id),
    "its steps say whose answer it was handed",
    second.steps,
  );
  check(chainRun.status === "done" && chainRun.step === 1 && chainRun.runId === second.id && chainRun.finishedAt, "the chain's run ends done at its last step", chainRun);
  let reported = await reports();
  check(reported.length === 1 && reported[0] === second.id, "only the last step's run is reported, to whoever ran it", reported);
  const firstSecond = second.id;
  listed = await chains.listAgentChains(ids.owner, workspaceId);
  check(listed[0].run?.status === "done" && listed[0].run.step === 1, "the list shows how its latest run went", listed[0].run);

  // ── A step that finds nothing new ends the chain ──────────────────────────────────────────────
  fake.setChat((request) =>
    said(request).includes("Turn the list into a short report.")
      ? { text: "should not run" }
      : request.messages.some((m) => m.role === "tool")
        ? { text: "Nothing changed." }
        : { toolCalls: [{ name: "finish_run", arguments: { outcome: "nothing_new", reason: "Nothing changed this week." } }] },
  );
  await chains.runAgentChain(ids.owner, workspaceId, chainId);
  await flushAgentRuns();
  [chainRun] = await chainRuns(chainId);
  check(chainRun.status === "stopped" && chainRun.code === "nothingNew" && chainRun.step === 0, "a step ending with nothing new ends the chain there", chainRun);
  check((await runsOf(writer.id)).length === 1, "…and the next agent doesn't run");
  reported = await reports();
  check(reported.length === 1, "a quiet end reports nothing", reported);

  // ── A step that read someone's mail ends it too ───────────────────────────────────────────────
  fake.setChat(() => ({ text: FINDINGS }));
  await chains.runAgentChain(ids.owner, workspaceId, chainId);
  [chainRun] = await chainRuns(chainId);
  const [pendingFirst] = await runsOf(researcher.id);
  const handed = await chains.chainStepEnded({ ...pendingFirst, steps: [{ kind: "mail", action: "earlier" }] }, { status: "done" });
  [chainRun] = await chainRuns(chainId);
  check(!handed && chainRun.status === "stopped" && chainRun.code === "privateRead", "a step that read mail doesn't hand its answer on", chainRun);
  await flushAgentRuns();
  check((await runsOf(writer.id)).length === 1, "…so the next agent doesn't run");
  check((await reports()).includes(pendingFirst.id), "the run that ended the chain is reported");

  // ── An archived next agent fails it ───────────────────────────────────────────────────────────
  await chains.runAgentChain(ids.owner, workspaceId, chainId);
  await db.update(workspaceAgent).set({ archivedAt: new Date() }).where(eq(workspaceAgent.id, writer.id));
  await flushAgentRuns();
  [chainRun] = await chainRuns(chainId);
  check(chainRun.status === "failed" && chainRun.code === "agentGone" && chainRun.step === 0, "a removed next agent fails the chain", chainRun);
  await db.update(workspaceAgent).set({ archivedAt: null }).where(eq(workspaceAgent.id, writer.id));

  // ── On a schedule ─────────────────────────────────────────────────────────────────────────────
  await chains.setAgentChain(ids.owner, workspaceId, chainId, { ...input, repeats: true });
  listed = await chains.listAgentChains(ids.owner, workspaceId);
  check(listed[0].repeats && listed[0].enabled && listed[0].nextRunAt && new Date(listed[0].nextRunAt) > new Date(), "the chain can also run on a schedule", listed[0]);
  fake.setChat((request) => ({ text: said(request).includes("Turn the list into a short report.") ? REPORT : FINDINGS }));
  await db.update(schedule).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schedule.id, chainId));
  check((await runDueSchedules(new Date())) === 1, "the scheduler takes the due chain");
  [chainRun] = await chainRuns(chainId);
  check(chainRun.trigger === "schedule" && chainRun.startedBy === ids.owner, "…as a run of whoever set it", chainRun);
  await flushAgentRuns();
  [chainRun] = await chainRuns(chainId);
  const writerRuns = await runsOf(writer.id);
  check(chainRun.status === "done" && writerRuns.length === 2 && writerRuns[0].id !== firstSecond, "…and runs to its end", chainRun);

  // ── Deleting it ───────────────────────────────────────────────────────────────────────────────
  await chains.removeAgentChain(ids.owner, workspaceId, chainId);
  check((await chains.listAgentChains(ids.owner, workspaceId)).length === 0, "the owner deletes the chain");
  const left = await db.select({ id: workspaceAgent.id }).from(workspaceAgent).where(inArray(workspaceAgent.id, [researcher.id, writer.id]));
  check(left.length === 2, "…and its agents stay");

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(notification).where(eq(notification.workspaceId, workspaceId));
  await db.delete(agentChainRun).where(eq(agentChainRun.workspaceId, workspaceId));
  await db.delete(agentRun).where(eq(agentRun.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...userIds, ...botUsers]));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
