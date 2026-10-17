/**
 * End-to-end check of the search box's filters against the database: `in:` (a title, quoted or
 * not, several pages of one title, a page the person can't see), `type:` (pages, databases, rows),
 * filters without text, filters with text, words inside Japanese, Chinese and Korean sentences, a
 * page too large for the whole of it to be indexed, and the pages last edited before anything is
 * typed.
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
const { inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { user, workspace, workspaceMember } = await import("@/db/schema");
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

const ids = { owner: `${RUN}-owner`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const titlesOf = (hits: { title: string }[]) => hits.map((h) => h.title).sort();

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.guest, role: "guest" },
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

  const recent = await recentPages(ids.owner, workspaceId, 3);
  check(recent.length === 3 && recent[0].updatedAt >= recent[2].updatedAt, "the pages last edited come newest first", recent);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
