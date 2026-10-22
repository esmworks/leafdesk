/**
 * End-to-end check of agents over the REST API, against the database and a fake OpenAI-compatible
 * server (src/server/ai/fake-openai.ts), calling the API handler in-process: owners list, read and
 * change agents (pause, resume, a monthly token limit), ask one for a task on no row (it only reads
 * and answers) or on a row (it changes that row), read its runs and its usage by month. A run asked
 * for is held to the asking owner's access as well as the agent's; asking is refused while the
 * agent is paused, AI is off, the month's tokens are used up or too many asked-for runs wait; a run
 * under way stops once the month reaches the limit. Members it is shared with to view and interact
 * read it but don't change it or ask it for runs; read-only tokens, tokens for another workspace
 * and workspaces that let apps only read are refused. The audit log records each request,
 * and the daily cleanup forgets old months.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-api-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the runs.
 */
import { API_TOKEN_SCOPES as ALL_SCOPES, READ_SCOPES } from "@/lib/api-scopes";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, agentShare, agentUsage, auditEvent, page, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { addProperty, createRows } = await import("@/server/databases");
const { setPagePermission } = await import("@/server/permissions");
const { pageAccessOf } = await import("@/server/access");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const agents = await import("@/server/agents/manage");
const { flushAgentRuns } = await import("@/server/agents/run");
const { monthOf, pruneAgentUsage } = await import("@/server/agents/usage");
const { createApiToken } = await import("@/server/api/tokens");
const { handleApiRequest } = await import("@/server/api");
const { MAX_REQUESTED_RUNS } = await import("@/lib/agents");

