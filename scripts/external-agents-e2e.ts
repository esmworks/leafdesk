/**
 * End-to-end check of external agents (outside MCP clients and tokens that work as an agent's own
 * user, server/agents/external.ts) against a running app (`pnpm dev` or `pnpm start`) and its
 * database: who may act as an agent (only the verified person and OAuth app, or the agent's own
 * token, it is bound to; never one named in an argument), what its tools show and change (only what
 * was shared with the agent, as the agent), assignment in person properties, mentions that start
 * no run, the connected-apps policy, pausing, archiving and unbinding, and finally one real
 * round trip through `/mcp` (OAuth sign-in, consent, token) and the REST API's `/assigned-work`.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/external-agents-e2e.ts
 *
 * Env: APP_URL (default http://localhost:3000), DATABASE_URL (read from .env when present).
 */
export {};

import { createHash, randomBytes } from "node:crypto";

try {
  process.loadEnvFile();
} catch {}

const BASE = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const RESOURCE = `${BASE}/mcp`;
const REDIRECT_URI = "http://127.0.0.1:33419/callback";

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, count, desc, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, externalAgentBinding, externalAgentMention, oauthClient, oauthConsent, rowActivity, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { runAsConnectedApp } = await import("@/server/connected-app");
const databases = await import("@/server/databases");
const agents = await import("@/server/agents/manage");
const external = await import("@/server/agents/external");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { changeComments, listComments } = await import("@/server/comments");
const { commentMentionCandidates } = await import("@/server/mentions");
const { listRowActivity } = await import("@/server/row-activity-feed");
const { startTriggered } = await import("@/server/triggers");

const { hocuspocus, service } = createCollab();
registerCollab(service);

const RUN = `external-agents-e2e-${Date.now().toString(36)}`;

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

async function rejects(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as Error;
  }
}

// ---------------------------------------------------------------------------------- MCP, in process

type Called = { isError: boolean; text: string; data: any };

/** Calls an MCP tool as `userId` through the OAuth client `clientId`, as the /mcp route would (inside a connected-app request). */
async function callTool(userId: string, clientId: string, name: string, args: Record<string, unknown>, scopes = [READ_SCOPE, WRITE_SCOPE]): Promise<Called> {
  return runAsConnectedApp({ userId, app: { kind: "connected_app", id: clientId } }, async () => {
    const server = createMcpServer({ userId, clientId, scopes });
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
    client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
    await server.connect(serverSide);
    await client.start();
    const waitFor = async (id: number) => {
      for (let i = 0; i < 600; i++) {
        const hit = inbox.find((m) => m.id === id);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`no MCP response for ${name}`);
    };
    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "external-agents-e2e", version: "1" } } });
    await waitFor(1);
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
    const result = (await waitFor(2)).result!;
    await server.close();
    const text = result.content[0].text;
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { isError: Boolean(result.isError), text, data };
  });
}

// ---------------------------------------------------------------------------------- the world

