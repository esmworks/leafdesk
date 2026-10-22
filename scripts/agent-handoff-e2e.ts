/**
 * End-to-end check of agents handing part of a job to other agents, against the database, with a
 * fake OpenAI-compatible server scripted per agent: owners choose an agent's "Agents it can ask"
 * (only other agents of the workspace that aren't archived; archiving one takes it off every list);
 * a run asks one with ask_agent and hears its answer framed as data from another agent; the
 * helper's run is a run of its own, linked both ways and counted against the helper; a helper's run
 * can't ask further, a run asks at most MAX_HANDOFFS_PER_RUN times, a paused or archived helper or
 * one over its monthly limit is explained instead of run; a helper of a run a member started is held
 * to that member's access, and one of a run no one stands behind is untrusted; who sees the helper's
 * run is who sees the asking run. Everything runs with AI_CONCURRENCY=1, where a helper queued
 * behind the run waiting for it would never start.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-handoff-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, agentUsage, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { createRows } = await import("@/server/databases");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const agents = await import("@/server/agents/manage");
const { helperIdsOf } = await import("@/server/agents/helpers");
const { requestAgentRun } = await import("@/server/agents/requests");
const { flushAgentRuns, queueAgentRun } = await import("@/server/agents/run");
const automations = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");
const { describeAgentRun } = await import("@/server/mcp/agents");
const { MAX_HANDOFFS_PER_RUN } = await import("@/lib/agents");
type AgentHandoffRecord = import("@/lib/agents").AgentHandoffRecord;

const RUN = `agent-handoff-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
// One slot: a helper queued behind the run that waits for it would never start.
setAiEnv({
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
  AI_CONCURRENCY: "1",
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

async function fails(promise: Promise<unknown>, what: (error: unknown) => boolean) {
  try {
    await promise;
    return false;
  } catch (error) {
    return what(error);
  }
}
const invalidHelpers = (e: unknown) => e instanceof agents.AgentError && e.code === "invalid" && e.params.reason === "helpers";

const system = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
const isAgent = (request: FakeChatRequest, name: string) => system(request).includes(`You are "${name}"`);
const toolResults = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
const toolNames = (request: FakeChatRequest) => (request.tools ?? []).map((t) => t.function.name);
const callsMade = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;

/** A model that makes these tool calls, one per turn, then says what `done` says. */
function script(calls: ((request: FakeChatRequest) => { name: string; arguments: Record<string, unknown> })[], done: (request: FakeChatRequest) => string) {
  return (request: FakeChatRequest): FakeReply => {
    const made = callsMade(request);
    if (made < calls.length) return { toolCalls: [calls[made](request)] };
    return { text: done(request) };
  };
}

/** Each agent's model, by its name in the system prompt. */
function models(byName: Record<string, (request: FakeChatRequest) => FakeReply>) {
  fake.setChat((request) => {
    const name = Object.keys(byName).find((n) => isAgent(request, n));
    if (!name) throw new Error("an agent no script is for");
    return byName[name](request);
  });
}

const ask = (agent: string, task: string) => () => ({ name: "ask_agent", arguments: { agent, task, send_back: "the price, as a number" } });

