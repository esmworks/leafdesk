/**
 * End-to-end check of copying agents (server/agents/duplicate.ts) against the database: an owner's
 * copy takes the agent's settings, instructions, skills, the agents it can ask and its connection
 * tools, numbered like a page's copy, and none of its pages, schedules, memory, versions or who
 * it is shared with; a member's copy leaves out what they couldn't give an agent themselves (a
 * skill they can't open, an agent it can ask that isn't shared with them, connection tools) and
 * keeps the monthly token limit only owners set; who can only view and interact, or may not create
 * agents, is refused; an archived agent's copy is live; the audit log names the source; MCP
 * create_agent with copy_of and REST POST /agents/{id}/duplicate do the same. Creates its own
 * users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-copy-e2e.ts
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
const { agentGrant, agentRun, agentSkill, auditEvent, connection, pagePermission, schedule, teamspace, user, workspace, workspaceAgent, workspaceMember } =
  await import("@/db/schema");
const { seal } = await import("@/server/secret-box");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setSkill } = await import("@/server/skills");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { createApiToken } = await import("@/server/api/tokens");
const { handleApiRequest } = await import("@/server/api");
const { API_TOKEN_SCOPES } = await import("@/lib/api-scopes");
const agents = await import("@/server/agents/manage");
const sharing = await import("@/server/agents/sharing");
const memory = await import("@/server/agents/memory");
const schedules = await import("@/server/agents/schedules");
const versions = await import("@/server/agents/versions");
const { addAgentSkill } = await import("@/server/agents/skills");
const { duplicateAgent } = await import("@/server/agents/duplicate");
const { setAgentGrant } = await import("@/server/connections/manage");

const RUN = `agent-copy-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);

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

/** The error's code when the promise fails (`access` for an AccessError), null when it doesn't. */
async function refusal(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof agents.AgentError) return error.code;
    if (error instanceof AccessError) return "access";
    return `other: ${error instanceof Error ? error.message : String(error)}`;
  }
}

type Json = Record<string, any>;
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: [READ_SCOPE, WRITE_SCOPE] });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const hit = inbox.find((m) => m.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no MCP response for ${name}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "agent-copy-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: (result.isError ? null : JSON.parse(text)) as Json };
}

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