const ids = {
  owner: `${RUN}-owner`,
  member: `${RUN}-member`,
  other: `${RUN}-other`,
};
const clients = { code: `${RUN}-code`, cursor: `${RUN}-cursor`, memberOnly: `${RUN}-members` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const workspaceIds = [workspaceId];
const extraUserIds: string[] = [];
const extraClientIds: string[] = [];

type Body = unknown[];
const body = (...parts: (string | { userId: string; name: string })[]): Body => [
  {
    type: "paragraph",
    content: parts.map((p) => (typeof p === "string" ? { type: "text", text: p, styles: {} } : { type: "mention", props: { kind: "user", id: `m-${p.userId}`, userId: p.userId, name: p.name } })),
  },
];

const setConnectedApps = (mode: "full" | "read" | "off") =>
  db.update(workspace).set({ settings: { connectedApps: mode } }).where(eq(workspace.id, workspaceId));

async function main() {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id.split("-").at(-1)!, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.other, role: "member" },
  ]);
  // Connected apps: what each person authorized (a minute ago, before any binding below).
  const earlier = new Date(Date.now() - 60_000);
  await db.insert(oauthClient).values(
    Object.values(clients).map((clientId) => ({ id: clientId, clientId, name: `App ${clientId.split("-").at(-1)}`, redirectUris: [] })),
  );
  const consent = (userId: string, clientId: string) => ({ id: `${userId}-${clientId}`, userId, clientId, scopes: ["pages:read", "pages:write"], createdAt: earlier, updatedAt: earlier });
  await db.insert(oauthConsent).values([
    consent(ids.owner, clients.code),
    consent(ids.owner, clients.cursor),
    consent(ids.member, clients.code),
    consent(ids.member, clients.memberOnly),
  ]);

  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  const secrets = await createPage(actor, { workspaceId, kind: "database", title: "Private tasks" });
  const props = await databases.getProperties(tasks.id);
  const status = props.find((p) => p.type === "status")!;
  const [notStarted, inProgress, done] = status.options.options!;
  const assignee = await databases.addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });
  const secretProps = await databases.getProperties(secrets.id);
  const secretAssignee = await databases.addProperty(ids.owner, secrets.id, { name: "Assignee", type: "person" });
  void secretProps;

  // ── Making the agent ──────────────────────────────────────────────────────────────────────
  const made = await external.createExternalAgent(ids.owner, workspaceId, { name: "Claude Code", icon: "🧑‍💻", description: "Works on tasks", via: { kind: "app", clientId: clients.code } });
  const agent = made.agent;
  check(agent.kind === "external" && made.secret === null, "an external agent bound to a connected app is made, with no token", made);
  const [stored] = await db.select().from(externalAgentBinding).where(eq(externalAgentBinding.agentId, agent.id));
  check(stored.clientId === clients.code && stored.userId === ids.owner && stored.tokenId === null, "it is bound to the app and to the person who bound it", stored);
  check((await agents.getAgent(ids.owner, agent.id)).kind === "external", "the agent shows its kind");

  const refusedApp = await rejects(() => external.createExternalAgent(ids.owner, workspaceId, { name: "Not mine", via: { kind: "app", clientId: clients.memberOnly } }));
  check(refusedApp !== null, "an app only someone else connected can't be bound", refusedApp?.message);
  const noGhost = await db.select({ n: count() }).from(workspaceAgent).where(and(eq(workspaceAgent.workspaceId, workspaceId), eq(workspaceAgent.name, "Not mine")));
  check(noGhost[0].n === 0, "…and a refused binding leaves no agent behind");

  // Shared with the agent: the Tasks database (edit) and nothing else.
  await agents.setAgentAccess(ids.owner, agent.id, tasks.id, "edit");

  // ── Assigning it in a person property ─────────────────────────────────────────────────────
  const people = await databases.getPeople(ids.owner, await databases.getProperties(tasks.id));
  check(people.some((p) => p.id === agent.userId && p.isAgent), "the agent is offered among the people of a person property", people.map((p) => p.name));
  const mine = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Fix the build", properties: { [status.id]: notStarted.id } });
  const unassigned = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Somebody else's task", properties: { [status.id]: notStarted.id } });
  const hidden = await createPage(actor, { workspaceId, parentId: secrets.id, title: "Not shared with the agent" });
  await databases.updateRowProperties(ids.owner, mine.id, { [assignee.id]: [agent.userId] });
  await databases.updateRowProperties(ids.owner, hidden.id, { [secretAssignee.id]: [agent.userId] });
  const [{ stillThere }] = await db.select({ stillThere: count() }).from(workspaceMember).where(and(eq(workspaceMember.userId, agent.userId), eq(workspaceMember.workspaceId, workspaceId)));
  check(stillThere === 1, "assigning it keeps it a member of the workspace");

  const internal = await agents.createAgent(ids.owner, workspaceId, { name: "Inside agent", instructions: "Runs here." });
  const internalAssigned = await rejects(() => databases.updateRowProperties(ids.owner, unassigned.id, { [assignee.id]: [internal.userId] }));
  check(internalAssigned !== null, "an agent that runs here is still not a person to assign", internalAssigned?.message);

  // ── The tools, as the bound caller ────────────────────────────────────────────────────────
  const listed = await callTool(ids.owner, clients.code, "list_assigned_work", {});
  check(!listed.isError && listed.data.agent.id === agent.id, "the bound app lists the agent's work", listed.text);
  check(listed.data.rows.length === 1 && listed.data.rows[0].id === mine.id, "…the row assigned to it, not other rows and not one in a database not shared with it", listed.data.rows);
  check(listed.data.rows[0].status === notStarted.name && listed.data.rows[0].status_options.includes(done.name), "…with its status and the status options it may set", listed.data.rows[0]);

  // Assigned by name too (as MCP and the REST API name people), not only by id.
  await databases.updateRowProperties(ids.owner, unassigned.id, { [assignee.id]: [agent.name] });
  const byName = await callTool(ids.owner, clients.code, "list_assigned_work", {});
  check(byName.data.rows.some((r: { id: string }) => r.id === unassigned.id), "an agent can be assigned by its name", byName.data.rows);
  await databases.updateRowProperties(ids.owner, unassigned.id, { [assignee.id]: [] });
  check((await callTool(ids.owner, clients.code, "list_assigned_work", {})).data.rows.length === 1, "…and unassigned again");

  // ── Who may act as the agent ──────────────────────────────────────────────────────────────
  const otherApp = await callTool(ids.owner, clients.cursor, "list_assigned_work", {});
  check(otherApp.isError && /isn't bound/.test(otherApp.text), "the same person with another app is refused", otherApp.text);
  const otherPerson = await callTool(ids.member, clients.code, "list_assigned_work", {});
  check(otherPerson.isError && /isn't bound/.test(otherPerson.text), "the same app of another person is refused", otherPerson.text);
  const outsider = await callTool(ids.other, clients.code, "update_assigned_work", { row_id: mine.id, status: done.name });
  check(outsider.isError, "someone who never authorized the app is refused on writes too", outsider.text);
  const named = await callTool(ids.member, clients.code, "list_assigned_work", { agent_id: agent.id });
  check(named.isError, "naming the agent's id doesn't let an unbound caller act as it", named.text);

  const second = await external.createExternalAgent(ids.owner, workspaceId, { name: "Token agent", via: { kind: "token" } });
  check(typeof second.secret === "string" && second.secret.startsWith("esi_"), "an agent with a token of its own gets the secret once", second.secret?.slice(0, 4));
  const wrongOne = await callTool(ids.owner, clients.code, "list_assigned_work", { agent_id: second.agent.id });
  check(wrongOne.isError && /isn't bound/.test(wrongOne.text), "another agent's id is refused: the app is bound to one agent only", wrongOne.text);
  const [binding2] = await db.select().from(externalAgentBinding).where(eq(externalAgentBinding.agentId, second.agent.id));
  check(binding2.userId === second.agent.userId && binding2.tokenId, "a token agent's binding is its own user's token", binding2);

  // ── Changing what it was given ────────────────────────────────────────────────────────────
  const updated = await callTool(ids.owner, clients.code, "update_assigned_work", { row_id: mine.id, status: inProgress.name, comment: "Started on it" });
  check(!updated.isError && updated.data.status === inProgress.name && updated.data.commented === true, "the agent sets a status and comments", updated.text);
  const [latest] = await db.select().from(rowActivity).where(and(eq(rowActivity.rowId, mine.id), eq(rowActivity.kind, "property"))).orderBy(desc(rowActivity.createdAt));
  check(latest.actorUserId === agent.userId && latest.newValue === inProgress.id, "the change is the agent's own: the history names the agent, not the person whose app it is", latest);
  const feed = (await listRowActivity(ids.owner, mine.id, { limit: 20 })).entries.find((e) => e.kind === "property");
  check(feed?.actor.kind === "agent" && feed.actor.person?.id === agent.userId, "the board's history shows the agent as who changed it", feed?.actor);
  const comments = await listComments(ids.owner, mine.id);
  const written = JSON.stringify(comments);
  check(written.includes("Started on it") && written.includes(agent.userId), "the comment is the agent's", written.slice(0, 300));

  const notMine = await callTool(ids.owner, clients.code, "update_assigned_work", { row_id: unassigned.id, status: done.name });
  check(notMine.isError, "a row that doesn't name the agent can't be changed through the tool", notMine.text);
  const notShared = await callTool(ids.owner, clients.code, "update_assigned_work", { row_id: hidden.id, status: done.name });
  check(notShared.isError, "…nor one in a database not shared with the agent, even if it names it", notShared.text);
  const badStatus = await callTool(ids.owner, clients.code, "update_assigned_work", { row_id: mine.id, status: "Nonsense" });
  check(badStatus.isError && /Nonsense|status/i.test(badStatus.text), "an unknown status is refused, naming the options", badStatus.text);
  const both = await callTool(ids.owner, clients.code, "update_assigned_work", { row_id: mine.id, mention_id: "x", status: done.name });
  check(both.isError, "a call naming a row and a mention at once is refused", both.text);
  const extra = await callTool(ids.owner, clients.code, "update_assigned_work", { row_id: mine.id, workspace_id: workspaceId });
  check(extra.isError, "an argument the tool doesn't take is refused", extra.text);

  // ── Mentions ──────────────────────────────────────────────────────────────────────────────
  const brief = await createPage(actor, { workspaceId, title: "Release brief", markdown: "Ship on Friday." });
  await setPagePermission(ids.owner, brief.id, ids.owner, "full");
  const unseen = await createPage(actor, { workspaceId, title: "Agent can't see this", markdown: "Secret." });
  await agents.setAgentAccess(ids.owner, agent.id, brief.id, "comment");
  const mentionable = await commentMentionCandidates(ids.owner, brief.id, "");
  check(mentionable.agents.some((a) => a.id === agent.userId), "the agent is offered in the @ menu of a page it may comment on", mentionable.agents);
  const mentionableElsewhere = await commentMentionCandidates(ids.owner, unseen.id, "");
  check(!mentionableElsewhere.agents.some((a) => a.id === agent.userId), "…and not on a page it can't see", mentionableElsewhere.agents);

  const runsBefore = (await db.select({ n: count() }).from(agentRun).where(eq(agentRun.agentId, agent.id)))[0].n;
  const asked = await changeComments(ids.owner, brief.id, { type: "createThread", body: body({ userId: agent.userId, name: agent.name }, " please check the dates, ", { userId: agent.userId, name: agent.name }) });
  const mentions = await db.select().from(externalAgentMention).where(eq(externalAgentMention.agentId, agent.id));
  check(mentions.length === 1 && mentions[0].commentId === asked.comment!.id && mentions[0].pageId === brief.id, "mentioning the agent in a comment records one mention (however often it is named)", mentions);
  const runsAfter = (await db.select({ n: count() }).from(agentRun).where(eq(agentRun.agentId, agent.id)))[0].n;
  check(runsAfter === runsBefore, "…and starts no run: it never runs here");
  const startErr = await rejects(() => startTriggered({ agentId: agent.id, source: { kind: "request", requestedBy: ids.owner }, task: "x" } as never));
  check(startErr !== null, "no path starts a run of it (startTriggered refuses)", startErr?.message);

  const withMention = await callTool(ids.owner, clients.code, "list_assigned_work", {});
  const mention = withMention.data.mentions[0];
  check(withMention.data.mentions.length === 1 && mention.page_id === brief.id && /check the dates/.test(mention.text), "the mention is listed with its text", withMention.data.mentions);
  const handled = await callTool(ids.owner, clients.code, "update_assigned_work", { mention_id: mention.id, comment: "Dates look right." });
  check(!handled.isError && handled.data.handled === true && handled.data.commented === true, "the agent replies and marks it handled", handled.text);
  const [row] = await db.select().from(externalAgentMention).where(eq(externalAgentMention.id, mention.id));
  check(row.handledAt !== null && row.handledBy === agent.userId, "…the mention records that the agent handled it", row);
  check((await callTool(ids.owner, clients.code, "list_assigned_work", {})).data.mentions.length === 0, "…and it leaves the list");

  // ── The workspace's connected-apps policy holds, then the agent acts ──────────────────────
  await setConnectedApps("read");
  const readOnlyList = await callTool(ids.owner, clients.code, "list_assigned_work", {});
  check(!readOnlyList.isError, "where connected apps may only read, the agent's work can still be listed", readOnlyList.text);
  const readOnlyWrite = await callTool(ids.owner, clients.code, "update_assigned_work", { row_id: mine.id, status: done.name });
  check(readOnlyWrite.isError && /only read/.test(readOnlyWrite.text), "…but not changed", readOnlyWrite.text);
  await setConnectedApps("off");
  const offList = await callTool(ids.owner, clients.code, "list_assigned_work", {});
  check(offList.isError, "where connected apps are off, it is refused as unbound", offList.text);
  await setConnectedApps("full");

  // ── Pausing, consent, unbinding, archiving ────────────────────────────────────────────────
  await agents.updateAgent(ids.owner, agent.id, { enabled: false });
  check((await callTool(ids.owner, clients.code, "list_assigned_work", {})).isError, "a paused agent is refused");
  await agents.updateAgent(ids.owner, agent.id, { enabled: true });
  check(!(await callTool(ids.owner, clients.code, "list_assigned_work", {})).isError, "…and works again when resumed");

  await db.update(oauthConsent).set({ createdAt: new Date(Date.now() + 3_600_000) }).where(and(eq(oauthConsent.userId, ids.owner), eq(oauthConsent.clientId, clients.code)));
  check((await callTool(ids.owner, clients.code, "list_assigned_work", {})).isError, "an app authorized again after the binding is refused until it is bound again");
  await db.update(oauthConsent).set({ createdAt: earlier }).where(and(eq(oauthConsent.userId, ids.owner), eq(oauthConsent.clientId, clients.code)));
  check(!(await callTool(ids.owner, clients.code, "list_assigned_work", {})).isError, "(the consent as it was binds again)");

  await external.unbindExternalAgent(ids.owner, agent.id);
  check((await callTool(ids.owner, clients.code, "list_assigned_work", {})).isError, "after unbinding the app asks for nothing more");
  await external.bindExternalAgent(ids.owner, agent.id, { kind: "app", clientId: clients.code });
  check(!(await callTool(ids.owner, clients.code, "list_assigned_work", {})).isError, "…and works again when bound anew");
  const memberBind = await rejects(() => external.bindExternalAgent(ids.member, agent.id, { kind: "app", clientId: clients.code }));
  check(memberBind !== null, "someone without full access to the agent can't bind it");

  await agents.archiveAgent(ids.owner, agent.id);
  check((await callTool(ids.owner, clients.code, "list_assigned_work", {})).isError, "an archived agent is refused");
  check((await db.select({ n: count() }).from(externalAgentBinding).where(eq(externalAgentBinding.agentId, agent.id)))[0].n === 0, "…and its binding is gone");

  // ── Overview for the agent's page ─────────────────────────────────────────────────────────
  const overview = await external.externalAgentOverview(ids.owner, second.agent.id);
  check(overview.binding?.via === "token" && overview.work.length === 0, "the agent's page reads its binding and work", overview);

  // ── A real round trip: /mcp over OAuth, then the REST API with the agent's token ──────────
  await overHttp();

  console.log(`\n${passed} checks passed`);
}

// ---------------------------------------------------------------------------------- HTTP

const b64url = (buf: Buffer) => buf.toString("base64url");

class Jar {
  private cookies = new Map<string, string>();
  store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (attrs.some((a) => /max-age=0/i.test(a.trim())) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function json<T = any>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${res.url} (${res.status}): ${text.slice(0, 300)}`);
  }
}

const signedQuery = (pageUrl: string) => {
  const params = new URL(pageUrl, BASE).searchParams;
  const names = new Set(params.getAll("ba_param"));
  const out = new URLSearchParams();
  for (const [k, v] of params) if (k === "sig" || k === "ba_param" || names.has(k)) out.append(k, v);
  return out.toString();
};

async function authPost(jar: Jar, path: string, payload: unknown) {
  const res = await fetch(`${BASE}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: jar.header() }, body: JSON.stringify(payload) });
  jar.store(res);
  return res;
}

