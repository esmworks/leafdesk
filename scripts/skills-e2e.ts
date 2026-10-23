/**
 * End-to-end check of skills against the database: who may mark a page or row as a skill and what
 * can't be one (databases, templates, pages in the trash); the library listing only what each
 * person can open (private pages, guests, other workspaces, the trash); names unique across the
 * person's workspaces; MCP tools and prompts over the protocol (an in-memory transport, the real
 * server), held to the workspace's connected-apps setting; and the AI chat following a picked
 * skill, with a fake OpenAI-compatible server, refusing skills the person can't use.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/skills-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
type JSONRPCMessage = import("@modelcontextprotocol/server").JSONRPCMessage;
const { db } = await import("@/db");
const { page, teamspace, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage, movePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { getProperties, updateRowProperties } = await import("@/server/databases");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");
const { runAsConnectedApp } = await import("@/server/connected-app");
const skills = await import("@/server/skills");
const ops = await import("@/server/operations");
const { createMcpServer } = await import("@/server/mcp/tools");
const { isAiError } = await import("@/server/ai");
const { resetAi, setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
const { getConversation, MAX_CHAT_SKILL, startChat } = await import("@/server/ai-chat");
const { builtinSkill, builtinSkills } = await import("@/lib/builtin-skills");
type ChatInput = import("@/server/ai-chat").ChatInput;

const RUN = `skills-e2e-${Date.now().toString(36)}`;

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

/** The error `fn` throws: a SkillError's code, "access", an AI error's code, or null. */
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof skills.SkillError) return error.code;
    if (error instanceof AccessError) return "access";
    if (isAiError(error)) return error.code;
    return `other: ${String(error)}`;
  }
}

