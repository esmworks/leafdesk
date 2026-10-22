/**
 * End-to-end check of semantic search (#43) against the database, with a fake OpenAI-compatible
 * server for embeddings (src/server/ai/fake-openai.ts: a deterministic hashed bag of words that
 * folds a few synonyms, so "automobile" means "car"), reached over HTTP like a real provider:
 * background indexing after pages are created, edited, renamed or a row's values change; only
 * changed chunks embedded again; results by meaning merged with full-text results; rows found by
 * their property values; trashed, restored and deleted pages; the workspace AI switch; a server
 * without an embeddings model (exactly full-text search); another embeddings model; the sweep that
 * backfills pages the index missed; pages indexed with an older chunking; a subtree scope; and
 * access, checked when the query runs: a private page nobody else was given, a private teamspace,
 * a page shared with a group (and taken back), guests seeing only what was shared with them,
 * another workspace, MCP and REST.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/semantic-search-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
import { READ_SCOPES } from "@/lib/api-scopes";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, pageChunk, pageIndexState, teamspace, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE } = await import("@/server/mcp/principal");
const { registerCollab, getCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage, deletePagePermanently, fullTextSearch, movePage, renamePage, restorePage, searchPages } = await import("@/server/pages");
const databases = await import("@/server/databases");
const { removePageGroupPermission, setPageGroupPermission, setPagePermission } = await import("@/server/permissions");
const { createGroup } = await import("@/server/groups");
const { createTeamspace } = await import("@/server/teamspaces");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { handleApiRequest } = await import("@/server/api");
const { createApiToken } = await import("@/server/api/tokens");
const { resetAi, setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, FAKE_DIMENSIONS } = await import("@/server/ai/fake-openai");
const index = await import("@/server/semantic-index");
const { clearQueryCache, semanticSearch } = await import("@/server/semantic-search");
const { CHUNKER_VERSION } = await import("@/server/semantic-text");

const RUN = `semsearch-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();

const EMBEDDINGS = {
  AI_EMBEDDINGS_MODEL: "fake-embed",
  AI_EMBEDDINGS_BASE_URL: fake.baseUrl,
  AI_EMBEDDINGS_API_KEY: "local-test",
  AI_EMBEDDINGS_MIN_SIMILARITY: "0.25",
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
  AI_CONCURRENCY: "4",
};
setAiEnv(EMBEDDINGS);

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

/** Waits for debounced and queued indexing to finish. */
async function settle(timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (index.indexBusy()) {
    if (Date.now() > until) throw new Error("The index did not settle in time");
    await sleep(100);
  }
  await index.whenIndexIdle();
}