async function followRedirect(jar: Jar, url: string) {
  const res = await fetch(url, { redirect: "manual", headers: { cookie: jar.header(), accept: "text/html" } });
  jar.store(res);
  if (res.status === 200 && (res.headers.get("content-type") ?? "").includes("application/json")) {
    const reply = await json(res);
    check(reply.redirect === true && typeof reply.url === "string", `GET ${new URL(url).pathname} redirects`, reply);
    return new URL(reply.url, BASE).toString();
  }
  const location = res.headers.get("location");
  check(res.status >= 300 && res.status < 400 && location, `GET ${new URL(url).pathname} redirects`, { status: res.status });
  return new URL(location, BASE).toString();
}

async function rpc(token: string, payload: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(RESOURCE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...extra },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!text) return { status: res.status, message: undefined as any };
  const id = (payload as { id?: unknown }).id;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const messages = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()));
    return { status: res.status, message: messages.find((m) => m.id === id) ?? messages.at(-1) };
  }
  return { status: res.status, message: JSON.parse(text) };
}

async function overHttp() {
  const email = `${RUN}@example.test`;
  const password = "external-agents-e2e-123";
  const jar = new Jar();
  const signUp = await json(await authPost(jar, "/sign-up/email", { name: `Agents e2e ${RUN}`, email, password }));
  check(signUp?.user?.id, "sign up the HTTP user", signUp);
  extraUserIds.push(signUp.user.id);
  const [own] = await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, signUp.user.id));
  workspaceIds.push(own.id);
  const personId: string = signUp.user.id;

  // Discovery, registration, sign-in, consent and the code exchange (see scripts/mcp-e2e.ts).
  const prm = await json(await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`));
  const issuer = new URL(prm.authorization_servers[0]);
  const as = await json(await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`));
  const scope = "openid profile offline_access pages:read pages:write notifications:read files:write";
  const registered = await json(
    await fetch(as.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: `e2e agent app ${RUN}`, application_type: "native", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope }),
    }),
  );
  check(registered.client_id, "register an OAuth client", registered);
  extraClientIds.push(registered.client_id);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const authorizeUrl = new URL(as.authorization_endpoint);
  authorizeUrl.search = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: REDIRECT_URI, scope, state, code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE }).toString();
  let next = await followRedirect(jar, authorizeUrl.toString());
  const signedIn = await json(await authPost(jar, "/sign-in/email", { email, password, oauth_query: signedQuery(next) }));
  next = new URL(signedIn.url, BASE).toString();
  check(new URL(next).pathname === "/oauth/consent", "the flow reaches the consent page");
  const consented = await json(await authPost(jar, "/oauth2/consent", { accept: true, oauth_query: signedQuery(next) }));
  const code = new URL(consented.url).searchParams.get("code");
  check(code, "consent is given", consented);
  const tokens = await json(
    await fetch(as.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT_URI, client_id: registered.client_id, code_verifier: verifier, resource: RESOURCE }),
    }),
  );
  check(tokens.access_token, "the code exchanges for a token", tokens);

  // The person makes an agent bound to that app, shares a database with it and assigns a row.
  const wsId = own.id;
  const me = { userId: personId };
  const board = await createPage(me, { workspaceId: wsId, kind: "database", title: "Board" });
  const boardStatus = (await databases.getProperties(board.id)).find((p) => p.type === "status")!;
  const [todo, doing] = boardStatus.options.options!;
  const who = await databases.addProperty(personId, board.id, { name: "Who", type: "person" });
  const built = await external.createExternalAgent(personId, wsId, { name: "HTTP agent", via: { kind: "app", clientId: registered.client_id } });
  await agents.setAgentAccess(personId, built.agent.id, board.id, "edit");
  const task = await createPage(me, { workspaceId: wsId, parentId: board.id, title: "Wire it up", properties: { [boardStatus.id]: todo.id } });
  await databases.updateRowProperties(personId, task.id, { [who.id]: [built.agent.userId] });

  const unauth = await fetch(RESOURCE, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  check(unauth.status === 401, "/mcp without a token is refused");
  const init = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "external-agents-e2e", version: "1" } } });
  check(init.status === 200, "/mcp initializes with the token", init);
  await rpc(tokens.access_token, { jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-protocol-version": "2025-11-25" });
  // An app's list shows the core tools and the gates to the rest: held tools run through them.
  const heldWrites = new Set(["update_assigned_work"]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const params = name === "find_tools" ? { name, arguments: args } : { name: heldWrites.has(name) ? "run_write_tool" : "run_read_tool", arguments: { name, arguments: args } };
    const reply = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params }, { "mcp-protocol-version": "2025-11-25" });
    const result = reply.message?.result;
    if (!result) throw new Error(`tools/call ${name} failed: ${JSON.stringify(reply.message)}`);
    const text: string = result.content?.[0]?.text ?? "";
    let data: any = null;
    try {
      data = result.isError ? null : JSON.parse(text);
    } catch {}
    return { isError: Boolean(result.isError), text, data };
  };

  const listed = await call("list_assigned_work", {});
  check(!listed.isError && listed.data.agent.id === built.agent.id && listed.data.rows.length === 1 && listed.data.rows[0].id === task.id, "over /mcp the bound app lists the agent's work (through run_read_tool)", listed.text);
  const changed = await call("update_assigned_work", { row_id: task.id, status: doing.name });
  check(!changed.isError && changed.data.status === doing.name, "…and changes a status over /mcp (through run_write_tool)", changed.text);
  const [activity] = await db.select().from(rowActivity).where(and(eq(rowActivity.rowId, task.id), eq(rowActivity.kind, "property"))).orderBy(desc(rowActivity.createdAt));
  check(activity.actorUserId === built.agent.userId, "…as the agent", activity);
  const tools = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { "mcp-protocol-version": "2025-11-25" });
  const names: string[] = (tools.message?.result?.tools ?? []).map((t: { name: string }) => t.name);
  check(!names.includes("list_assigned_work") && names.includes("find_tools"), "an app's tool list keeps the work tools out of the core list (found with find_tools)", names.length);
  const found = await call("find_tools", { query: "assigned work agent" });
  check(!found.isError && /list_assigned_work/.test(found.text), "…where find_tools finds them", found.text.slice(0, 200));

  // Revoked: the grant is gone, and the token with it.
  const apiBase = `${BASE}/api/v1`;
  const tokenAgent = await external.createExternalAgent(personId, wsId, { name: "Script agent", via: { kind: "token" } });
  const secret = tokenAgent.secret!;
  await agents.setAgentAccess(personId, tokenAgent.agent.id, board.id, "edit");
  const task2 = await createPage(me, { workspaceId: wsId, parentId: board.id, title: "Script it", properties: { [boardStatus.id]: todo.id } });
  await databases.updateRowProperties(personId, task2.id, { [who.id]: [tokenAgent.agent.userId] });
  const rest = (path: string, init: RequestInit = {}, token = secret) => fetch(`${apiBase}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const restList = await rest("/assigned-work");
  const restBody = await json(restList);
  check(restList.status === 200 && restBody.agent.id === tokenAgent.agent.id && restBody.rows.length === 1 && restBody.rows[0].id === task2.id, "the agent's token lists its work over the REST API", restBody);
  const restUpdate = await rest("/assigned-work", { method: "PATCH", body: JSON.stringify({ row_id: task2.id, status: doing.name, comment: "On it" }) });
  const restUpdated = await json(restUpdate);
  check(restUpdate.status === 200 && restUpdated.status === doing.name && restUpdated.commented === true, "…changes a status and comments over the REST API", restUpdated);
  const restOther = await rest("/assigned-work", { method: "PATCH", body: JSON.stringify({ row_id: task.id, status: todo.name }) });
  check(restOther.status === 404 || restOther.status === 400 || restOther.status === 403, "…but not a row that isn't assigned to it", restOther.status);
  const extraField = await rest("/assigned-work", { method: "PATCH", body: JSON.stringify({ row_id: task2.id, agent_id: tokenAgent.agent.id }) });
  check(extraField.status === 400, "…and the body takes no agent id: the token is the proof", extraField.status);
  // Pausing the agent ends its token's use everywhere, not just on its own route.
  await agents.updateAgent(personId, tokenAgent.agent.id, { enabled: false });
  const pausedWork = await rest("/assigned-work");
  const pausedOther = await rest("/workspaces");
  check(pausedWork.status === 401 && pausedOther.status === 401, "a paused agent's token is refused on every route", [pausedWork.status, pausedOther.status]);
  await agents.updateAgent(personId, tokenAgent.agent.id, { enabled: true });
  check((await rest("/workspaces")).status === 200, "…and works again when the agent is resumed");

  // The agent's own page: rendered for the person, and no chat to open.
  const pageRes = await fetch(`${BASE}/w/${wsId}/agents/${tokenAgent.agent.id}/settings`, { headers: { cookie: jar.header() } });
  const pageHtml = await pageRes.text();
  check(pageRes.status === 200 && pageHtml.includes("Script agent"), "the agent's page renders its name", pageRes.status);
  const chatRes = await fetch(`${BASE}/w/${wsId}/agents/${tokenAgent.agent.id}`, { headers: { cookie: jar.header() }, redirect: "manual" });
  check(chatRes.status >= 300 && chatRes.status < 400 && (chatRes.headers.get("location") ?? "").includes("/settings"), "…and its chat address leads there", chatRes.status);

  const noToken = await fetch(`${apiBase}/assigned-work`);
  check(noToken.status === 401, "the REST route needs a token");
  await external.bindExternalAgent(personId, tokenAgent.agent.id, { kind: "token" });
  const afterRotate = await rest("/assigned-work");
  check(afterRotate.status === 401 || afterRotate.status === 404, "a new token revokes the old one", afterRotate.status);
}

try {
  await main();
} finally {
  await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
  await db.delete(user).where(inArray(user.id, [...userIds, ...extraUserIds]));
  await db.delete(oauthClient).where(inArray(oauthClient.clientId, [...Object.values(clients), ...extraClientIds]));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