/** MCP requests to the real server for `userId`, as a connected app, over an in-memory transport. */
async function mcp(userId: string, requests: { method: string; params?: Record<string, unknown> }[], scopes = ["pages:read", "pages:write"]) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: JSONRPCMessage[] = [];
  client.onmessage = (m) => void inbox.push(m);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 1000; i++) {
      const hit = inbox.find((m) => "id" in m && m.id === id);
      if (hit) return hit as { result?: Record<string, unknown>; error?: { code: number; message: string } };
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no response for ${id}`);
  };
  const send = (message: JSONRPCMessage) => runAsConnectedApp({ userId }, () => client.send(message));
  await send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "skills-e2e", version: "1" } } });
  const init = await waitFor(0);
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const out = [];
  for (const [i, r] of requests.entries()) {
    await send({ jsonrpc: "2.0", id: i + 1, method: r.method, params: r.params ?? {} });
    out.push(await waitFor(i + 1));
  }
  await server.close();
  return { init, out };
}

/** A tool's JSON result (or its error text) from an MCP response. */
function toolResult(response: { result?: Record<string, unknown> }) {
  const result = response.result as { isError?: boolean; content: { text: string }[] };
  return { isError: Boolean(result.isError), text: result.content[0].text, data: result.isError ? null : JSON.parse(result.content[0].text) };
}

const ids = { owner: `${RUN}-owner`, alice: `${RUN}-alice`, bob: `${RUN}-bob`, guest: `${RUN}-guest`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const { owner, alice, bob, guest, outsider } = ids;
const workspaceId = `${RUN}-ws`;
const otherWs = `${RUN}-ws2`;
const ctx = (userId: string): import("@/server/operations").OperationContext => ({ userId, actor: { userId } });

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: `${RUN} team` },
    { id: otherWs, name: `${RUN} side` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: bob, role: "member" },
    { workspaceId, userId: guest, role: "guest" },
    { workspaceId: otherWs, userId: alice, role: "owner" },
    { workspaceId: otherWs, userId: outsider, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const as = (userId: string) => ({ userId });

  const handbook = await createPage(as(owner), { workspaceId, teamspaceId: general.id, title: "Handbook", markdown: "The team handbook." });
  const review = await createPage(as(owner), {
    workspaceId,
    teamspaceId: general.id,
    title: "Review checklist",
    markdown: `Check the tests first.\n\nThen read [the handbook](/w/${workspaceId}/p/${handbook.id}).`,
  });
  const diary = await createPage(as(owner), { workspaceId, teamspaceId: null, title: "Owner notes", markdown: "Write like the owner." });
  const tasks = await createPage(as(owner), { workspaceId, teamspaceId: general.id, title: "Playbooks", kind: "database" });
  const triage = await createPage(as(owner), { workspaceId, parentId: tasks.id, title: "Triage a bug", markdown: "Label it, then assign it." });
  const template = await createPage(as(owner), { workspaceId, title: "Meeting template", template: true, markdown: "Agenda" });
  const sideReview = await createPage(as(alice), { workspaceId: otherWs, title: "Review checklist", markdown: "The side project's own review." });
  const theirs = await createPage(as(outsider), { workspaceId: otherWs, teamspaceId: null, title: "Outsider notes", markdown: "SECRET-OUTSIDER" });

  // ── Marking skills ──────────────────────────────────────────────────────────────────────────
  await skills.setSkill(alice, review.id, { skill: true, description: "  How we review pull requests.  " });
  const [stored] = await db.select({ isSkill: page.isSkill, description: page.skillDescription }).from(page).where(eq(page.id, review.id));
  check(stored.isSkill && stored.description === "How we review pull requests.", "a member who may edit a page makes it a skill, its description trimmed", stored);
  await setPagePermission(owner, handbook.id, guest, "view");
  check((await refusal(() => skills.setSkill(guest, handbook.id, { skill: true }))) === "access", "someone who may only view the page can't make it a skill");
  check((await refusal(() => skills.setSkill(owner, tasks.id, { skill: true }))) === "notAPage", "a database can't be a skill");
  check((await refusal(() => skills.setSkill(owner, template.id, { skill: true }))) === "template", "nor can a template");
  check(
    (await refusal(() => skills.setSkill(owner, review.id, { description: "x".repeat(skills.MAX_SKILL_DESCRIPTION + 1) }))) === "tooLong",
    `a description has at most ${skills.MAX_SKILL_DESCRIPTION} characters`,
  );
  await skills.setSkill(owner, triage.id, { skill: true });
  await skills.setSkill(owner, diary.id, { skill: true, description: "Private voice." });
  await skills.setSkill(alice, sideReview.id, { skill: true });
  await skills.setSkill(outsider, theirs.id, { skill: true });

  // ── The library ─────────────────────────────────────────────────────────────────────────────
  const ownerList = await skills.listSkills(owner, workspaceId);
  check(
    ownerList.map((s) => s.title).join("|") === "Owner notes|Review checklist|Triage a bug",
    "the library lists the workspace's skills by title",
    ownerList.map((s) => s.title),
  );
  const triageSkill = ownerList.find((s) => s.id === triage.id);
  check(
    triageSkill?.database?.id === tasks.id && triageSkill.database.title === "Playbooks" && !triageSkill.described && triageSkill.description === "Label it, then assign it.",
    "a row skill names its database, and without a description shows the start of its body",
    triageSkill,
  );
  const aliceList = await skills.listSkills(alice, workspaceId);
  check(!aliceList.some((s) => s.id === diary.id) && aliceList.length === 2, "a private page's skill is only listed for whoever can open it", aliceList.map((s) => s.title));
  check((await skills.listSkills(guest, workspaceId)).length === 0, "a guest sees no skills that aren't shared with them");
  await setPagePermission(owner, review.id, guest, "view");
  check((await skills.listSkills(guest, workspaceId)).map((s) => s.id).join() === review.id, "…and the ones shared with them");
  check((await refusal(() => skills.listSkills(outsider, workspaceId))) === "access", "someone outside the workspace can't list its skills");
  await archivePage(owner, diary.id);
  check(!(await skills.listSkills(owner, workspaceId)).some((s) => s.id === diary.id), "a skill in the trash leaves the library");
  check((await refusal(() => skills.setSkill(owner, diary.id, { description: "Back" }))) === "inTrash", "…and can't be changed until it is restored");

  // ── Names and content ───────────────────────────────────────────────────────────────────────
  const named = await skills.namedSkills(alice);
  const byId = new Map(named.map((s) => [s.id, s]));
  check(
    byId.get(review.id)?.name === "review-checklist" && byId.get(sideReview.id)?.name === "review-checklist-2" && byId.get(triage.id)?.name === "triage-a-bug",
    "every skill gets a name unique across the person's workspaces, the older one keeping the plain name",
    named.map((s) => [s.title, s.name, s.workspaceName]),
  );
  check(!named.some((s) => s.id === theirs.id), "a skill in a shared workspace the person can't open isn't named for them");
  const content = await skills.getSkillContent(alice, review.id);
  check(
    content.body.includes("Check the tests first.") && content.body.includes(`[Handbook](/w/${workspaceId}/p/${handbook.id})`) && content.description === "How we review pull requests.",
    "a skill's instructions are its body as Markdown, page links named as the reader sees them",
    content,
  );
  check((await refusal(() => skills.getSkillContent(alice, handbook.id))) === "notASkill", "a page that isn't a skill has no instructions to give");

  // ── MCP: operations ─────────────────────────────────────────────────────────────────────────
  const listed = await ops.listSkills(ctx(alice), { workspace_id: workspaceId });
  check(
    listed.skills.length === 2 && listed.skills.every((s) => s.workspace_id === workspaceId) && listed.skills.find((s) => s.page_id === triage.id)?.description_from_body === true,
    "list_skills narrows to a workspace, names each skill's workspace when there are several, and says when a description is taken from the body",
    listed,
  );
  const byName = await ops.getSkill(ctx(alice), { skill: "Review-Checklist-2", offset: 0 });
  check(byName.page_id === sideReview.id && byName.instructions.includes("side project"), "get_skill finds a skill by its name, whatever the case", byName);
  check((await ops.getSkill(ctx(alice), { skill: "Triage a bug", offset: 0 })).page_id === triage.id, "…or by its title");
  const shared = await refusal(() => ops.getSkill(ctx(alice), { skill: "Review checklist", offset: 0 }));
  check(
    shared?.includes("Several skills") && shared.includes("review-checklist,") && shared.includes("review-checklist-2"),
    "…but a title two skills share is refused, with their names to pick from",
    shared,
  );
  const byLink = await ops.getSkill(ctx(alice), { skill: `http://localhost/w/00000000-0000-4000-8000-000000000000/p/${review.id}`, offset: 0 }, { maxChars: 10 });
  check(
    byLink.page_id === review.id && byLink.instructions.length === 10 && byLink.instructions_truncated === true && byLink.note?.includes("offset=10"),
    "…or by its page's link, long instructions read in parts",
    byLink,
  );
  check((await refusal(() => ops.getSkill(ctx(alice), { skill: "no-such-skill", offset: 0 })))?.startsWith("other: ToolInputError"), "an unknown name is an input error the model can fix");
  const page1 = (await ops.getPage(ctx(alice), { page_id: review.id, offset: 0 })) as Record<string, unknown>;
  check(page1.skill === true && page1.skill_description === "How we review pull requests.", "get_page says a page is a skill", page1);

  // ── MCP: tools and prompts on the protocol ──────────────────────────────────────────────────
  const session = await mcp(alice, [
    { method: "prompts/list" },
    { method: "prompts/get", params: { name: "review-checklist", arguments: { input: "PR #12 adds a cache." } } },
    { method: "prompts/get", params: { name: "owner-notes" } },
    { method: "tools/call", params: { name: "list_skills", arguments: {} } },
    { method: "tools/call", params: { name: "set_skill", arguments: { page_id: handbook.id, skill: true, description: "Where the rules are." } } },
    { method: "tools/call", params: { name: "get_skill", arguments: { skill: "handbook" } } },
    { method: "tools/call", params: { name: "set_skill", arguments: { page_id: tasks.id, skill: true } } },
  ]);
  const caps = (session.init.result as { capabilities?: { prompts?: unknown } }).capabilities;
  check(caps?.prompts !== undefined, "the server says it has prompts", session.init.result);
  const prompts = (session.out[0].result as { prompts: { name: string; title: string; description: string; arguments: { name: string; required: boolean }[] }[] }).prompts;
  const reviewPrompt = prompts.find((p) => p.name === "review-checklist");
  check(
    prompts.length === 3 && reviewPrompt?.title === "Review checklist" && reviewPrompt.description === `How we review pull requests. (${RUN} team)` && reviewPrompt.arguments[0]?.name === "input" && !reviewPrompt.arguments[0].required,
    "every skill the person can open is a prompt of its name, its workspace named when they have several, with an optional input",
    prompts,
  );
  const got = session.out[1].result as { description: string; messages: { role: string; content: { type: string; text: string } }[] };
  const promptText = got.messages[0]?.content.text ?? "";
  check(
    got.messages.length === 1 && got.messages[0].role === "user" && promptText.includes("Check the tests first.") && promptText.endsWith("Use it on this:\n\nPR #12 adds a cache.") && promptText.includes(`/w/${workspaceId}/p/${review.id}`),
    "a prompt hands over the skill's instructions and the input as the user's message",
    got,
  );
  check(session.out[2].error?.message.includes("No skill named"), "a skill in the trash is no prompt", session.out[2]);
  check(toolResult(session.out[3]).data.skills.length === 3, "list_skills over the protocol", toolResult(session.out[3]));
  check(!toolResult(session.out[4]).isError && toolResult(session.out[5]).data.description === "Where the rules are.", "set_skill makes a page a skill, which get_skill then reads by name", [toolResult(session.out[4]), toolResult(session.out[5])]);
  check(toolResult(session.out[6]).isError && toolResult(session.out[6]).text.includes("not databases"), "set_skill explains why a database can't be one", toolResult(session.out[6]));
  const readOnly = await mcp(alice, [{ method: "tools/call", params: { name: "set_skill", arguments: { page_id: handbook.id, skill: false } } }], ["pages:read"]);
  check(toolResult(readOnly.out[0]).isError && toolResult(readOnly.out[0]).text.includes("read-only"), "set_skill needs the pages:write permission", toolResult(readOnly.out[0]));

  await updateWorkspaceSettings(alice, otherWs, { connectedApps: "off" });
  const hidden = await mcp(alice, [{ method: "prompts/list" }, { method: "prompts/get", params: { name: "review-checklist-2" } }]);
  const hiddenPrompts = (hidden.out[0].result as { prompts: { name: string }[] }).prompts;
  check(
    !hiddenPrompts.some((p) => p.name.startsWith("review-checklist-")) && hidden.out[1].error !== undefined,
    "skills of a workspace hidden from connected apps are neither listed nor handed out as prompts",
    { hiddenPrompts, error: hidden.out[1] },
  );
  await updateWorkspaceSettings(alice, otherWs, { connectedApps: "read" });
  const readOnlyWs = await mcp(alice, [{ method: "tools/call", params: { name: "set_skill", arguments: { page_id: sideReview.id, skill: false } } }]);
  check(toolResult(readOnlyWs.out[0]).isError, "…and where apps may only read, they can't change a skill", toolResult(readOnlyWs.out[0]));
  await updateWorkspaceSettings(alice, otherWs, { connectedApps: "full" });

  // ── The AI chat ─────────────────────────────────────────────────────────────────────────────
  fake.setChat(() => ({ text: "Run the tests, then read the handbook." }));
  fake.chats.length = 0;
  const ask = async (userId: string, input: ChatInput) => {
    const events = [];
    for await (const event of await startChat(userId, input)) events.push(event);
    return events;
  };
  const events = await ask(alice, { workspaceId, message: "Review PR #12", skillId: review.id });
  const request = fake.chats[0];
  const system = textOf(request.messages[0].content);
  const question = textOf(request.messages.at(-1)?.content ?? "");
  check(
    system.includes('picked the skill "Review checklist"') && question.includes("<skill>\nCheck the tests first.") && question.indexOf("<skill>") < question.indexOf("<question>"),
    "a question asked with a skill goes to the model with its instructions, and the model is told to follow them",
    { system, question },
  );
  const conversation = events.find((e) => e.type === "conversation");
  const kept = conversation?.type === "conversation" ? await getConversation(alice, workspaceId, conversation.id) : null;
  check(kept?.messages[0].skill?.id === review.id && kept.messages[0].skill.title === "Review checklist", "the question keeps the skill it used", kept?.messages[0]);
  check(events.at(-1)?.type === "done", "…and is answered", events.at(-1));
  fake.chats.length = 0;
  await ask(alice, { workspaceId, conversationId: kept.id, message: "And the next one?" });
  check(!textOf(fake.chats[0].messages.at(-1)?.content ?? "").includes("<skill>") && !textOf(fake.chats[0].messages[0].content).includes("picked the skill"), "a skill is picked per question: the next one goes without it");
  check((await refusal(() => startChat(alice, { workspaceId, message: "Hi", skillId: theirs.id }))) === "noAccess", "a skill the person can't open is refused like a missing one");
  check((await refusal(() => startChat(alice, { workspaceId, message: "Hi", skillId: sideReview.id }))) === "noAccess", "…and so is one of another workspace");
  await skills.setSkill(owner, handbook.id, { skill: false });
  check((await refusal(() => startChat(alice, { workspaceId, message: "Hi", skillId: handbook.id }))) === "noAccess", "…and a page that is no longer a skill");
  const long = await createPage(as(owner), { workspaceId, teamspaceId: general.id, title: "Long skill", markdown: "word ".repeat(MAX_CHAT_SKILL / 4) });
  await skills.setSkill(owner, long.id, { skill: true });
  check((await refusal(() => startChat(owner, { workspaceId, message: "Hi", skillId: long.id }))) === "tooLarge", `a skill longer than ${MAX_CHAT_SKILL} characters can't be used in the chat`);


  // ── Built-in skills ─────────────────────────────────────────────────────────────────────────
  const wrapup = await builtinSkill("meeting-wrapup", "tr");
  const fromBuiltin = await skills.createBuiltinSkill(alice, workspaceId, "meeting-wrapup", "tr");
  const builtinContent = await skills.getSkillContent(alice, fromBuiltin.id);
  check(
    builtinContent.title === wrapup.title && builtinContent.description === wrapup.description && builtinContent.body.includes("## Adımlar"),
    "a built-in skill becomes a skill page in the person's language, with its description and instructions",
    builtinContent,
  );
  const [placed] = await db.select({ teamspaceId: page.teamspaceId, icon: page.icon }).from(page).where(eq(page.id, fromBuiltin.id));
  check(
    placed.teamspaceId === null && placed.icon === wrapup.icon && !(await skills.listSkills(bob, workspaceId)).some((s) => s.id === fromBuiltin.id),
    "…private to whoever added it, until they share it",
    placed,
  );
  check((await skills.listSkills(alice, workspaceId)).some((s) => s.id === fromBuiltin.id), "…listed in their library");
  check((await refusal(() => skills.createBuiltinSkill(guest, workspaceId, "proofread"))) === "access", "a guest, who can't add pages at the top, can't add one");
  check(
    (await refusal(() => skills.createBuiltinSkill(owner, workspaceId, "no-such-skill" as never)))?.startsWith("other: Error: Unknown built-in skill"),
    "an unknown built-in skill is refused",
  );

  // ── Skills databases ────────────────────────────────────────────────────────────────────────
  const skillsDbId = fromBuiltin.databaseId;
  const [builtinRow] = await db.select({ parentId: page.parentId }).from(page).where(eq(page.id, fromBuiltin.id));
  check(builtinRow.parentId === skillsDbId, "a new skill is a row of the person's skills database");
  const [skillsDb] = await db
    .select({ kind: page.kind, title: page.title, teamspaceId: page.teamspaceId, isSkillDatabase: page.isSkillDatabase })
    .from(page)
    .where(eq(page.id, skillsDbId));
  check(
    skillsDb.kind === "database" && skillsDb.isSkillDatabase && skillsDb.teamspaceId === null && skillsDb.title === "Beceriler",
    "…made for them when they had none: private, named in their language",
    skillsDb,
  );
  const skillProps = await getProperties(skillsDbId);
  check(
    JSON.stringify(skillProps.map((p) => [p.name, p.type])) ===
      JSON.stringify([["Açıklama", "text"], ["Dosyalar", "files"], ["Etiketler", "multi_select"], ["Oluşturan", "created_by"]]),
    "…with a description, files, tags and who made each skill",
    skillProps.map((p) => [p.name, p.type]),
  );
  const descProp = skillProps[0].id;
  const [builtinValues] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, fromBuiltin.id));
  check(builtinValues.properties[descProp] === wrapup.description, "…the description in its property", builtinValues);
  const second = await skills.createSkill(alice, workspaceId, { title: "Second", description: "For seconds" }, "tr");
  check(second.databaseId === skillsDbId, "the next new skill goes to the same database");
  check((await skills.getSkillContent(alice, second.id)).description === "For seconds", "…with its description");
  check((await skills.findSkillDatabase(alice, workspaceId))?.id === skillsDbId, "the library finds the person's skills database");
  check((await skills.findSkillDatabase(bob, workspaceId)) === null, "…but not someone else's private one");
  const plainRow = await createPage(as(alice), { workspaceId, parentId: skillsDbId, title: "Plain row", properties: { [descProp]: "  Row description " } });
  const plainListed = (await skills.listSkills(alice, workspaceId)).find((s) => s.id === plainRow.id);
  check(plainListed?.described && plainListed.description === "Row description", "a row added to a skills database any other way is a skill too, described by its property", plainListed);
  await updateRowProperties(alice, plainRow.id, { [descProp]: "Changed in the table" });
  check((await skills.getSkillContent(alice, plainRow.id)).description === "Changed in the table", "changing the property changes the description");
  await skills.setSkill(alice, plainRow.id, { description: "Changed on the page" });
  const [plainValues] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, plainRow.id));
  check(
    plainValues.properties[descProp] === "Changed on the page" && (await skills.getSkillContent(alice, plainRow.id)).description === "Changed on the page",
    "…and a description written on the page goes to the property",
    plainValues,
  );
  const loose = await createPage(as(alice), { workspaceId, teamspaceId: null, title: "Loose notes", markdown: "Keep it short." });
  await movePage(alice, loose.id, skillsDbId);
  check((await skills.listSkills(alice, workspaceId)).some((s) => s.id === loose.id), "a page moved into a skills database becomes a skill");
  const marked = await createPage(as(alice), { workspaceId, teamspaceId: null, title: "Quote checklist", markdown: "Ask for the currency." });
  await skills.setSkill(alice, marked.id, { skill: true, description: "Use when preparing a quote" });
  await movePage(alice, marked.id, skillsDbId);
  const [markedValues] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, marked.id));
  check(
    markedValues.properties[descProp] === "Use when preparing a quote" && (await skills.getSkillContent(alice, marked.id)).description === "Use when preparing a quote",
    "…and a skill moved in brings its description into the property",
    markedValues,
  );
  await movePage(alice, loose.id, null, undefined, null);
  check((await skills.listSkills(alice, workspaceId)).some((s) => s.id === loose.id), "…and stays one when moved out");
  const playbooks = await createPage(as(owner), { workspaceId, teamspaceId: general.id, kind: "database", title: "Playbooks" });
  const coldCall = await createPage(as(owner), { workspaceId, parentId: playbooks.id, title: "Cold call", markdown: "Ask about their week." });
  check(!(await skills.listSkills(owner, workspaceId)).some((s) => s.id === coldCall.id), "a row of an ordinary database isn't a skill");
  const objections = await createPage(as(owner), { workspaceId, parentId: playbooks.id, title: "Objections" });
  await skills.setSkill(owner, objections.id, { skill: true, description: "Use when a customer pushes back" });
  check((await refusal(() => skills.setSkillDatabase(guest, playbooks.id, true))) === "access", "a guest can't turn a database into a skills database");
  check((await refusal(() => skills.setSkillDatabase(owner, handbook.id, true))) === "notADatabase", "a page can't be a skills database");
  await skills.setSkillDatabase(owner, playbooks.id, true, "en");
  const playbookProps = await getProperties(playbooks.id);
  const playbookDesc = playbookProps.find((p) => p.name === "Description" && p.type === "text");
  check(playbookDesc, "turning a database into a skills database adds a description property", playbookProps);
  check((await skills.listSkills(owner, workspaceId)).some((s) => s.id === coldCall.id), "…and its rows become skills");
  const [objectionValues] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, objections.id));
  check(
    objectionValues.properties[playbookDesc.id] === "Use when a customer pushes back" &&
      (await skills.getSkillContent(owner, objections.id)).description === "Use when a customer pushes back",
    "…a row that was a skill already keeps its description, now in the property",
    objectionValues,
  );
  await skills.setSkillDatabase(owner, playbooks.id, false);
  await skills.setSkillDatabase(owner, playbooks.id, true, "en");
  check(
    (await getProperties(playbooks.id)).filter((p) => p.name === "Description").length === 1,
    "…once: turned on again, it keeps the same description property",
  );
  await skills.setSkillDatabase(owner, playbooks.id, false);
  check(!(await skills.listSkills(owner, workspaceId)).some((s) => s.id === coldCall.id), "turned back, its rows stop being skills");

  for (const builtin of await builtinSkills("en")) check(builtin.markdown.length < MAX_CHAT_SKILL, `the built-in skill ${builtin.key} fits in the chat`);
  fake.chats.length = 0;
  await ask(alice, { workspaceId, message: "Wrap up the notes", skillId: fromBuiltin.id });
  check(textOf(fake.chats[0]?.messages.at(-1)?.content ?? "").includes("<skill>\n" + wrapup.markdown.split("\n")[0]), "the AI chat follows a built-in skill's instructions like any other");

  console.log(`\n${passed} checks passed`);
} finally {
  resetAi();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWs]));
  await db.delete(user).where(inArray(user.id, userIds));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