const RUN = `agent-api-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
const AI_ON = { AI_PROVIDER: "openai-compatible", AI_MODEL: "fake-chat", AI_BASE_URL: fake.baseUrl, AI_WORKSPACE_RATE_LIMIT: "1000", AI_RATE_LIMIT: "1000" };
setAiEnv(AI_ON);

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

const everything = (request: FakeChatRequest) => request.messages.map((m) => textOf(m.content)).join("\n");
const toolResults = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));

/** A model that makes these tool calls, one per turn, then says `done`. */
function caller(calls: ((request: FakeChatRequest) => { name: string; arguments: Record<string, unknown> })[], done = "Done.") {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (made < calls.length) return { toolCalls: [calls[made](request)] };
    return { text: done };
  };
}

type Json = Record<string, any>;
async function api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await handleApiRequest(
    new Request(`http://localhost/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspaceId = `${RUN}-other`;

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
    { id: ids.outsider, name: "Outsider Oya", email: `${ids.outsider}@example.test` },
  ]);
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspaceId, name: `${RUN} other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId: otherWorkspaceId, userId: ids.owner, role: "owner" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const owner = { userId: ids.owner };
  const tickets = await createPage(owner, { workspaceId, teamspaceId: general.id, kind: "database", title: "Tickets" });
  await addProperty(ids.owner, tickets.id, { name: "Category", type: "select", options: ["Billing", "Bug"] });
  const [ticket] = await createRows(ids.owner, tickets.id, [{ title: "Refund for order 7" }]);
  const faq = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Billing FAQ", markdown: "Refunds take 5 days. KB-REFUND" });
  // A member's private page, shared with the agent but not with the owner who will ask for runs.
  const diary = await createPage({ userId: ids.member }, { workspaceId, teamspaceId: null, title: "Mert's notes", markdown: "SECRET-DIARY" });

  const router = await agents.createAgent(ids.owner, workspaceId, { name: "Ticket router", instructions: "Answer from the FAQ; set Category on rows." });
  await agents.setAgentAccess(ids.owner, router.id, tickets.id, "edit");
  await agents.setAgentAccess(ids.owner, router.id, faq.id, "view");
  await setPagePermission(ids.member, diary.id, router.userId, "view");
  check(
    (await pageAccessOf(router.userId, diary.id)).level === "view" && (await pageAccessOf(ids.owner, diary.id)).level === "none",
    "the agent can open the member's page; the owner can't",
  );

  const full = (await createApiToken(ids.owner, { name: "Agents", scopes: ALL_SCOPES })).secret;
  const readOnly = (await createApiToken(ids.owner, { name: "Agents (read)", scopes: READ_SCOPES })).secret;
  const elsewhere = (await createApiToken(ids.owner, { name: "Other workspace", scopes: ALL_SCOPES, workspaceId: otherWorkspaceId })).secret;
  const memberToken = (await createApiToken(ids.member, { name: "Member", scopes: ALL_SCOPES })).secret;

  // ── Reading and changing agents ───────────────────────────────────────────────────────────────
  const listed = await api(full, "GET", `/workspaces/${workspaceId}/agents`);
  check(listed.status === 200 && listed.json.agents.some((a: Json) => a.id === router.id && a.enabled === true && a.user_id === router.userId), "owners list a workspace's agents", listed);
  const byMember = await api(memberToken, "GET", `/workspaces/${workspaceId}/agents`);
  check(
    byMember.status === 200 && byMember.json.agents.length === 1 && byMember.json.agents[0].your_access === "interact" && !("instructions" in byMember.json.agents[0]),
    "members list those shared with them, with their access, without instructions",
    byMember.json,
  );
  const read = await api(full, "GET", `/agents/${router.id}`);
  check(
    read.status === 200 &&
      read.json.instructions.startsWith("Answer from the FAQ") &&
      read.json.monthly_token_limit === null &&
      read.json.usage_this_month.month === monthOf(new Date()).slice(0, 7) &&
      read.json.usage_this_month.runs === 0,
    "an owner reads an agent, with no limit and nothing used this month",
    read.json,
  );
  const byMemberRead = await api(memberToken, "GET", `/agents/${router.id}`);
  check(byMemberRead.status === 200 && byMemberRead.json.instructions.startsWith("Answer from the FAQ"), "a member it is shared with reads its settings", byMemberRead.json);
  const byMemberChange = await api(memberToken, "PATCH", `/agents/${router.id}`, { enabled: false });
  check(byMemberChange.status === 403 && byMemberChange.json.error.code === "forbidden", "…but can't change them at view & interact", byMemberChange.json);
  check((await api(elsewhere, "GET", `/agents/${router.id}`)).status === 404, "a token for another workspace doesn't see the agent");
  const memberSharing = await api(memberToken, "GET", `/agents/${router.id}/sharing`);
  check(
    memberSharing.status === 200 && memberSharing.json.your_access === "interact" && memberSharing.json.shared_with.some((e: Json) => e.everyone === true && e.level === "interact"),
    "a member reads who the agent is shared with",
    memberSharing.json,
  );
  const memberShares = await api(memberToken, "POST", `/agents/${router.id}/sharing`, { user_id: ids.member, level: "full" });
  check(memberShares.status === 403 && memberShares.json.error.code === "forbidden", "…but can't change it without full access", memberShares.json);
  check((await api(full, "POST", `/agents/${router.id}/sharing`, { everyone: true, user_id: ids.member, level: "edit" })).status === 400, "sharing names exactly one person, group or everyone");
  const shared = await api(full, "POST", `/agents/${router.id}/sharing`, { user_id: ids.member, level: "edit" });
  check(shared.status === 200 && shared.json.shared_with.some((e: Json) => e.user_id === ids.member && e.level === "edit"), "an owner shares it with the member at edit", shared.json);
  const byEditor = await api(memberToken, "PATCH", `/agents/${router.id}`, { description: "Answers questions" });
  check(byEditor.status === 200 && byEditor.json.your_access === "edit", "…who can then change it", byEditor.json);
  const unshared = await api(full, "POST", `/agents/${router.id}/sharing`, { user_id: ids.member, level: "remove" });
  check(unshared.status === 200 && !unshared.json.shared_with.some((e: Json) => e.user_id === ids.member), "…and takes them off the list again", unshared.json);
  const badLimit = await api(full, "PATCH", `/agents/${router.id}`, { monthly_token_limit: 0 });
  check(badLimit.status === 400 && badLimit.json.error.code === "validation_error", "a monthly limit is at least one token", badLimit.json);
  const nothing = await api(full, "PATCH", `/agents/${router.id}`, {});
  check(nothing.status === 400 && nothing.json.error.code === "invalid_request", "a change needs something to change", nothing.json);
  const paused = await api(full, "PATCH", `/agents/${router.id}`, { enabled: false });
  check(paused.status === 200 && paused.json.enabled === false, "an owner pauses an agent", paused.json);
  const whilePaused = await api(full, "POST", `/agents/${router.id}/runs`, { task: "Anything" });
  check(whilePaused.status === 409 && whilePaused.json.error.code === "agent_unavailable", "a paused agent can't be asked for a run", whilePaused.json);
  check((await api(full, "PATCH", `/agents/${router.id}`, { enabled: true })).json.enabled === true, "…and turns it back on");

  // ── Who may ask ───────────────────────────────────────────────────────────────────────────────
  const noScope = await api(readOnly, "POST", `/agents/${router.id}/runs`, { task: "Anything" });
  check(noScope.status === 403 && noScope.json.error.code === "missing_scope" && noScope.json.error.details.scope === "agents:write", "asking for a run needs agents:write", noScope.json);
  check((await api(memberToken, "POST", `/agents/${router.id}/runs`, { task: "Anything" })).status === 403, "members who can only view and interact can't ask it for a run");
  check((await api(full, "POST", `/agents/${router.id}/runs`, { task: "" })).status === 400, "a run needs a task");
  const notARow = await api(full, "POST", `/agents/${router.id}/runs`, { task: "Anything", row_id: faq.id });
  check(notARow.status === 404, "row_id must be a database row", notARow.json);
  check((await api(full, "POST", `/agents/${router.id}/runs`, { task: "Anything", row_id: diary.id })).status === 404, "…the owner can open");
  const [template] = await createRows(ids.owner, tickets.id, [{ title: "New ticket" }]);
  await db.update(page).set({ isTemplate: true }).where(eq(page.id, template.id));
  check((await api(full, "POST", `/agents/${router.id}/runs`, { task: "Anything", row_id: template.id })).status === 404, "…and not a row template");
  await updateWorkspaceSettings(ids.owner, workspaceId, { connectedApps: "read" });
  const readMode = await api(full, "POST", `/agents/${router.id}/runs`, { task: "Anything" });
  check(readMode.status === 403 && readMode.json.error.code === "forbidden", "a workspace that lets apps only read refuses runs", readMode.json);
  check((await api(full, "GET", `/agents/${router.id}/runs`)).status === 200, "…but lets them read the runs");
  await updateWorkspaceSettings(ids.owner, workspaceId, { connectedApps: "full" });
  setAiEnv({});
  const aiOff = await api(full, "POST", `/agents/${router.id}/runs`, { task: "Anything" });
  check(aiOff.status === 409 && aiOff.json.error.code === "agent_unavailable", "with AI off, asking is refused rather than queued", aiOff.json);
  setAiEnv(AI_ON);

  // ── A run on no row: it reads, within the owner's access, and answers ─────────────────────────
  fake.chats.length = 0;
  fake.setChat(
    caller(
      [
        () => ({ name: "search_pages", arguments: { query: "refund" } }),
        () => ({ name: "read_page", arguments: { page_id: diary.id } }),
      ],
      "Refunds take 5 days.",
    ),
  );
  const asked = await api(full, "POST", `/agents/${router.id}/runs`, { task: "How long do refunds take?" });
  check(
    asked.status === 201 &&
      asked.json.status === "pending" &&
      asked.json.source.kind === "request" &&
      asked.json.source.via === "api" &&
      asked.json.source.requested_by.id === ids.owner &&
      asked.json.source.task === "How long do refunds take?" &&
      !("row" in asked.json),
    "an owner asks for a run with a task; it is queued",
    asked.json,
  );
  await flushAgentRuns();
  const done = await api(full, "GET", `/agents/${router.id}/runs/${asked.json.id}`);
  check(done.status === 200 && done.json.status === "done" && done.json.answer === "Refunds take 5 days.", "the run's endpoint shows how it went and its answer", done.json);
  check(done.json.usage?.rounds === 3 && done.json.usage.input_tokens === 30 && done.json.usage.output_tokens === 15, "…and the tokens it used", done.json.usage);
  const first = fake.chats[0];
  const names = first.tools?.map((t) => t.function.name) ?? [];
  check(!names.includes("update_row") && !names.includes("add_comment") && names.includes("search_pages"), "a run on no row may only read", names);
  check(
    /Owner Olcay asked for this run over the REST API/.test(everything(first)) && /<task>\nHow long do refunds take\?\n<\/task>/.test(everything(first)),
    "the model hears who asked, where, and the task",
    everything(first).slice(-600),
  );
  const results = toolResults(fake.chats.at(-1)!);
  check(results.some((r) => r.includes("KB-REFUND")) && !results.some((r) => r.includes("SECRET-DIARY")), "it reads what both the agent and the owner can open, and not the member's page only the agent can", results);

  // ── A run on a row: it may change that row ────────────────────────────────────────────────────
  fake.setChat(caller([() => ({ name: "update_row", arguments: { row_id: ticket.id, properties: { Category: "Billing" } } })], "Set to Billing."));
  const onRow = await api(full, "POST", `/agents/${router.id}/runs`, { task: "Set the category", row_id: ticket.id });
  check(onRow.status === 201 && onRow.json.row?.id === ticket.id && onRow.json.source.database_id === tickets.id, "an owner asks for a run on a row", onRow.json);
  await flushAgentRuns();
  const rowRun = await api(full, "GET", `/agents/${router.id}/runs/${onRow.json.id}`);
  const row = await api(full, "GET", `/rows/${ticket.id}`);
  check(rowRun.json.status === "done" && row.json.properties.Category === "Billing", "the run changes the row it was asked for", { run: rowRun.json, row: row.json });
  const runs = await api(full, "GET", `/agents/${router.id}/runs?limit=5`);
  check(runs.status === 200 && runs.json.runs.length === 2 && runs.json.runs[0].id === onRow.json.id, "the runs list shows them newest first", runs.json.runs?.map((r: Json) => r.id));
  check((await api(full, "GET", `/agents/${router.id}/runs/not-a-run`)).status === 404, "an unknown run is not found");

  // ── Usage and the monthly limit ───────────────────────────────────────────────────────────────
  const usage = await api(full, "GET", `/agents/${router.id}/usage`);
  const month = usage.json.months?.[0];
  check(usage.status === 200 && month?.runs === 2 && month.input_tokens === 50 && month.output_tokens === 25, "the agent's usage counts each run and every turn", usage.json);
  const atLimit = await api(full, "PATCH", `/agents/${router.id}`, { monthly_token_limit: 75 });
  check(atLimit.status === 200 && atLimit.json.monthly_token_limit === 75 && atLimit.json.usage_this_month.input_tokens === 50, "an owner sets a monthly token limit", atLimit.json);
  const refused = await api(full, "POST", `/agents/${router.id}/runs`, { task: "Again" });
  check(refused.status === 409 && refused.json.error.code === "limit_reached", "once the month reaches it, asking is refused", refused.json);
  // One more turn's worth: the run takes its first turn, then stops.
  await api(full, "PATCH", `/agents/${router.id}`, { monthly_token_limit: 80 });
  fake.setChat(caller([() => ({ name: "search_pages", arguments: { query: "a" } }), () => ({ name: "search_pages", arguments: { query: "b" } })]));
  const stopping = await api(full, "POST", `/agents/${router.id}/runs`, { task: "Search a lot" });
  await flushAgentRuns();
  const stopped = await api(full, "GET", `/agents/${router.id}/runs/${stopping.json.id}`);
  check(stopped.json.status === "failed" && stopped.json.code === "limitReached" && stopped.json.usage?.rounds === 1, "a run under way stops at its next turn once the month reaches the limit", stopped.json);
  const after = (await api(full, "GET", `/agents/${router.id}/usage`)).json.months[0];
  check(after.runs === 3 && after.input_tokens + after.output_tokens === 90, "…having counted what it used", after);
  // A run taken again (after an owner's answer, or after its worker stopped) first answers the calls
  // it had waiting, then stops before its next turn.
  const waitingCall = { id: "call-1", name: "search_pages", arguments: { query: "refund" } };
  const [resumed] = await db
    .insert(agentRun)
    .values({
      agentId: router.id,
      workspaceId,
      source: { kind: "request", requestedBy: ids.owner, via: "api" },
      context: { actorId: ids.owner },
      prompt: "Go on",
      state: { messages: [{ role: "user", content: "Go on" }, { role: "assistant", content: "", toolCalls: [waitingCall] }], queue: [waitingCall], rounds: 1, writes: 0, externalChars: 0 },
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, rounds: 1 },
    })
    .returning({ id: agentRun.id });
  fake.chats.length = 0;
  await flushAgentRuns();
  const resumedRun = await api(full, "GET", `/agents/${router.id}/runs/${resumed.id}`);
  check(
    resumedRun.json.status === "failed" && resumedRun.json.code === "limitReached" && resumedRun.json.steps?.some((s: Json) => s.kind === "search") && fake.chats.length === 0,
    "a run taken again past the limit answers the calls it had waiting, then stops before its next turn",
    resumedRun.json,
  );
  const cleared = await api(full, "PATCH", `/agents/${router.id}`, { monthly_token_limit: null });
  check(cleared.json.monthly_token_limit === null, "null removes the limit");

  // ── Too many runs waiting ─────────────────────────────────────────────────────────────────────
  fake.setChat(() => ({ text: "ok" }));
  const queued = [];
  for (let i = 0; i < MAX_REQUESTED_RUNS; i++) queued.push(await api(full, "POST", `/agents/${router.id}/runs`, { task: `Task ${i}` }));
  check(queued.every((r) => r.status === 201), `${MAX_REQUESTED_RUNS} runs may wait at once`);
  const tooMany = await api(full, "POST", `/agents/${router.id}/runs`, { task: "One more" });
  check(tooMany.status === 409 && tooMany.json.error.code === "too_many_runs", "…and asking for one more is refused", tooMany.json);
  await flushAgentRuns();
  check((await api(full, "POST", `/agents/${router.id}/runs`, { task: "After" })).status === 201, "once they finish, owners may ask again");
  await flushAgentRuns();
  const burst = await Promise.all(Array.from({ length: MAX_REQUESTED_RUNS + 3 }, (_, i) => api(full, "POST", `/agents/${router.id}/runs`, { task: `Burst ${i}` })));
  check(
    burst.filter((r) => r.status === 201).length === MAX_REQUESTED_RUNS && burst.filter((r) => r.json.error?.code === "too_many_runs").length === 3,
    `asking many times at once still queues at most ${MAX_REQUESTED_RUNS}`,
    burst.map((r) => r.status),
  );
  await flushAgentRuns();

  // ── An asker who can no longer edit the agent ─────────────────────────────────────────────────
  // No longer an owner, and the entry they got for creating it narrowed to view & interact.
  const ownerRow = and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.owner));
  const creatorEntry = and(eq(agentShare.agentId, router.id), eq(agentShare.userId, ids.owner));
  const beforeDemotion = await api(full, "POST", `/agents/${router.id}/runs`, { task: "Later" });
  await db.update(workspaceMember).set({ role: "member" }).where(ownerRow);
  await db.update(agentShare).set({ level: "interact" }).where(creatorEntry);
  await flushAgentRuns();
  await db.update(workspaceMember).set({ role: "owner" }).where(ownerRow);
  await db.update(agentShare).set({ level: "full" }).where(creatorEntry);
  const demoted = await api(full, "GET", `/agents/${router.id}/runs/${beforeDemotion.json.id}`);
  check(demoted.json.status === "failed" && demoted.json.code === "noAccess", "a run whose asker can no longer edit the agent opens nothing", demoted.json);

  // ── The docs, the audit log and the cleanup ───────────────────────────────────────────────────
  const doc = (await (await handleApiRequest(new Request("http://localhost/api/v1/openapi.json"))).json()) as Json;
  check(
    doc.paths["/agents/{agent_id}/runs"]?.post?.responses?.["409"] && doc.components.schemas.AgentRun && doc.tags.some((t: Json) => t.name === "Agents"),
    "the OpenAPI document describes the agents' endpoints",
  );
  const requested = await db
    .select({ actor: auditEvent.actorUserId })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "agent.run_requested")));
  check(requested.length === 3 + MAX_REQUESTED_RUNS + 1 + MAX_REQUESTED_RUNS + 1 && requested.every((e) => e.actor === ids.owner), "the audit log records each run asked for, by the owner", requested.length);
  await db.insert(agentUsage).values({ agentId: router.id, month: "2024-01-01", runs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 });
  await pruneAgentUsage();
  const months = await db.select({ month: agentUsage.month }).from(agentUsage).where(eq(agentUsage.agentId, router.id));
  check(months.length === 1 && months[0].month === monthOf(new Date()), "the daily cleanup forgets months older than a year", months);

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(inArray(workspaceAgent.workspaceId, [workspaceId, otherWorkspaceId]))).map(
    (a) => a.userId,
  );
  await db.delete(agentRun).where(inArray(agentRun.workspaceId, [workspaceId, otherWorkspaceId]));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspaceId]));
  await db.delete(user).where(inArray(user.id, [...userIds, ...botUsers]));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