const ids = { owner: `${RUN}-owner`, owner2: `${RUN}-owner2`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.owner2, name: "Owner Oğuz", email: `${ids.owner2}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.owner2, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const owner = { userId: ids.owner };
  // The owner's own page: the member can't open it.
  const prices = await createPage(owner, { workspaceId, teamspaceId: null, title: "Price list", markdown: "Widget costs PRICE-42." });
  const tickets = await createPage(owner, { workspaceId, teamspaceId: general.id, kind: "database", title: "Tickets" });

  // ── Choosing the agents it can ask ──────────────────────────────────────────────────────────
  const researcher = await agents.createAgent(ids.owner, workspaceId, { name: "Researcher", description: "Looks prices up" });
  await agents.setAgentAccess(ids.owner, researcher.id, prices.id, "view");
  const writer = await agents.createAgent(ids.owner, workspaceId, { name: "Writer" });
  const coordinator = await agents.createAgent(ids.owner, workspaceId, { name: "Coordinator", helperAgentIds: [researcher.id] });
  check(((await helperIdsOf([coordinator.id])).get(coordinator.id) ?? []).join() === researcher.id, "an agent is created with the agents it can ask");
  check(await fails(agents.updateAgent(ids.owner, coordinator.id, { helperAgentIds: [coordinator.id] }), invalidHelpers), "it can't ask itself");
  check(await fails(agents.updateAgent(ids.owner, coordinator.id, { helperAgentIds: ["no-such-agent"] }), invalidHelpers), "…nor an agent of another workspace, or none");
  check(await fails(agents.updateAgent(ids.member, coordinator.id, { helperAgentIds: [] }), (e) => e instanceof agents.AgentError && e.code === "notAllowed"), "only those who can edit it choose them");
  await agents.updateAgent(ids.owner, coordinator.id, { helperAgentIds: [researcher.id, writer.id] });
  // The researcher may ask the coordinator back: its own runs for others still can't ask.
  await agents.updateAgent(ids.owner, researcher.id, { helperAgentIds: [coordinator.id] });
  check(((await helperIdsOf([coordinator.id])).get(coordinator.id) ?? []).join() === [researcher.id, writer.id].join(), "owners change the list, in the order chosen");
  const archivedOne = await agents.createAgent(ids.owner, workspaceId, { name: "Old helper" });
  await agents.archiveAgent(ids.owner, archivedOne.id);
  check(await fails(agents.updateAgent(ids.owner, coordinator.id, { helperAgentIds: [archivedOne.id] }), invalidHelpers), "…never with an archived agent");

  // ── A run asks, the helper answers ──────────────────────────────────────────────────────────
  models({
    Coordinator: script([ask("Researcher", "What does a widget cost? Look in the price list.")], (r) => `Coordinator heard: ${toolResults(r).join(" | ")}`),
    Researcher: script([() => ({ name: "read_page", arguments: { page_id: prices.id } })], (r) => (toolResults(r).some((t) => t.includes("PRICE-42")) ? "It costs PRICE-42." : "I couldn't read the price list.")),
  });
  const asked = await requestAgentRun(ids.owner, coordinator.id, { task: "Quote a widget.", rowId: null, via: "api" });
  await flushAgentRuns();
  const [askingRun] = await db.select().from(agentRun).where(eq(agentRun.id, asked.id));
  const [helperRun] = await db.select().from(agentRun).where(eq(agentRun.agentId, researcher.id));
  check(askingRun.status === "done" && helperRun?.status === "done", "the asking run and the helper's run both finish with one slot of the worker: no deadlock", { askingRun, helperRun });
  check(
    helperRun.source.kind === "handoff" && helperRun.source.parentRunId === askingRun.id && helperRun.source.fromAgentId === coordinator.id && helperRun.source.boundTo === ids.owner,
    "the helper's run names the run and agent that asked, and is held to the asking owner's access",
    helperRun.source,
  );
  check(helperRun.prompt.includes("What does a widget cost?") && helperRun.prompt.includes("Send back: the price"), "…with the task and what to send back", helperRun.prompt);
  check(askingRun.answer.includes("PRICE-42") && askingRun.answer.includes("data from another agent") && askingRun.answer.includes("<<<EXTERNAL DATA"), "the helper's answer reaches the asking run, framed as data from another agent", askingRun.answer);
  const helperChats = fake.chats.filter((c) => isAgent(c, "Researcher"));
  const askerChats = fake.chats.filter((c) => isAgent(c, "Coordinator"));
  check(askerChats.every((c) => toolNames(c).includes("ask_agent")), "a run of an agent with helpers gets ask_agent");
  check(
    helperChats.length > 0 && helperChats.every((c) => !toolNames(c).includes("ask_agent")) && system(helperChats[0]).includes("another agent of the workspace asked you"),
    "a helper's run can't ask further agents (though it has helpers), and knows another agent asked",
  );
  check(helperChats.every((c) => !toolNames(c).includes("remember")), "…and proposes no notes");
  const step = askingRun.steps.find((s): s is AgentHandoffRecord => s.kind === "handoff");
  check(step?.agentId === researcher.id && step.runId === helperRun.id && step.outcome === "done" && step.task.includes("widget"), "the asking run shows the step, linking to the helper's run", step);
  const [helperView] = await agents.listAgentRuns(ids.owner, researcher.id);
  check(helperView.handoff?.fromAgentId === coordinator.id && helperView.handoff.fromName === "Coordinator" && helperView.handoff.parentRunId === askingRun.id && helperView.steps.length > 0, "the helper's run shows who asked it, linking back", helperView.handoff);
  const described = describeAgentRun(workspaceId, helperView) as { source: { kind: string; asked_by?: { agent_id: string; run_id: string } } };
  check(described.source.kind === "handoff" && described.source.asked_by?.run_id === askingRun.id, "MCP and REST show the new source", described.source);
  const [hiddenView] = await agents.listAgentRuns(ids.owner2, researcher.id);
  check(hiddenView.steps.length === 0 && hiddenView.answer === "" && hiddenView.handoff?.task === "", "another owner doesn't see what a helper of a run an owner asked for did, as with that run", hiddenView);
  const usage = await db.select().from(agentUsage).where(inArray(agentUsage.agentId, [coordinator.id, researcher.id]));
  check(
    usage.length === 2 && usage.every((u) => u.runs === 1 && u.inputTokens + u.outputTokens > 0),
    "each agent's tokens count against itself",
    usage,
  );

  // ── At most MAX_HANDOFFS_PER_RUN asks a run ─────────────────────────────────────────────────
  fake.chats.length = 0;
  models({
    Coordinator: script(
      Array.from({ length: MAX_HANDOFFS_PER_RUN + 1 }, (_, i) => ask(i % 2 ? "Writer" : "researcher", `Part ${i + 1}`)),
      (r) => `Heard: ${toolResults(r).join(" | ")}`,
    ),
    Researcher: () => ({ text: "Researched." }),
    Writer: () => ({ text: "Written." }),
  });
  const many = await requestAgentRun(ids.owner, coordinator.id, { task: "Ask a lot.", rowId: null, via: "mcp" });
  await flushAgentRuns();
  const [manyRun] = await db.select().from(agentRun).where(eq(agentRun.id, many.id));
  const manyHelpers = await db.select().from(agentRun).where(and(inArray(agentRun.agentId, [researcher.id, writer.id])));
  const children = manyHelpers.filter((r) => r.source.kind === "handoff" && r.source.parentRunId === many.id);
  check(manyRun.status === "done" && children.length === MAX_HANDOFFS_PER_RUN && children.every((c) => c.status === "done"), `a run asks at most ${MAX_HANDOFFS_PER_RUN} times`, { manyRun, children });
  check(manyRun.answer.includes("the most one run may"), "…and hears so when it asks once more", manyRun.answer);
  check(manyRun.steps.filter((s) => s.kind === "handoff").length === MAX_HANDOFFS_PER_RUN, "…each ask a step of its run");

  // ── A helper that can't help is explained, not run ──────────────────────────────────────────
  const tell = (name: string) => ({
    Coordinator: script([ask(name, "Help.")], (r) => `Heard: ${toolResults(r).join(" | ")}`),
    Researcher: () => ({ text: "Researched." }),
    Writer: () => ({ text: "Written." }),
  });
  const runsOf = async (agentId: string) => (await db.select({ id: agentRun.id }).from(agentRun).where(eq(agentRun.agentId, agentId))).length;
  await agents.updateAgent(ids.owner, writer.id, { enabled: false });
  const writerRunsBefore = await runsOf(writer.id);
  models(tell("Writer"));
  const toPaused = await requestAgentRun(ids.owner, coordinator.id, { task: "Ask the writer.", rowId: null, via: "api" });
  await flushAgentRuns();
  const [pausedRun] = await db.select().from(agentRun).where(eq(agentRun.id, toPaused.id));
  check(
    pausedRun.status === "done" && pausedRun.answer.includes("is paused") && (await runsOf(writer.id)) === writerRunsBefore,
    "a paused helper is explained to the asking run instead of running",
    pausedRun.answer,
  );
  check(pausedRun.steps.some((s) => s.kind === "handoff" && s.outcome === "paused" && s.runId === null), "…and the step says so");
  await agents.updateAgent(ids.owner, writer.id, { enabled: true, monthlyTokenLimit: 1 });
  await db.insert(agentUsage).values({ agentId: writer.id, month: new Date().toISOString().slice(0, 7) + "-01", runs: 1, inputTokens: 5, outputTokens: 5, costUsd: 0 }).onConflictDoNothing();
  const overLimit = await requestAgentRun(ids.owner, coordinator.id, { task: "Ask the writer again.", rowId: null, via: "api" });
  await flushAgentRuns();
  const [limitRun] = await db.select().from(agentRun).where(eq(agentRun.id, overLimit.id));
  check(
    limitRun.answer.includes("monthly token limit") && limitRun.steps.some((s) => s.kind === "handoff" && s.outcome === "limitReached") && (await runsOf(writer.id)) === writerRunsBefore,
    "…so is one over its monthly token limit",
    limitRun.answer,
  );
  await agents.archiveAgent(ids.owner, writer.id);
  check(((await helperIdsOf([coordinator.id])).get(coordinator.id) ?? []).join() === researcher.id, "archiving an agent takes it off the lists of the agents that could ask it");

  // ── A member's run: the helper is held to the member's access too ───────────────────────────
  fake.chats.length = 0;
  models({
    Coordinator: script([ask("Researcher", "What does a widget cost? Look in the price list.")], (r) => `Heard: ${toolResults(r).join(" | ")}`),
    Researcher: script([() => ({ name: "read_page", arguments: { page_id: prices.id } })], (r) => (toolResults(r).some((t) => t.includes("PRICE-42")) ? "It costs PRICE-42." : "I couldn't read the price list.")),
  });
  await automations.createAutomation(ids.owner, tickets.id, { name: "Quote", trigger: { type: "row_created" }, actions: [{ type: "run_agent", agent: coordinator.id, prompt: "Quote this." }] });
  await createRows(ids.member, tickets.id, [{ title: "How much is a widget?" }]);
  await flushAutomations();
  await flushAgentRuns();
  const [memberRun] = await db.select().from(agentRun).where(and(eq(agentRun.agentId, coordinator.id), eq(agentRun.prompt, "Quote this.")));
  const [memberHelper] = (await db.select().from(agentRun).where(eq(agentRun.agentId, researcher.id))).filter((r) => r.source.kind === "handoff" && r.source.parentRunId === memberRun?.id);
  check(memberRun?.status === "done" && memberHelper?.status === "done", "a run a member's change started asks too", { memberRun, memberHelper });
  check(
    memberHelper.source.kind === "handoff" && memberHelper.source.boundTo === ids.member && memberHelper.source.trusted,
    "the helper's run is held to the member's access, as the asking run is",
    memberHelper.source,
  );
  check(
    memberHelper.answer.includes("couldn't read") && !memberRun.answer.includes("PRICE-42"),
    "…so it can't read the owner's page the member can't open, though the helper may",
    { helper: memberHelper.answer, asking: memberRun.answer },
  );
  const [memberView] = (await agents.listAgentRuns(ids.owner, researcher.id)).filter((r) => r.id === memberHelper.id);
  check(memberView.answer.includes("couldn't read") && memberView.handoff?.task === memberHelper.prompt, "an owner who can open the row sees the helper's run, as the row's run", memberView);

  // ── A run no one stands behind makes its helper untrusted ───────────────────────────────────
  const [anonymousRow] = await createRows(ids.owner, tickets.id, [{ title: "From a stranger" }]);
  await flushAutomations();
  await flushAgentRuns();
  const strangerRunId = await queueAgentRun({
    agentId: coordinator.id,
    workspaceId,
    source: { kind: "automation", automationId: `${RUN}-auto`, automationRunId: `${RUN}-auto-run`, databaseId: tickets.id, rowId: anonymousRow.id },
    context: { created: true, changed: [], actorId: null },
    prompt: "Quote this stranger.",
  });
  await flushAgentRuns();
  const [strangerHelper] = (await db.select().from(agentRun).where(eq(agentRun.agentId, researcher.id))).filter((r) => r.source.kind === "handoff" && r.source.parentRunId === strangerRunId);
  check(
    strangerHelper?.source.kind === "handoff" && !strangerHelper.source.trusted && strangerHelper.source.boundTo === null,
    "a helper of a run no member stands behind is untrusted: its connection tools wait for an owner",
    strangerHelper?.source,
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
