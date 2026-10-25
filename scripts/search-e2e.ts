/**
 * End-to-end check of the search box's filters against the database: `in:` (a title, quoted or
 * not, several pages of one title, a page the person can't see), `type:` (pages, databases, rows),
 * filters without text, filters with text, words inside Japanese, Chinese and Korean sentences,
 * Turkish words written with I, ı, İ or i found by each other, a page too large for the whole of it
 * to be indexed, and the pages last edited before anything is typed. Also "quoted phrases" (in the
 * box and through the shared search operation), the box's teamspace, people and date filters, and
 * the pages the person opened last (falling back while views aren't recorded).
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/search-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
import { createHash } from "node:crypto";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { search: searchOperation } = await import("@/server/operations");
const { recentlyViewedPages, recordPageView } = await import("@/server/page-views");
const { removePagePermission } = await import("@/server/permissions");
const { createTeamspace, joinTeamspace } = await import("@/server/teamspaces");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage, fullTextSearch, recentPages, searchWithQuery } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");

const RUN = `search-e2e-${Date.now().toString(36)}`;

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

const ids = { owner: `${RUN}-owner`, guest: `${RUN}-guest`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const titlesOf = (hits: { title: string }[]) => hits.map((h) => h.title).sort();

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const owner = { userId: ids.owner };
  const make = (title: string, parentId: string | null = null, kind: "page" | "database" = "page") =>
    createPage(owner, { workspaceId, parentId, title, kind });

  const projects = await make("Projects");
  await make("Budget plan", projects.id);
  const tracker = await make("Tracker", projects.id, "database");
  await make("Budget row", tracker.id);
  const launch = await make("Launch plan");
  await make("Budget notes", launch.id);
  const archive = await make("Archive");
  const oldProjects = await make("projects", archive.id);
  await make("Old budget", oldProjects.id);
  await make("Budget elsewhere");

  const search = (query: string, userId = ids.owner) => searchWithQuery(userId, workspaceId, query);

  check(titlesOf(await search("budget")).length === 5, "plain text finds every page with the word", titlesOf(await search("budget")));
  check(
    JSON.stringify(titlesOf(await search("budget in:Projects"))) === JSON.stringify(["Budget plan", "Budget row", "Old budget"]),
    "in: limits the search to the pages under every page of that title (without case)",
    titlesOf(await search("budget in:Projects")),
  );
  check(
    JSON.stringify(titlesOf(await search('budget in:"Launch plan"'))) === JSON.stringify(["Budget notes"]),
    "a quoted title with spaces works",
  );
  check(
    JSON.stringify(titlesOf(await search("in:Projects in:Archive budget"))) ===
      JSON.stringify(["Budget plan", "Budget row", "Old budget"].sort()),
    "several in: filters find pages under any of them",
  );
  check((await search("budget in:Nowhere")).length === 0, "an in: naming no page finds nothing (not everything)");
  const izmir = await make("İzmir ofisi");
  await make("Kira sözleşmesi", izmir.id);
  const light = await make("Işık");
  await make("Kira faturası", light.id);
  check(
    JSON.stringify(titlesOf(await search('kira in:"izmir OFİSİ"'))) === JSON.stringify(["Kira sözleşmesi"]) &&
      JSON.stringify(titlesOf(await search("kira in:ışık"))) === JSON.stringify(["Kira faturası"]) &&
      JSON.stringify(titlesOf(await search("kira in:IŞIK"))) === JSON.stringify(["Kira faturası"]),
    "in: finds titles with the dotted and dotless i either way",
    [titlesOf(await search('kira in:"izmir OFİSİ"')), titlesOf(await search("kira in:ışık"))],
  );

  check(
    JSON.stringify(titlesOf(await search("type:database"))) === JSON.stringify(["Tracker"]),
    "type:database alone lists the databases",
  );
  check(
    JSON.stringify(titlesOf(await search("budget type:row"))) === JSON.stringify(["Budget row"]),
    "type:row finds database rows",
  );
  check(
    !titlesOf(await search("budget type:page")).includes("Budget row") && titlesOf(await search("budget type:page")).length === 4,
    "type:page leaves the rows out",
    titlesOf(await search("budget type:page")),
  );
  const inside = titlesOf(await search("in:Launch"));
  check(inside.length === 0, "in: matches whole titles, not parts", inside);
  const underLaunch = titlesOf(await search('in:"launch plan"'));
  check(
    JSON.stringify(underLaunch) === JSON.stringify(["Budget notes", "Launch plan"]),
    "in: alone lists the page and everything under it",
    underLaunch,
  );
  check((await search("type:folder")).length === 0 && (await search("")).length === 0, "an unknown type is text, and an empty query finds nothing");

  // Words as they are typed: each word of the query also as the start of a longer one, in the
  // title or the body; a title that has them comes before a body that does.
  const service = await createPage(owner, {
    workspaceId,
    parentId: null,
    title: "Service visit",
    markdown: "The kondenser of the cold room was cleaned. Next visit: e-posta to the customer.",
  });
  const kondTitle = await make("Kondenser plans");
  check(
    JSON.stringify(titlesOf(await search("kond"))) === JSON.stringify(["Kondenser plans", "Service visit"]),
    "the start of a word finds it, in a title and in a body",
    titlesOf(await search("kond")),
  );
  check((await search("kond"))[0]?.id === kondTitle.id, "…the page whose title has it first", await search("kond"));
  check(
    JSON.stringify(titlesOf(await search("cold kond"))) === JSON.stringify(["Service visit"]),
    "every word of the query has to be on the page, in any order",
    titlesOf(await search("cold kond")),
  );
  check((await search("cold kond"))[0]?.snippet.includes("kondenser"), "…and the snippet shows where", (await search("cold kond"))[0]);
  check(
    (await search("e-posta")).some((h) => h.id === service.id) && (await search("posta")).some((h) => h.id === service.id),
    "a hyphenated word is found whole and by its parts",
  );
  check((await search("---")).length === 0 && (await search("%")).length === 0, "a query without words finds nothing (and doesn't fail)");
  check((await search("ondenser")).length === 0, "the middle of a word isn't a match");

  // Japanese, Chinese and Korean: no spaces between words (or particles joined on), so a word is
  // found inside a sentence through the two-character pieces the index holds for such text.
  const body = (title: string, markdown: string) => createPage(owner, { workspaceId, parentId: null, title, markdown });
  const japanese = await body("週次メモ", "明日の会議について話します。");
  const chinese = await body("项目周报", "上周的会议纪要已经整理好了。");
  const korean = await body("주간 메모", "회의를 시작합니다.");
  const room = await make("会議室の予約");
  const idsOf = (hits: { id: string }[]) => hits.map((h) => h.id);
  check(idsOf(await search("会議")).includes(japanese.id), "a Japanese word is found in the middle of a sentence", titlesOf(await search("会議")));
  check((await search("会議"))[0]?.id === room.id, "…a title that has it first", titlesOf(await search("会議")));
  check(idsOf(await search("会")).includes(japanese.id), "…and a single character as it is typed");
  check(!idsOf(await search("議論")).includes(japanese.id), "characters that aren't next to each other on the page don't match", titlesOf(await search("議論")));
  check(
    JSON.stringify(idsOf(await search("纪要"))) === JSON.stringify([chinese.id]) && idsOf(await search("会议纪要")).includes(chinese.id),
    "a Chinese word is found inside a sentence, and only there",
    titlesOf(await search("纪要")),
  );
  check(idsOf(await search("회의")).includes(korean.id) && !idsOf(await search("의를")).includes(korean.id), "a Korean word is found with a particle joined to it, by its start");
  const assembly = await body("국회 소식", "국회의원 선거가 있습니다.");
  check(!idsOf(await search("회의")).includes(assembly.id), "…not inside a longer Korean word");
  const trip = await body("出張の予定", "東京から京都へ行きます。");
  const tokyo = await body("都庁の予定", "東京都の会議があります。");
  check(
    idsOf(await search("東京都")).includes(tokyo.id) && !idsOf(await search("東京都")).includes(trip.id),
    "the pieces of a word must stand together: 東京都 doesn't find a page about 東京 and 京都",
    titlesOf(await search("東京都")),
  );
  check(idsOf(await search("会議 メモ")).join() === japanese.id, "pieces and words of a query are all needed, in the title or the body", titlesOf(await search("会議 メモ")));
  const asked = idsOf(await fullTextSearch(ids.owner, "明日の会議はどこですか", { workspaceId, anyWord: true }));
  check(asked.includes(japanese.id) && !asked.includes(chinese.id) && !asked.includes(korean.id), "a question in Japanese finds the pages about it, not every page with kana", asked);
  check((await search("纪要"))[0]?.snippet.includes("纪要"), "…and the snippet shows where", (await search("纪要"))[0]);

  // Turkish: "I" lowers to "ı" and "İ" to "i", which the database (lowering the English way) doesn't
  // do. Page and query are folded alike, so the dotted and dotless i find each other either way.
  const shouted = await body("Depo notları", "Depoda IŞIK yetersiz, SICAKLIK yüksek.");
  const quiet = await body("Lamba", "Bu odada ışık az, sıcaklık normal.");
  const city = await make("İSTANBUL şubesi");
  const cityNote = await body("Ofis notları", "istanbul ofisinin kirası arttı.");
  const measure = await make("Işık ölçümü");
  const boiler = await body("Kazan", "ISITMA sistemi bakımı yapıldı.");
  const both = [shouted.id, quiet.id];
  for (const query of ["ışık", "IŞIK", "Işık", "işik"]) {
    const found = idsOf(await search(query));
    check(both.every((id) => found.includes(id)) && found.includes(measure.id), `"${query}" finds IŞIK, ışık and Işık`, titlesOf(await search(query)));
  }
  check(idsOf(await search("sıcaklık")).includes(shouted.id) && idsOf(await search("SICAKLIK")).includes(quiet.id), "SICAKLIK and sıcaklık find each other");
  for (const query of ["istanbul", "İSTANBUL", "İstanbul", "ISTANBUL"]) {
    const found = await search(query);
    check(
      found[0]?.id === city.id && idsOf(found).includes(cityNote.id),
      `"${query}" finds İSTANBUL and istanbul, the title that has it first`,
      titlesOf(found),
    );
  }
  check((await search("ışık ölç"))[0]?.id === measure.id, "a title written with Işık comes first for ışık, while typing", titlesOf(await search("ışık ölç")));
  check(idsOf(await search("ısıtma")).includes(boiler.id) && idsOf(await search("isitma")).includes(boiler.id), "ISITMA is found typed ısıtma or isitma");
  check((await search("ışık")).find((h) => h.id === shouted.id)?.snippet.includes("IŞIK"), "…and the snippet shows where", await search("ışık"));
  const turkishQuestion = idsOf(await fullTextSearch(ids.owner, "Depodaki ışık ve ısıtma ne durumda?", { workspaceId, anyWord: true }));
  check(
    [shouted.id, quiet.id, boiler.id].every((id) => turkishQuestion.includes(id)),
    "a question in Turkish finds the pages written in capitals",
    turkishQuestion,
  );

  // A huge page of unique words (about 2 MB) saves: the index takes only the first 80,000
  // characters of the body, so its vector stays under Postgres' tsvector limit.
  const words = Array.from({ length: 62_000 }, (_, i) => `q${createHash("md5").update(`${RUN}-${i}`).digest("hex")}`);
  const paragraphs = Array.from({ length: words.length / 100 }, (_, p) => words.slice(p * 100, p * 100 + 100).join(" "));
  const huge = await body("Huge log", `First line: zanderwick.\n\n${paragraphs.join("\n\n")}`);
  check(idsOf(await search("zanderwick")).includes(huge.id), "a page with 2 MB of unique words saves and is found by a word near its start");
  check(idsOf(await search(words[300])).includes(huge.id), "…and by one further in");
  check(!idsOf(await search(words.at(-1)!)).includes(huge.id), "…but not by one past the first 80,000 characters");

  // Someone who can only see one page doesn't reach others through in:
  await setPagePermission(ids.owner, launch.id, ids.guest, "view");
  check(
    JSON.stringify(titlesOf(await search("budget", ids.guest))) === JSON.stringify(["Budget notes"]),
    "a guest finds only what is shared with them",
    titlesOf(await search("budget", ids.guest)),
  );
  check((await search("budget in:Projects", ids.guest)).length === 0, "…and in: naming a page they can't see finds nothing");

  // Quoted phrases: the words whole, next to each other and in that order.
  const withBody = (title: string, markdown: string, userId = ids.owner) => createPage({ userId }, { workspaceId, title, markdown });
  const agreed = await withBody("Spring notes", "We agreed on the launch plan for spring.");
  const reversed = await withBody("Ready notes", "The plan for the launch is ready.");
  const planning = await withBody("Offsite agenda", "A day of planning together.");
  const quarterly = await withBody("Quarterly launch plan", "Dates and owners.");
  const has = (hits: { id: string }[], ...pages: { id: string }[]) => pages.every((p) => idsOf(hits).includes(p.id));
  const hasNone = (hits: { id: string }[], ...pages: { id: string }[]) => pages.every((p) => !idsOf(hits).includes(p.id));
  check(has(await search("launch plan"), agreed, reversed, quarterly), "words without quotes are found anywhere on the page", titlesOf(await search("launch plan")));
  check(
    has(await search('"launch plan"'), agreed, quarterly) && hasNone(await search('"launch plan"'), reversed),
    "a quoted phrase is found only with its words next to each other, in the body or the title",
    titlesOf(await search('"launch plan"')),
  );
  check(hasNone(await search('"plan launch"'), agreed, quarterly), "…in that order");
  check(has(await search('"LAUNCH   Plan"'), agreed), "…whatever the case and spacing");
  check(
    has(await search("plan"), planning) && hasNone(await search('"plan"'), planning) && has(await search('"plan"'), reversed),
    "a quoted word is found whole, not as the start of a longer one",
  );
  check(has(await search('"launch pl'), agreed, reversed), "a quote still being typed is searched as words");
  check(
    has(await search('spring "launch plan"'), agreed) && hasNone(await search('dates "launch plan"'), agreed),
    "a phrase and words together: all of them are needed",
  );
  check((await search('"launch plan"')).find((h) => h.id === agreed.id)?.snippet.includes("launch plan"), "…and the snippet shows the phrase");
  const tokyoNotes = await withBody("東京メモ", "東京都の会議資料をまとめました。");
  const apart = await withBody("別メモ", "会議の資料はあとで。");
  check(
    has(await search('"会議資料"'), tokyoNotes) && hasNone(await search('"会議資料"'), apart),
    "a Japanese phrase in quotes is found where its characters stand together",
    titlesOf(await search('"会議資料"')),
  );
  check(has(await search('"資料"'), tokyoNotes, apart), "…and one quoted word inside sentences, like unquoted");
  const viaOperation = await searchOperation({ userId: ids.owner } as never, { query: '"launch plan"', workspace_id: workspaceId, limit: 20 });
  check(
    viaOperation.results.some((r) => r.id === agreed.id) && !viaOperation.results.some((r) => r.id === reversed.id),
    "MCP and the REST API take quoted phrases too",
  );
  const question = await searchOperation({ userId: ids.owner } as never, { query: '"launch plan" spring', workspace_id: workspaceId, limit: 20 }, { anyWord: true });
  check(question.results.some((r) => r.id === reversed.id), "the AI chat's any-word search leaves quotes alone");

  // The box's filters: teamspace, who created or last edited a page, and when.
  const team = await createTeamspace(ids.owner, workspaceId, { name: `${RUN} team`, access: "open" });
  await joinTeamspace(ids.member, team.id);
  const inTeam = await createPage({ userId: ids.member }, { workspaceId, teamspaceId: team.id, title: "Roadmap draft", markdown: "Roadmap for the year." });
  const ownerInTeam = await createPage(owner, { workspaceId, teamspaceId: team.id, title: "Roadmap review" });
  const filtered = (query: string, filters: Partial<import("@/lib/search-filters").SearchFilters>, userId = ids.owner) =>
    searchWithQuery(userId, workspaceId, query, 50, {
      filters: { teamspaceIds: [], createdBy: [], editedBy: [], date: null, ...filters },
      timeZone: "Europe/Istanbul",
    });
  check(
    JSON.stringify(titlesOf(await filtered("", { teamspaceIds: [team.id] }))) === JSON.stringify(["Roadmap draft", "Roadmap review"]),
    "a teamspace filter without text lists that teamspace's pages",
    titlesOf(await filtered("", { teamspaceIds: [team.id] })),
  );
  check(
    JSON.stringify(titlesOf(await filtered("roadmap", { createdBy: [ids.member] }))) === JSON.stringify(["Roadmap draft"]),
    "created by narrows a search to the pages those people made",
  );
  // The owner edits the member's page: it is last edited by the owner from now on.
  await db.update(page).set({ title: "Roadmap draft 2", updatedBy: ids.owner }).where(eq(page.id, inTeam.id));
  check(
    has(await filtered("roadmap", { editedBy: [ids.owner] }), inTeam, ownerInTeam) && (await filtered("roadmap", { editedBy: [ids.member] })).length === 0,
    "last edited by narrows to the pages those people edited last",
  );
  check((await filtered("roadmap", { createdBy: ["nobody"] })).length === 0, "a person who made nothing finds nothing");
  // Made 40 days ago, last edited 10 days ago (raw SQL keeps the times as written).
  await db.execute(sql`update ${page} set created_at = now() - interval '40 days', updated_at = now() - interval '10 days' where id = ${ownerInTeam.id}`);
  const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  check(
    has(await filtered("roadmap", { date: { field: "edited", preset: "month" } }), ownerInTeam) &&
      hasNone(await filtered("roadmap", { date: { field: "edited", preset: "week" } }), ownerInTeam) &&
      has(await filtered("roadmap", { date: { field: "edited", preset: "today" } }), inTeam),
    "edited today, in the last 7 or 30 days",
  );
  check(
    hasNone(await filtered("roadmap", { date: { field: "created", preset: "month" } }), ownerInTeam) &&
      has(await filtered("roadmap", { date: { field: "created", preset: "custom", from: day(45), to: day(35) } }), ownerInTeam) &&
      hasNone(await filtered("roadmap", { date: { field: "created", preset: "custom", from: day(45), to: day(35) } }), inTeam),
    "created in the last 30 days, or between chosen days",
  );
  check(
    JSON.stringify(titlesOf(await filtered("", { teamspaceIds: [team.id] }, ids.guest))) === "[]",
    "filters don't show anyone pages they can't open",
  );
  const restFilters = await searchOperation(
    { userId: ids.owner } as never,
    { query: "", workspace_id: workspaceId, limit: 20 },
    { filters: { teamspaceIds: [team.id], createdBy: [ids.member] } },
  );
  check(restFilters.results.map((r) => r.id).join() === inTeam.id, "the REST API's filters list pages without a query");

  // The pages the person opened last ("Jump back in", the box before anything is typed).
  const shared = await createPage(owner, { workspaceId, teamspaceId: null, title: "Shared plan" });
  await setPagePermission(ids.owner, shared.id, ids.member, "view");
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  await recordPageView(ids.member, inTeam.id, at(30));
  await recordPageView(ids.member, shared.id, at(20));
  await recordPageView(ids.member, ownerInTeam.id, at(10));
  const viewed = await recentlyViewedPages(ids.member, workspaceId, 8);
  check(
    JSON.stringify(viewed?.map((p) => p.id)) === JSON.stringify([ownerInTeam.id, shared.id, inTeam.id]),
    "the pages someone opened come last opened first",
    viewed,
  );
  check((await recentlyViewedPages(ids.owner, workspaceId, 8))?.length === 0, "…their own views only");
  await removePagePermission(ids.owner, shared.id, ids.member);
  check(!(await recentlyViewedPages(ids.member, workspaceId, 8))?.some((p) => p.id === shared.id), "a page they can no longer open leaves the list");
  await db.update(workspaceMember).set({ pageViews: false }).where(eq(workspaceMember.userId, ids.member));
  check((await recentlyViewedPages(ids.member, workspaceId, 8)) === null, "with their own recording off, there is no list (the pages last edited show instead)");
  await db.update(workspaceMember).set({ pageViews: true }).where(eq(workspaceMember.userId, ids.member));
  await db.update(workspace).set({ settings: { pageViews: false } }).where(eq(workspace.id, workspaceId));
  check((await recentlyViewedPages(ids.member, workspaceId, 8)) === null, "…and with the workspace's recording off");
  check((await recentlyViewedPages(ids.guest, workspaceId, 8)) === null, "a guest, whose views aren't recorded, has no list");
  await db.update(workspace).set({ settings: {} }).where(eq(workspace.id, workspaceId));

  // The box's order: best match, or by when pages were last edited or created.
  const dated = async (title: string, markdown: string, created: string, edited: string) => {
    const made = await createPage(owner, { workspaceId, parentId: null, title, markdown });
    await db.execute(sql`update ${page} set created_at = ${created}::timestamptz, updated_at = ${edited}::timestamptz where id = ${made.id}`);
    return made;
  };
  // Made in one order, edited in another; "Quokka quokka quokka" is the best match for "quokka".
  await dated("Quokka quokka quokka", "Quokka, quokka.", "2025-01-03T00:00:00Z", "2025-02-01T00:00:00Z");
  await dated("Notes on a quokka", "Seen once.", "2025-01-01T00:00:00Z", "2025-02-03T00:00:00Z");
  await dated("Island trip", "A quokka at last.", "2025-01-02T00:00:00Z", "2025-02-02T00:00:00Z");
  const sorted = async (sort: import("@/lib/search-filters").SearchSort) =>
    (await searchWithQuery(ids.owner, workspaceId, "quokka", 20, { sort })).map((h) => h.title);
  check((await sorted("relevance"))[0] === "Quokka quokka quokka", "best match comes first by default", await sorted("relevance"));
  check(
    JSON.stringify(await sorted("editedNewest")) === JSON.stringify(["Notes on a quokka", "Island trip", "Quokka quokka quokka"]),
    "sorted by last edited, newest first",
    await sorted("editedNewest"),
  );
  check(
    JSON.stringify(await sorted("editedOldest")) === JSON.stringify(["Quokka quokka quokka", "Island trip", "Notes on a quokka"]),
    "…oldest first",
    await sorted("editedOldest"),
  );
  check(
    JSON.stringify(await sorted("createdNewest")) === JSON.stringify(["Quokka quokka quokka", "Island trip", "Notes on a quokka"]),
    "sorted by created, newest first",
    await sorted("createdNewest"),
  );
  check(
    JSON.stringify(await sorted("createdOldest")) === JSON.stringify(["Notes on a quokka", "Island trip", "Quokka quokka quokka"]),
    "…oldest first",
    await sorted("createdOldest"),
  );
  const firstOldest = await searchWithQuery(ids.owner, workspaceId, "quokka", 1, { sort: "createdOldest" });
  check(firstOldest.length === 1 && firstOldest[0].title === "Notes on a quokka", "a date order picks from every match, not only the best few", firstOldest);

  const recent = await recentPages(ids.owner, workspaceId, 3);
  check(recent.length === 3 && recent[0].updatedAt >= recent[2].updatedAt, "the pages last edited come newest first", recent);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