const ids = {
  owner: `${RUN}-owner`,
  alice: `${RUN}-alice`,
  bob: `${RUN}-bob`,
  carol: `${RUN}-carol`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const { owner, alice, bob, carol, guest, outsider } = ids;
const workspaceId = `${RUN}-ws`;
const otherWs = `${RUN}-ws2`;

/** Page ids `userId` finds for `query` in the test workspace (hybrid search). */
async function found(userId: string, query: string, options: { withinPageId?: string; workspaceId?: string } = {}) {
  return searchPages(userId, query, { workspaceId: options.workspaceId ?? workspaceId, withinPageId: options.withinPageId });
}
const idsOf = (hits: { id: string }[]) => hits.map((h) => h.id);

async function chunkCount(pageId: string) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(pageChunk).where(eq(pageChunk.pageId, pageId));
  return row.n;
}

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: [READ_SCOPE] });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const hit = inbox.find((m) => m.id === id);
      if (hit) return hit;
      await sleep(5);
    }
    throw new Error(`no MCP response for ${name}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "semantic-search-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

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
    { workspaceId, userId: guest, role: "guest" },
    { workspaceId: otherWs, userId: outsider, role: "owner" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const actor = { userId: owner };

  // ── Indexing ────────────────────────────────────────────────────────────────────────────────
  const fleet = await createPage(actor, { workspaceId, teamspaceId: general.id, title: "Fleet notes", markdown: "Our car needs new tyres before winter." });
  const vendors = await createPage(actor, { workspaceId, parentId: fleet.id, title: "Tyre vendors", markdown: "Vehicle tyre suppliers we trust." });
  const office = await createPage(actor, { workspaceId, teamspaceId: general.id, title: "Office rules", markdown: "Puppies are welcome on Fridays." });
  const handbook = await createPage(actor, {
    workspaceId,
    teamspaceId: general.id,
    title: "Handbook",
    markdown: Array.from({ length: 4 }, (_, i) => `Section ${i} ${"lorem ipsum dolor sit amet ".repeat(22)}`).join("\n\n"),
  });
  // A private page: the owner's alone, shared with nobody.
  const diary = await createPage(actor, { workspaceId, teamspaceId: null, title: "Owner diary", markdown: "I will buy a new automobile." });
  // A private teamspace only the owner is in.
  const secretSpace = await createTeamspace(owner, workspaceId, { name: `${RUN} secret`, access: "private" });
  const roadmap = await createPage(actor, { workspaceId, teamspaceId: secretSpace.id, title: "Hidden roadmap", markdown: "Vehicle roadmap for next year." });
  // A private page shared with a group Bob is in.
  const travel = await createPage(actor, { workspaceId, teamspaceId: null, title: "Travel desk", markdown: "Vacation requests go here." });
  const travellers = await createGroup(owner, workspaceId, "Travellers", [bob]);
  await setPageGroupPermission(owner, travel.id, travellers.id, "view");
  // Shared with the guest by name.
  const guestBook = await createPage(actor, { workspaceId, teamspaceId: general.id, title: "Guest handbook", markdown: "Holiday calendar for guests." });
  await setPagePermission(owner, guestBook.id, guest, "view");
  // A database row found by its values.
  const contacts = await createPage(actor, { workspaceId, teamspaceId: general.id, kind: "database", title: "Contacts" });
  const notes = await databases.addProperty(owner, contacts.id, { name: "Notes", type: "text" });
  const acme = await createPage(actor, { workspaceId, parentId: contacts.id, title: "Acme", properties: { [notes.id]: "Runs hound training classes" } });
  // Another workspace's page.
  const theirs = await createPage({ userId: outsider }, { workspaceId: otherWs, title: "Their car", markdown: "Automobile repairs." });

  const before = fake.embedded.length;
  await settle();
  const indexed = await db.select().from(pageIndexState).where(inArray(pageIndexState.workspaceId, [workspaceId, otherWs]));
  check(indexed.length === 11, "new pages are indexed in the background, a few seconds after they're made", indexed.length);
  check(fake.embedded.length > before, "…their chunks sent to the embeddings endpoint");
  const [fleetChunk] = await db.select().from(pageChunk).where(eq(pageChunk.pageId, fleet.id));
  check(
    fleetChunk.model === "fake-embed" && fleetChunk.dimensions === FAKE_DIMENSIONS && fleetChunk.embedding.length === FAKE_DIMENSIONS,
    "chunks store their model, dimensions and vector",
    { model: fleetChunk.model, dimensions: fleetChunk.dimensions },
  );
  check(fleetChunk.text === "Fleet notes\n\nOur car needs new tyres before winter.", "a chunk is the page title, a blank line and its text", fleetChunk.text);
  const vendorsText = async () => (await db.select({ text: pageChunk.text }).from(pageChunk).where(eq(pageChunk.pageId, vendors.id)))[0]?.text ?? "";
  check((await vendorsText()).startsWith("Fleet notes › Tyre vendors\n\n"), "a subpage's chunk starts with the page above it", await vendorsText());
  check((await chunkCount(handbook.id)) >= 2, "a long page is cut into several chunks");
  const [acmeChunk] = await db.select().from(pageChunk).where(eq(pageChunk.pageId, acme.id));
  check(acmeChunk.text.includes("Notes: Runs hound training classes"), "a row's chunk includes its property values", acmeChunk.text);
  check(acmeChunk.text.startsWith("Contacts › Acme\n\n"), "a row's chunk names its database", acmeChunk.text);

  // ── Search by meaning ───────────────────────────────────────────────────────────────────────
  const auto = await found(alice, "automobile");
  const autoFleet = auto.find((h) => h.id === fleet.id);
  check(autoFleet?.match === "semantic", "a page is found by meaning, without the word (automobile → car)", auto);
  check(autoFleet.snippet.includes("car needs new tyres"), "…with its best passage as the snippet", autoFleet.snippet);
  check(idsOf(auto).includes(vendors.id), "…and its subpage too");
  const tyres = await found(alice, "tyres");
  check(tyres.filter((h) => h.id === fleet.id).length === 1 && tyres.find((h) => h.id === fleet.id)?.match === undefined, "a page found by both is listed once, as a text match");
  const direct = await semanticSearch(alice, "automobile", { workspaceId });
  check(direct.every((h, i) => i === 0 || direct[i - 1].score >= h.score), "semantic hits are ranked by similarity", direct.map((h) => h.score));
  check(direct[0]?.blockId !== undefined && typeof direct[0]?.passage === "string", "…with their passage and block");
  check(idsOf(await found(alice, "dog")).includes(acme.id), "a row is found by its property values (dog → hound)");
  check(idsOf(await found(alice, "puppy")).includes(office.id), "…and pages by their body (puppy → puppies)");
  check((await found(alice, "ca")).every((h) => h.match !== "semantic"), "very short queries only search text");
  const within = await found(owner, "automobile", { withinPageId: fleet.id });
  check(idsOf(within).includes(vendors.id) && !idsOf(within).includes(diary.id), "a search can be kept to a page and its subpages", idsOf(within));

  // ── Access ──────────────────────────────────────────────────────────────────────────────────
  const ownerAuto = idsOf(await found(owner, "automobile"));
  check(ownerAuto.includes(diary.id) && ownerAuto.includes(roadmap.id), "the owner finds their private page and private teamspace by meaning", ownerAuto);
  check(!idsOf(auto).includes(diary.id), "a private page shared with nobody never shows in another member's results");
  check(!idsOf(auto).includes(roadmap.id), "…nor a private teamspace's page");
  check(!idsOf(auto).includes(theirs.id), "…nor another workspace's page");
  check(!idsOf(await searchPages(alice, "automobile")).includes(theirs.id), "…also when searching all their workspaces");
  const bobHoliday = idsOf(await found(bob, "holiday"));
  check(bobHoliday.includes(travel.id), "a page shared with a group is found by its members (holiday → vacation)", bobHoliday);
  check(!idsOf(await found(carol, "holiday")).includes(travel.id), "…not by other members");
  const guestHits = idsOf(await found(guest, "holiday"));
  check(guestHits.includes(guestBook.id), "a guest finds a page shared with them by meaning", guestHits);
  check(idsOf(await found(guest, "automobile")).length === 0, "…and nothing else, though the workspace has matching pages");
  check(idsOf(await searchPages(outsider, "automobile")).every((id) => id === theirs.id), "people in another workspace find only their own pages");
  await removePageGroupPermission(owner, travel.id, travellers.id);
  check(!idsOf(await found(bob, "holiday")).includes(travel.id), "access taken back applies to the next search right away");

  // MCP and REST return the same, with how each result matched.
  const mcp = await callTool(alice, "search", { query: "automobile", workspace_id: workspaceId });
  const mcpIds = mcp.data?.results.map((r: { id: string }) => r.id) ?? [];
  check(
    !mcp.isError && mcp.data.results.find((r: { id: string; match: string }) => r.id === fleet.id)?.match === "semantic",
    "MCP search finds by meaning and says so",
    mcp.text,
  );
  check(!mcpIds.includes(diary.id) && !mcpIds.includes(roadmap.id), "…without pages the person can't open");
  const aliceToken = (await createApiToken(alice, { name: RUN, scopes: READ_SCOPES })).secret;
  const guestToken = (await createApiToken(guest, { name: RUN, scopes: READ_SCOPES })).secret;
  const api = async (token: string, path: string) => {
    const res = await handleApiRequest(new Request(`http://localhost/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }));
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  const rest = await api(aliceToken, `/search?query=automobile&workspace_id=${workspaceId}`);
  const restIds = rest.data?.results?.map((r: { id: string }) => r.id) ?? [];
  check(rest.status === 200 && restIds.includes(fleet.id) && !restIds.includes(diary.id), "REST search finds by meaning, within access", rest);
  check(rest.data.results.every((r: { match: string }) => r.match === "text" || r.match === "semantic"), "…and says how each result matched");
  const restGuest = await api(guestToken, `/search?query=automobile&workspace_id=${workspaceId}`);
  check(restGuest.status === 200 && restGuest.data.results.length === 0, "…a guest's token finds nothing that wasn't shared", restGuest.data);

  // ── Keeping the index current ───────────────────────────────────────────────────────────────
  // Only the changed chunk is embedded again.
  const handbookChunks = await chunkCount(handbook.id);
  const blocks = (await getCollab().readBlocks(handbook.id)).blocks;
  let sent = fake.embedded.length;
  await getCollab().replaceContent(
    handbook.id,
    [...blocks.slice(0, 3).map((_, i) => `Section ${i} ${"lorem ipsum dolor sit amet ".repeat(22)}`), "Section 3 now about the dog kennel."].join("\n\n"),
    actor,
  );
  await settle();
  const reembedded = fake.embedded.slice(sent);
  check(reembedded.length >= 1 && reembedded.length < handbookChunks, "an edit embeds only the chunks whose text changed", {
    reembedded: reembedded.length,
    handbookChunks,
  });
  const handbookTexts = (await db.select({ text: pageChunk.text }).from(pageChunk).where(eq(pageChunk.pageId, handbook.id))).map((c) => c.text);
  check(handbookTexts.some((t) => t.includes("dog kennel")) && !handbookTexts.some((t) => t.includes("Section 3 lorem")), "…the old chunk replaced by the new one", { handbookChunks, handbookTexts });
  sent = fake.embedded.length;
  check((await index.indexPage(handbook.id)) === "unchanged" && fake.embedded.length === sent, "indexing an unchanged page embeds nothing");

  await renamePage(actor, office.id, "Kennel rules");
  await settle();
  const [officeChunk] = await db.select({ text: pageChunk.text }).from(pageChunk).where(eq(pageChunk.pageId, office.id));
  check(officeChunk?.text.startsWith("Kennel rules\n"), "a renamed page is indexed again with its new title", officeChunk);

  // Chunks name the pages above: moving a page or renaming one above it indexes it again.
  const garage = await createPage(actor, { workspaceId, teamspaceId: general.id, title: "Garage", markdown: "Spanners." });
  await settle();
  await movePage(owner, vendors.id, garage.id);
  await settle();
  check((await vendorsText()).startsWith("Garage › Tyre vendors\n\n"), "a moved page is indexed again under its new place", await vendorsText());
  await renamePage(actor, garage.id, "Workshop");
  await settle();
  check((await vendorsText()).startsWith("Workshop › Tyre vendors\n\n"), "renaming a page indexes the pages under it again", await vendorsText());
  const passage = (await searchPages(owner, "tyre suppliers", { workspaceId })).find((h) => h.id === vendors.id)?.passage;
  check(passage === "Vehicle tyre suppliers we trust.", "…and results show the passage without the pages above", passage);
  await movePage(owner, vendors.id, fleet.id);
  await settle();
  check((await vendorsText()).startsWith("Fleet notes › Tyre vendors\n\n"), "…moved back, under its old place again", await vendorsText());

  await databases.updateRowProperties(owner, acme.id, { [notes.id]: "Sells automobile parts" });
  await settle();
  check(idsOf(await found(alice, "vehicle")).includes(acme.id), "a row is indexed again when its values change");
  check(!idsOf(await found(alice, "dog")).includes(acme.id), "…and no longer found by its old values");

  // Trash, restore, delete.
  await archivePage(owner, fleet.id);
  const trashed = idsOf(await found(owner, "automobile"));
  check(!trashed.includes(fleet.id) && !trashed.includes(vendors.id), "trashed pages (and their subpages) drop out of results at once", trashed);
  check((await chunkCount(fleet.id)) > 0, "…their chunks kept for when they come back");
  await restorePage(owner, fleet.id);
  check(idsOf(await found(owner, "automobile")).includes(fleet.id), "a restored page is found again");
  await settle();
  const doomed = await createPage(actor, { workspaceId, teamspaceId: general.id, title: "Scrap cars", markdown: "Old automobiles to scrap." });
  await settle();
  check((await chunkCount(doomed.id)) > 0, "sanity: the page to delete is indexed");
  await archivePage(owner, doomed.id);
  await deletePagePermanently(owner, doomed.id);
  check((await chunkCount(doomed.id)) === 0, "a page deleted for good takes its chunks with it");
  const [doomedState] = await db.select().from(pageIndexState).where(eq(pageIndexState.pageId, doomed.id));
  check(!doomedState, "…and its index state");

  // Backfill: a page the index never heard of is picked up by the sweep.
  const [missed] = await db
    .insert(page)
    .values({ workspaceId, teamspaceId: general.id, title: "Automobile insurance", createdBy: owner, updatedBy: owner })
    .returning();
  check((await index.stalePages(workspaceId)).includes(missed.id), "a page written around the index counts as stale");
  index.resetSweeps();
  await found(owner, "insurance");
  await sleep(50);
  await settle();
  check((await chunkCount(missed.id)) === 1, "a workspace's first search starts a sweep that indexes it");
  const stale = await index.stalePages(workspaceId);
  const staleRows = stale.length
    ? await db.execute(sql`select p.id, p.title, p.updated_at, s.source_updated_at, s.indexed_at from page p left join page_index_state s on s.page_id = p.id where p.id in (${sql.join(stale.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  check(stale.length === 0, "…leaving nothing stale", staleRows);
  sent = fake.embedded.length;
  check((await index.sweepWorkspace(workspaceId)) === 0 && fake.embedded.length === sent, "a second sweep has nothing to do");

  // Pages indexed with an older chunking count as stale; when their chunks come out the same,
  // indexing them again embeds nothing.
  await db.update(pageIndexState).set({ chunkerVersion: CHUNKER_VERSION - 1 }).where(eq(pageIndexState.pageId, handbook.id));
  check((await index.stalePages(workspaceId)).includes(handbook.id), "a page indexed with an older chunking counts as stale");
  sent = fake.embedded.length;
  check((await index.indexPage(handbook.id)) === "unchanged" && fake.embedded.length === sent, "…indexing it again embeds nothing when its chunks stay the same");
  check(!(await index.stalePages(workspaceId)).includes(handbook.id), "…and it is up to date afterwards");

  // ── The workspace switch ────────────────────────────────────────────────────────────────────
  await updateWorkspaceSettings(owner, workspaceId, { ai: false });
  const counts = await index.indexCounts([workspaceId]);
  check(counts.pages === 0 && counts.chunks === 0, "turning AI off for a workspace drops its index", counts);
  const offHits = await found(alice, "automobile");
  check(offHits.every((h) => h.match !== "semantic"), "…and its search is full-text only", offHits);
  check(
    JSON.stringify(idsOf(await found(alice, "tyres"))) === JSON.stringify(idsOf(await fullTextSearch(alice, "tyres", { workspaceId }))),
    "…exactly the full-text results",
  );
  await getCollab().replaceContent(office.id, "Puppies are welcome every day.", actor);
  await settle();
  check((await chunkCount(office.id)) === 0, "…and nothing is embedded there while it's off");
  await updateWorkspaceSettings(owner, workspaceId, { ai: true });
  check((await index.sweepWorkspace(workspaceId)) > 0, "turning it back on lets a sweep index the workspace again");
  await settle();
  check(idsOf(await found(alice, "automobile")).includes(fleet.id), "…and search by meaning comes back");

  // ── Another model, or none ──────────────────────────────────────────────────────────────────
  setAiEnv({ ...EMBEDDINGS, AI_EMBEDDINGS_MODEL: "fake-embed-2" });
  clearQueryCache();
  check((await semanticSearch(alice, "automobile", { workspaceId })).length === 0, "chunks of another embeddings model are never compared");
  check((await index.stalePages(workspaceId)).includes(fleet.id), "…and the pages count as stale for the new model");
  await index.sweepWorkspace(workspaceId);
  await settle();
  const models = await db.execute<{ model: string }>(sql`select distinct model from page_chunk where workspace_id = ${workspaceId}`);
  check(models.length === 1 && models[0].model === "fake-embed-2", "re-indexing replaces the old model's chunks", models);
  check(idsOf(await found(alice, "automobile")).includes(fleet.id), "…and search by meaning works with the new model");

  resetAi();
  setAiEnv({});
  clearQueryCache();
  for (const q of ["automobile", "tyres", "holiday", "Fleet"]) {
    const hybrid = await found(alice, q);
    const text = await fullTextSearch(alice, q, { workspaceId });
    check(JSON.stringify(hybrid) === JSON.stringify(text), `without an embeddings model, search is exactly full-text search ("${q}")`);
  }
  index.scheduleIndex(fleet.id, 0);
  check(!index.indexBusy(), "…and nothing is queued for indexing");
  check((await callTool(alice, "search", { query: "automobile", workspace_id: workspaceId })).data.results.every((r: { match: string }) => r.match === "text"), "…MCP included");

  console.log(`\n${passed} checks passed`);
} finally {
  resetAi();
  await settle().catch(() => {});
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWs]));
  await db.delete(user).where(inArray(user.id, userIds));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
