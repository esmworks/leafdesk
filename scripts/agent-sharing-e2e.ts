/**
 * End-to-end check of sharing agents (lib/agent-sharing.ts) against the database: who may create
 * agents under each "Who can create agents" setting, and what a new agent's list starts with; what
 * each level allows and refuses (full access shares and archives, can edit changes the agent but
 * not who it is shared with, can view and interact sees it read-only, its own runs alone, chats
 * read-only and mentions it); the monthly token limit and connections' tools stay with owners;
 * workspace owners always have full access; a person's own entry beats their groups', which beat
 * everyone's; narrowing the list takes chat and mentions away; the agents people list and see are
 * those they have access to; guests and people outside the workspace can't be added; every change
 * is in the audit log and none makes a version of the agent. Creates its own users and workspace
 * and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-sharing-e2e.ts
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
const { agentRun, agentShare, auditEvent, connection, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { seal } = await import("@/server/secret-box");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { createRows } = await import("@/server/databases");
const { requestAgentRun } = await import("@/server/agents/requests");
const { changeComments } = await import("@/server/comments");
const { commentMentionCandidates } = await import("@/server/mentions");
const { createGroup } = await import("@/server/groups");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
const { agentChatLine } = await import("@/lib/agent-chat");
const agents = await import("@/server/agents/manage");
const sharing = await import("@/server/agents/sharing");
const chat = await import("@/server/agents/chat");
const memory = await import("@/server/agents/memory");
const schedules = await import("@/server/agents/schedules");
const versions = await import("@/server/agents/versions");
const { agentGrantSummary, ConnectionError, setAgentGrant } = await import("@/server/connections/manage");
const { flushAgentRuns } = await import("@/server/agents/run");

const RUN = `agent-sharing-e2e-${Date.now().toString(36)}`;

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

/** The error's code when the promise fails (`access` for an AccessError), null when it doesn't. */
async function refusal(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof agents.AgentError) return error.code;
    if (error instanceof chat.AgentChatRefusal) return `chat:${error.code}`;
    if (error instanceof ConnectionError) return `connection:${error.code}`;
    if (error instanceof AccessError) return "access";
    return `other: ${error instanceof Error ? error.message : String(error)}`;
  }
}

type Mentioned = { userId: string; name: string };
/** A comment body as the comment box sends it: text with people and agents mentioned. */
const body = (...parts: (string | Mentioned)[]) => [
  {
    type: "paragraph",
    content: parts.map((p) => (typeof p === "string" ? { type: "text", text: p, styles: {} } : { type: "mention", props: { kind: "user", id: `m-${p.userId}`, userId: p.userId, name: p.name } })),
  },
];