const ids = { owner: `${RUN}-owner`, editor: `${RUN}-editor`, viewer: `${RUN}-viewer` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

const skillsOf = async (agentId: string) =>
  (await db.select({ pageId: agentSkill.pageId }).from(agentSkill).where(eq(agentSkill.agentId, agentId)).orderBy(agentSkill.position)).map((s) => s.pageId);
const grantsOf = (agentId: string) => db.select({ connectionId: agentGrant.connectionId, tools: agentGrant.tools }).from(agentGrant).where(eq(agentGrant.agentId, agentId));
const userOf = async (agentId: string) => (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.id, agentId)))[0].userId;
const pagesSharedWith = async (agentId: string) => db.select().from(pagePermission).where(eq(pagePermission.userId, await userOf(agentId)));
const helpersOf = async (agentId: string) => (await callTool(ids.owner, "get_agent", { agent_id: agentId })).data.helper_agent_ids as string[];

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.editor, name: "Editor Ece", email: `${ids.editor}@example.test` },
    { id: ids.viewer, name: "Viewer Veli", email: `${ids.viewer}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const owner = { userId: ids.owner };

  // ── The agent to copy, set up all the way ───────────────────────────────────────────────────
  const helperShared = await agents.createAgent(ids.owner, workspaceId, { name: "Researcher" });
  const helperHidden = await agents.createAgent(ids.owner, workspaceId, { name: "Owners' auditor" });
  await sharing.removeAgentShare(ids.owner, helperHidden.id, { kind: "everyone" });
  // Both skills are private pages of the owner: only owners may edit them. The member may open the first.
  const sharedSkill = await createPage(owner, { workspaceId, teamspaceId: null, title: "Tone", markdown: "Be brief." });
  await setSkill(ids.owner, sharedSkill.id, { skill: true });
  await setPagePermission(ids.owner, sharedSkill.id, ids.editor, "view");
  const privateSkill = await createPage(owner, { workspaceId, teamspaceId: null, title: "Pricing", markdown: "Never discount." });
  await setSkill(ids.owner, privateSkill.id, { skill: true });
  const notes = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Notes", markdown: "Hello" });

  const source = await agents.createAgent(ids.owner, workspaceId, {
    name: "Triage",
    icon: "🧭",
    description: "Sorts the inbox",
    instructions: "Sort new tickets by product.",
    model: "fast",
    webAccess: true,
    rowChanges: "review",
    monthlyTokenLimit: 50_000,
    helperAgentIds: [helperShared.id, helperHidden.id],
  });
  await addAgentSkill(ids.owner, source.id, sharedSkill.id);
  await addAgentSkill(ids.owner, source.id, privateSkill.id);
  const [conn] = await db
    .insert(connection)
    .values({
      workspaceId,
      name: "Tracker",
      slug: "tracker",
      url: "https://tracker.example.test/mcp",
      authType: "none",
      status: "ready",
      tools: [{ name: "create_issue", title: null, description: "Opens an issue", inputSchema: { type: "object", properties: {} }, hinted: "write", kind: "write" }],
      eventSecret: seal(`${RUN}-secret`),
      createdBy: ids.owner,
    })
    .returning();
  await setAgentGrant(ids.owner, source.id, conn.id, ["create_issue"]);
  await agents.setAgentAccess(ids.owner, source.id, notes.id, "edit");
  await schedules.setAgentSchedule(ids.owner, source.id, null, {
    rule: { frequency: "daily", interval: 1, weekdays: [], time: "08:00" },
    timeZone: "Europe/Istanbul",
    task: "Sort what came in overnight.",
  });
  await memory.addAgentMemory(ids.owner, source.id, "Product names are in the title");
  await sharing.setAgentShare(ids.owner, source.id, { kind: "person", userId: ids.editor }, "edit");
  await agents.updateAgent(ids.owner, source.id, { enabled: false });

  // ── An owner's copy ─────────────────────────────────────────────────────────────────────────
  const first = await duplicateAgent(ids.owner, source.id);
  const copy = first.agent;
  check(copy.id !== source.id && copy.name === "Triage (1)" && copy.access === "full", "an owner's copy is a new agent named like a page's copy, at full access", copy);
  check(
    copy.icon === "🧭" &&
      copy.description === "Sorts the inbox" &&
      copy.instructions === "Sort new tickets by product." &&
      copy.model === "fast" &&
      copy.webAccess &&
      copy.rowChanges === "review" &&
      copy.monthlyTokenLimit === 50_000 &&
      !copy.enabled,
    "…with the agent's icon, description, instructions, model, web access, row changes, token limit and pause",
    copy,
  );
  check(JSON.stringify(await skillsOf(copy.id)) === JSON.stringify([sharedSkill.id, privateSkill.id]), "…its skills, in their order");
  check(JSON.stringify(await helpersOf(copy.id)) === JSON.stringify([helperShared.id, helperHidden.id]), "…the agents it can ask");
  const grants = await grantsOf(copy.id);
  check(grants.length === 1 && grants[0].connectionId === conn.id && grants[0].tools.join() === "create_issue", "…and its connection tools", grants);
  check(Object.keys(first.leftOut).length === 0, "nothing is left out of an owner's copy", first.leftOut);
  check((await pagesSharedWith(copy.id)).length === 0, "no page is shared with the copy");
  check((await db.select().from(schedule).where(eq(schedule.agentId, copy.id))).length === 0, "…it has no schedules");
  check((await memory.listAgentMemory(ids.owner, copy.id)).length === 0, "…and no memory");
  const copyVersions = await versions.listAgentVersions(ids.owner, copy.id);
  check(copyVersions.length === 1 && copyVersions[0].kind === "created", "…and one version of its own", copyVersions);
  const copySharing = await sharing.agentSharing(ids.owner, copy.id);
  check(
    copySharing.entries.length === 2 &&
      copySharing.entries.some((e) => e.kind === "everyone" && e.level === "interact") &&
      copySharing.entries.some((e) => e.kind === "person" && e.userId === ids.owner && e.level === "full"),
    "…and it is shared as a new agent is, not as the agent was",
    copySharing.entries,
  );
  const [created] = await db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "agent.created"), eq(auditEvent.targetId, await userOf(copy.id))));
  const copiedFrom = (created?.details as Json | undefined)?.copiedFrom;
  check(copiedFrom?.id === source.id && copiedFrom?.name === "Triage", "the audit log names the agent it was copied from", created?.details);
  check((await duplicateAgent(ids.owner, source.id)).agent.name === "Triage (2)", "a second copy counts on");
  check((await duplicateAgent(ids.owner, copy.id)).agent.name === "Triage (3)", "…as does a copy of the copy");
  check((await duplicateAgent(ids.owner, source.id, { name: "Billing triage" })).agent.name === "Billing triage", "a name given replaces the numbered one");

  // ── A member's copy ─────────────────────────────────────────────────────────────────────────
  check((await refusal(duplicateAgent(ids.editor, source.id))) === "access", "a member who may not create agents can't copy one");
  await updateWorkspaceSettings(ids.owner, workspaceId, { agentCreation: "members" });
  check((await refusal(duplicateAgent(ids.viewer, source.id))) === "notAllowed", "who can only view and interact with it can't copy it");
  const mine = await duplicateAgent(ids.editor, source.id);
  check(mine.agent.name === "Triage (4)", "…numbered after the copies there are");
  check(mine.agent.access === "full" && mine.agent.monthlyTokenLimit === 50_000, "a member who can edit it copies it, keeping the token limit only owners set", mine.agent);
  check(JSON.stringify(await skillsOf(mine.agent.id)) === JSON.stringify([sharedSkill.id]), "…without the skill they can't open");
  check(JSON.stringify(await helpersOf(mine.agent.id)) === JSON.stringify([helperShared.id]), "…the agent it can ask that isn't shared with them");
  check((await grantsOf(mine.agent.id)).length === 0, "…and the connection tools, which owners give");
  check(mine.leftOut.skills === 1 && mine.leftOut.helpers === 1 && mine.leftOut.connections === 1, "…and says what it left out", mine.leftOut);
  check((await refusal(agents.updateAgent(ids.editor, mine.agent.id, { monthlyTokenLimit: 1 }))) === "ownersOnly", "the limit stays the owners' to change");

  // ── An archived agent ───────────────────────────────────────────────────────────────────────
  await agents.archiveAgent(ids.owner, source.id);
  const revived = (await duplicateAgent(ids.owner, source.id)).agent;
  check(!revived.archived && revived.enabled, "an archived agent's copy is live and running", revived);

  // ── MCP and the REST API ────────────────────────────────────────────────────────────────────
  let r = await callTool(ids.owner, "create_agent", { workspace_id: workspaceId, copy_of: copy.id, instructions: "Sort by customer." });
  check(
    !r.isError && r.data.name === "Triage (6)" && r.data.instructions === "Sort by customer." && r.data.model === "fast" && r.data.copied_from === copy.id && !r.data.left_out,
    "MCP create_agent with copy_of copies it, and what it is given replaces what is copied",
    r.text,
  );
  r = await callTool(ids.viewer, "create_agent", { workspace_id: workspaceId, copy_of: copy.id });
  check(r.isError && r.text.includes("doesn't allow this"), "…and refuses who can only view and interact", r.text);
  await sharing.setAgentShare(ids.owner, copy.id, { kind: "person", userId: ids.editor }, "edit");
  r = await callTool(ids.editor, "create_agent", { workspace_id: workspaceId, copy_of: copy.id });
  check(!r.isError && r.data.left_out?.connections === 1 && r.data.left_out?.skills === 1, "…counting what a member's copy left out", r.text);
  r = await callTool(ids.owner, "create_agent", { workspace_id: workspaceId });
  check(r.isError && r.text.includes("name"), "without copy_of, create_agent still needs a name", r.text);

  const token = (await createApiToken(ids.owner, { name: "Agents", scopes: API_TOKEN_SCOPES })).secret;
  const viewerToken = (await createApiToken(ids.viewer, { name: "Agents", scopes: API_TOKEN_SCOPES })).secret;
  let res = await api(token, "POST", `/agents/${copy.id}/duplicate`);
  check(
    res.status === 201 && res.json.name === "Triage (8)" && res.json.copied_from === copy.id && res.json.left_out?.connections === 0 && res.json.usage_this_month,
    "REST POST /agents/{id}/duplicate answers the copy",
    res,
  );
  res = await api(token, "POST", `/agents/${copy.id}/duplicate`, { name: "Support triage" });
  check(res.status === 201 && res.json.name === "Support triage", "…named as asked", res);
  res = await api(viewerToken, "POST", `/agents/${copy.id}/duplicate`, {});
  check(res.status === 403, "…and refuses who can only view and interact", res);
  const doc = (await (await handleApiRequest(new Request("http://localhost/api/v1/openapi.json"))).json()) as Json;
  check(doc.paths["/agents/{agent_id}/duplicate"]?.post?.operationId === "duplicateAgent", "the OpenAPI document lists it");

  console.log(`\nAll ${passed} checks passed.`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(agentRun).where(eq(agentRun.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...userIds, ...botUsers]));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