const ids = {
  owner: `${RUN}-owner`,
  coOwner: `${RUN}-coowner`,
  editor: `${RUN}-editor`,
  viewer: `${RUN}-viewer`,
  grouped: `${RUN}-grouped`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const toolNames = (request: FakeChatRequest | undefined) => (request?.tools ?? []).map((t) => t.function.name);
const levelOf = async (userId: string, agentId: string) => sharing.agentLevel(userId, { id: agentId, workspaceId });

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.coOwner, name: "Owner Orhan", email: `${ids.coOwner}@example.test` },
    { id: ids.editor, name: "Editor Ece", email: `${ids.editor}@example.test` },
    { id: ids.viewer, name: "Viewer Veli", email: `${ids.viewer}@example.test` },
    { id: ids.grouped, name: "Grouped Gizem", email: `${ids.grouped}@example.test` },
    { id: ids.guest, name: "Guest Gül", email: `${ids.guest}@example.test` },
    { id: ids.outsider, name: "Outsider Oğuz", email: `${ids.outsider}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.coOwner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
    { workspaceId, userId: ids.grouped, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));

  // ── Who creates agents ──────────────────────────────────────────────────────────────────────
  check(!(await sharing.canCreateAgents(ids.editor, workspaceId)), "by default, members don't create agents");
  check((await refusal(agents.createAgent(ids.editor, workspaceId, { name: "Mine" }))) === "access", "…and creating one is refused");
  check((await refusal(agents.createAgent(ids.guest, workspaceId, { name: "Mine" }))) === "access", "…as it is for guests");

  const helper = await agents.createAgent(ids.owner, workspaceId, { name: "Helper", instructions: "Answer from the handbook.", monthlyTokenLimit: 100_000 });
  check(helper.access === "full", "an owner creates one, with full access");
  const startList = await sharing.agentSharing(ids.owner, helper.id);
  check(
    startList.entries.length === 2 &&
      startList.entries.some((e) => e.kind === "everyone" && e.level === "interact") &&
      startList.entries.some((e) => e.kind === "person" && e.userId === ids.owner && e.level === "full"),
    "a new agent is shared with everyone to view and interact, and with whoever made it at full access",
    startList.entries,
  );
  check(
    startList.members.some((m) => m.userId === ids.editor) && !startList.members.some((m) => m.userId === ids.guest),
    "full access lists the people it may be shared with: owners and members, not guests",
    startList.members,
  );
  const versionsBefore = (await versions.listAgentVersions(ids.owner, helper.id)).length;

  // ── Everyone at view & interact ─────────────────────────────────────────────────────────────
  const listed = await agents.listAgents(ids.viewer, workspaceId);
  check(listed.length === 1 && listed[0].access === "interact" && listed[0].instructions.length > 0, "members list it, at view & interact, instructions included", listed);
  check((await agents.getAgent(ids.viewer, helper.id)).access === "interact", "…and open it");
  const seen = await sharing.agentSharing(ids.viewer, helper.id);
  check(seen.level === "interact" && seen.entries.length === 2 && seen.members.length === 0, "they see who it is shared with, not whom it could be", seen);
  check((await refusal(agents.updateAgent(ids.viewer, helper.id, { instructions: "Leak" }))) === "notAllowed", "view & interact doesn't change its instructions");
  check((await refusal(agents.setAgentAccess(ids.viewer, helper.id, general.id, "view"))) === "notAllowed", "…share pages with it");
  check((await refusal(memory.addAgentMemory(ids.viewer, helper.id, "Remember me"))) === "notAllowed", "…write its memory");
  check(
    (await refusal(sharing.setAgentShare(ids.viewer, helper.id, { kind: "person", userId: ids.viewer }, "full"))) === "notAllowed",
    "…or share it (with themselves included)",
  );
  check((await refusal(agents.archiveAgent(ids.viewer, helper.id))) === "notAllowed", "…or archive it");
  check((await memory.listAgentMemory(ids.viewer, helper.id)).length === 0 && (await schedules.listAgentSchedules(ids.viewer, helper.id)).length === 0, "…but sees its memory and schedules");
  check((await refusal(agents.listAgents(ids.guest, workspaceId))) === "access", "guests list no agents");
  check((await refusal(agents.getAgent(ids.outsider, helper.id))) === "notFound", "people outside the workspace don't find it");

  // ── Can edit ────────────────────────────────────────────────────────────────────────────────
  await sharing.setAgentShare(ids.owner, helper.id, { kind: "person", userId: ids.editor }, "edit");
  check((await levelOf(ids.editor, helper.id)) === "edit", "an owner gives a member edit access");
  const edited = await agents.updateAgent(ids.editor, helper.id, { instructions: "Answer from the handbook, briefly." });
  check(edited.instructions === "Answer from the handbook, briefly." && edited.access === "edit", "who can edit it changes its instructions", edited);
  await memory.addAgentMemory(ids.editor, helper.id, "Keep answers short");
  check((await memory.listAgentMemory(ids.editor, helper.id)).length === 1, "…and its memory");
  check((await refusal(agents.updateAgent(ids.editor, helper.id, { monthlyTokenLimit: 5 }))) === "ownersOnly", "…not its monthly token limit");
  check((await agents.updateAgent(ids.editor, helper.id, { monthlyTokenLimit: 100_000, name: "Helper" })).monthlyTokenLimit === 100_000, "…though saving the limit as it is goes through");
  check(
    (await refusal(sharing.setAgentShare(ids.editor, helper.id, { kind: "person", userId: ids.viewer }, "edit"))) === "notAllowed",
    "can edit doesn't share it",
  );
  check((await refusal(agents.archiveAgent(ids.editor, helper.id))) === "notAllowed", "…or archive it");
  check(
    (await refusal(setAgentGrant(ids.editor, helper.id, "no-connection", ["x"]))) === "connection:notFound",
    "…or choose its connections' tools, which stay with owners (the agent isn't found there for them)",
  );
  check(Array.isArray(await agentGrantSummary(ids.viewer, helper.id)), "anyone it is shared with sees which connections' tools it may use");
  const hidden = await agents.createAgent(ids.owner, workspaceId, { name: "Owners' auditor" });
  await sharing.removeAgentShare(ids.owner, hidden.id, { kind: "everyone" });
  check(
    (await refusal(agents.updateAgent(ids.editor, helper.id, { helperAgentIds: [hidden.id] }))) === "invalid",
    "…nor let it ask an agent they have no access to",
  );
  await agents.updateAgent(ids.owner, helper.id, { monthlyTokenLimit: 200_000 });
  // A version whose token limit differs from the one now.
  let otherLimit: number | null = null;
  for (const v of await versions.listAgentVersions(ids.owner, helper.id)) {
    const detail = await versions.getAgentVersion(ids.owner, helper.id, v.number);
    if (detail.settings.some((f) => f.field === "monthly_token_limit")) {
      otherLimit = v.number;
      break;
    }
  }
  check(otherLimit !== null, "(an earlier version had another token limit)");
  const restored = await versions.restoreAgentVersion(ids.editor, helper.id, otherLimit);
  check(
    (await agents.getAgent(ids.owner, helper.id)).monthlyTokenLimit === 200_000 &&
      restored.skipped.some((x) => x.part === "setting" && x.name === "monthly_token_limit" && x.reason === "noAccess"),
    "restoring a version, an editor leaves the token limit as it is (and is told so)",
    restored.skipped,
  );

  // ── Chat, by level ──────────────────────────────────────────────────────────────────────────
  const handbook = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: general.id, title: "Handbook", markdown: "Lunch is at noon." });
  await agents.setAgentAccess(ids.owner, helper.id, handbook.id, "view");
  const chatId = crypto.randomUUID();
  const chatPage = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: general.id, title: "Ask", markdown: `${agentChatLine(helper.id, chatId)}\n` });
  const place = { chatId, pageId: chatPage.id };
  check((await chat.agentChatInfo(ids.editor, workspaceId, helper.id, null)).state === "full", "who can edit it chats in its dialog with its full tools");
  check((await chat.agentChatInfo(ids.viewer, workspaceId, helper.id, null)).state === "readOnly", "view & interact chats in the dialog, read-only");
  check((await chat.agentChatInfo(ids.viewer, workspaceId, helper.id, place)).state === "readOnly", "…and in a page's block");
  // A connection's writing tool: each call waits for an owner the run is for.
  const [conn] = await db
    .insert(connection)
    .values({
      workspaceId,
      name: "Notes",
      slug: "notes",
      url: "https://notes.example.test/mcp",
      authType: "none",
      status: "ready",
      tools: [{ name: "send_note", title: null, description: "Sends a note", inputSchema: { type: "object", properties: {} }, hinted: "write", kind: "write" }],
      eventSecret: seal(`${RUN}-secret`),
      createdBy: ids.owner,
    })
    .returning();
  await setAgentGrant(ids.owner, helper.id, conn.id, ["send_note"]);
  const writeTools = ["create_row", "update_row", "create_page", "edit_page"];
  fake.setChat(() => ({ text: "Lunch is at noon." }));
  fake.chats.length = 0;
  const asked = await chat.sendAgentChat(ids.viewer, { workspaceId, agentId: helper.id, place: null, conversationId: null, message: "When is lunch?" });
  await flushAgentRuns();
  const [viewerRun] = await db.select().from(agentRun).where(eq(agentRun.id, asked.runId));
  const viewerTools = toolNames(fake.chats[0]);
  check(viewerRun?.status === "done" && !writeTools.some((n) => viewerTools.includes(n)), "a viewer's chat answers, with reading tools only", { status: viewerRun?.status, viewerTools });
  fake.setChat(() => ({ text: "Done." }));
  fake.chats.length = 0;
  const editorAsked = await chat.sendAgentChat(ids.editor, { workspaceId, agentId: helper.id, place: null, conversationId: null, message: "Tidy the handbook." });
  await flushAgentRuns();
  const editorTools = toolNames(fake.chats[0]);
  check(writeTools.every((n) => editorTools.includes(n)), "…an editor's is offered the tools that change pages", editorTools);
  check(!editorTools.includes("notes__send_note"), "…but not a connection's writing tool, which only an owner could approve", editorTools);
  fake.chats.length = 0;
  await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: null, message: "Tidy the handbook." });
  await flushAgentRuns();
  check(toolNames(fake.chats[0]).includes("notes__send_note"), "an owner's chat is offered it", toolNames(fake.chats[0]));
  const tasks = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: general.id, kind: "database", title: "Tasks" });
  await agents.setAgentAccess(ids.owner, helper.id, tasks.id, "edit");
  const [task] = await createRows(ids.owner, tasks.id, [{ title: "Order lunch" }]);
  fake.chats.length = 0;
  await requestAgentRun(ids.editor, helper.id, { task: "Do it", rowId: task.id, via: "mcp" });
  await flushAgentRuns();
  check(fake.chats.length > 0 && !toolNames(fake.chats[0]).includes("notes__send_note"), "nor is an editor's run asked for on a row, which no owner answers for", toolNames(fake.chats[0]));
  const viewerRuns = await agents.listAgentRuns(ids.viewer, helper.id);
  check(viewerRuns.length === 1 && viewerRuns[0].id === asked.runId, "view & interact lists its own runs alone", viewerRuns.map((r) => r.id));
  check((await refusal(agents.getAgentRun(ids.viewer, helper.id, editorAsked.runId))) === "notFound", "…and doesn't open someone else's");
  check((await agents.listAgentRuns(ids.editor, helper.id)).length >= 2, "can edit lists the agent's runs");

  // ── Mentions, by level ──────────────────────────────────────────────────────────────────────
  await agents.setAgentAccess(ids.owner, helper.id, handbook.id, "comment");
  const asMention = { userId: helper.userId, name: helper.name };
  check((await commentMentionCandidates(ids.viewer, handbook.id, "")).agents.some((a) => a.id === helper.userId), "view & interact may mention it");

  // ── Narrowing the list ──────────────────────────────────────────────────────────────────────
  await sharing.removeAgentShare(ids.owner, helper.id, { kind: "everyone" });
  check((await levelOf(ids.viewer, helper.id)) === "none", "taking everyone off leaves the others no access");
  check(!(await agents.listAgents(ids.viewer, workspaceId)).some((a) => a.id === helper.id), "…it drops out of their list");
  check((await refusal(agents.getAgent(ids.viewer, helper.id))) === "notFound", "…they don't find it");
  check((await chat.agentChatInfo(ids.viewer, workspaceId, helper.id, place)).state === "noAccess", "…the page's chat says they have no access");
  check((await refusal(chat.sendAgentChat(ids.viewer, { workspaceId, agentId: helper.id, place, conversationId: null, message: "Hi" }))) === "chat:noAccess", "…and takes no message");
  check(!(await commentMentionCandidates(ids.viewer, handbook.id, "")).agents.some((a) => a.id === helper.userId), "…the @ menu leaves it out");
  const mentioned = await changeComments(ids.viewer, handbook.id, { type: "createThread", body: body(asMention, " when is lunch?") });
  const mentionRuns = (await db.select().from(agentRun).where(eq(agentRun.agentId, helper.id))).filter((r) => r.source.kind === "mention");
  check(
    mentioned.comment && !mentionRuns.some((r) => r.source.kind === "mention" && r.source.commentId === mentioned.comment!.id),
    "…and mentioning it anyway starts no run",
    mentionRuns.map((r) => r.source),
  );
  check((await chat.agentChatInfo(ids.editor, workspaceId, helper.id, place)).state === "full", "the editor, listed on their own, keeps it");
  check((await chat.chatAgents(ids.viewer, workspaceId)).every((a) => a.id !== helper.id), "the block's agent picker leaves it out for those without access");

  // ── Groups, and whose entry decides ─────────────────────────────────────────────────────────
  const group = await createGroup(ids.owner, workspaceId, "Support", [ids.grouped, ids.viewer]);
  await sharing.setAgentShare(ids.owner, helper.id, { kind: "group", groupId: group.id }, "edit");
  check((await levelOf(ids.grouped, helper.id)) === "edit", "sharing with a group gives its members its level");
  await sharing.setAgentShare(ids.owner, helper.id, { kind: "person", userId: ids.viewer }, "interact");
  check((await levelOf(ids.viewer, helper.id)) === "interact", "a person's own entry decides for them, even below their group's");
  await sharing.setAgentShare(ids.owner, helper.id, { kind: "everyone" }, "full");
  check((await levelOf(ids.grouped, helper.id)) === "edit", "…and a group's entry beats everyone's");
  await sharing.removeAgentShare(ids.owner, helper.id, { kind: "everyone" });

  // ── Owners always, guests and outsiders never ───────────────────────────────────────────────
  check((await levelOf(ids.coOwner, helper.id)) === "full", "another owner, on no list, has full access");
  await sharing.setAgentShare(ids.owner, helper.id, { kind: "person", userId: ids.coOwner }, "interact");
  check((await levelOf(ids.coOwner, helper.id)) === "full", "…and keeps it whatever their entry says");
  check(
    (await refusal(sharing.setAgentShare(ids.owner, helper.id, { kind: "person", userId: ids.guest }, "interact"))) === "notAMember",
    "an agent isn't shared with a guest",
  );
  check(
    (await refusal(sharing.setAgentShare(ids.owner, helper.id, { kind: "person", userId: ids.outsider }, "interact"))) === "notAMember",
    "…or with someone outside the workspace",
  );
  check(
    (await refusal(sharing.setAgentShare(ids.owner, helper.id, { kind: "group", groupId: "no-such-group" }, "interact"))) === "notAMember",
    "…or with a group of another workspace",
  );
  check(
    (await refusal(sharing.setAgentShare(ids.owner, helper.id, { kind: "everyone" }, "owner" as never))) === "invalid",
    "a level is full, edit or interact",
  );

  // ── Full access, given ──────────────────────────────────────────────────────────────────────
  await sharing.setAgentShare(ids.owner, helper.id, { kind: "person", userId: ids.editor }, "full");
  await sharing.setAgentShare(ids.editor, helper.id, { kind: "person", userId: ids.grouped }, "interact");
  check((await levelOf(ids.grouped, helper.id)) === "interact", "a member with full access shares it");
  await agents.archiveAgent(ids.editor, helper.id);
  await agents.restoreAgent(ids.editor, helper.id);
  check(!(await agents.getAgent(ids.editor, helper.id)).archived, "…archives and restores it");
  check((await refusal(agents.updateAgent(ids.editor, helper.id, { monthlyTokenLimit: null }))) === "ownersOnly", "…but its token limit still stays with owners");

  // ── Members creating agents ─────────────────────────────────────────────────────────────────
  await updateWorkspaceSettings(ids.owner, workspaceId, { agentCreation: "members" });
  check(await sharing.canCreateAgents(ids.viewer, workspaceId), "once owners let members create agents, they can");
  check((await refusal(agents.createAgent(ids.viewer, workspaceId, { name: "Costly", monthlyTokenLimit: 10 }))) === "ownersOnly", "…without setting a token limit");
  const mine = await agents.createAgent(ids.viewer, workspaceId, { name: "Veli's notes", instructions: "Summarize." });
  check(mine.access === "full", "the member who creates one gets full access to it");
  const mineList = await sharing.agentSharing(ids.viewer, mine.id);
  check(
    mineList.entries.some((e) => e.kind === "everyone" && e.level === "interact") && mineList.entries.some((e) => e.kind === "person" && e.userId === ids.viewer && e.level === "full"),
    "…and it starts shared with everyone to view and interact",
    mineList.entries,
  );
  await sharing.removeAgentShare(ids.viewer, mine.id, { kind: "everyone" });
  check((await levelOf(ids.grouped, mine.id)) === "none" && (await levelOf(ids.owner, mine.id)) === "full", "they keep it to themselves, and owners still have it");
  check((await refusal(agents.createAgent(ids.guest, workspaceId, { name: "Guest's" }))) === "access", "guests still can't create agents");
  await updateWorkspaceSettings(ids.owner, workspaceId, { agentCreation: "owners" });
  check((await refusal(agents.createAgent(ids.viewer, workspaceId, { name: "Another" }))) === "access", "back to owners only, members can't create another");
  check((await agents.updateAgent(ids.viewer, mine.id, { description: "Mine still" })).description === "Mine still", "…but keep the access they have to the ones they made");
  check((await refusal(updateWorkspaceSettings(ids.editor, workspaceId, { agentCreation: "members" }))) !== null, "only owners change the setting");

  // ── The audit log, and versions ─────────────────────────────────────────────────────────────
  const events = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), inArray(auditEvent.action, ["agent.shared", "agent.unshared"])));
  const shared = events.filter((e) => e.action === "agent.shared");
  const unshared = events.filter((e) => e.action === "agent.unshared");
  check(
    shared.some((e) => e.details.subjectType === "user" && e.details.subjectId === ids.editor && e.details.level === "edit" && e.details.previous === null) &&
      shared.some((e) => e.details.subjectType === "group" && e.details.subject === "Support") &&
      shared.some((e) => e.details.subjectType === "user" && e.details.subjectId === ids.editor && e.details.level === "full" && e.details.previous === "edit") &&
      shared.some((e) => e.actorUserId === ids.editor && e.details.subjectId === ids.grouped),
    "every change to who it is shared with is in the audit log, with whom, the level and the one before",
    shared.map((e) => ({ actor: e.actorUserId, details: e.details })),
  );
  check(
    unshared.filter((e) => e.targetLabel === "Helper").length === 2 && unshared.every((e) => e.details.subjectType === "everyone"),
    "…and so is taking someone off",
    unshared.map((e) => e.details),
  );
  check(
    events.every((e) => e.targetLabel !== ""),
    "…naming the agent",
  );
  const versionsNow = (await versions.listAgentVersions(ids.owner, helper.id)).length;
  await sharing.setAgentShare(ids.owner, helper.id, { kind: "everyone" }, "interact");
  await sharing.removeAgentShare(ids.owner, helper.id, { kind: "person", userId: ids.grouped });
  const versionsAfter = await versions.listAgentVersions(ids.owner, helper.id);
  check(versionsNow > versionsBefore && versionsAfter.length === versionsNow, "versions keep the agent's setup, never who it is shared with: sharing it makes none");
  const [stillListed] = await db.select().from(agentShare).where(and(eq(agentShare.agentId, helper.id), eq(agentShare.userId, ids.editor)));
  check(stillListed?.level === "full", "(the list itself lives apart, in agent_share)");

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(agentRun).where(eq(agentRun.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...userIds, ...botUsers]));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
