/**
 * End-to-end check of importing a Notion "Markdown & CSV" export: a split export (an Export ZIP
 * holding its parts) as pages and databases in a teamspace, with Notion's ids left out of titles,
 * subpages as link-to-page blocks, callouts, toggles, to-dos, tables and equations as blocks, row
 * pages without their property list, relations between the databases (by relative link, by
 * notion.so link, from the row page's list and by title), links and notion.so links between pages
 * rewritten, images and attachments uploaded, and what was left out reported. Also through the
 * /api/import route.
 *
 * The fixture is built from Notion's documented export format; no real Notion export was used.
 * Creates its own users, workspace and teamspace, stores files in a temporary directory, and
 * deletes all of it afterwards.
 *
 *   pnpm tsx scripts/notion-import-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { randomBytes } = await import("node:crypto");

const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-notion-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;

const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { strToU8, zipSync } = await import("fflate");
const { db } = await import("@/db");
const { file, page, session, user, workspace, workspaceMember } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { pagePath } = await import("@/lib/mentions");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createTeamspace } = await import("@/server/teamspaces");
const databases = await import("@/server/databases");
const { importPages } = await import("@/server/import/markdown");
const importRoute = await import("@/app/api/import/route");

const RUN = `notion-e2e-${Date.now().toString(36)}`;
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

async function eventually(fn: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const ownerId = `${RUN}-owner`;
const workspaceId = `${RUN}-ws`;

const zip = (files: Record<string, string | Uint8Array>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])));
const children = async (parentId: string | null) =>
  db
    .select({ id: page.id, title: page.title, kind: page.kind, teamspaceId: page.teamspaceId })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), parentId ? eq(page.parentId, parentId) : isNull(page.parentId), isNull(page.archivedAt)))
    .orderBy(page.position);
const child = async (parentId: string | null, title: string) => (await children(parentId)).find((c) => c.title === title);
const body = async (pageId: string) => (await getCollab().readPage(pageId)).markdown;
const blocks = async (pageId: string) => (await getCollab().readBlocks(pageId)).blocks as { type: string; props?: Record<string, unknown> }[];
const png = () => Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), randomBytes(200)]);
const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

// Notion ids: 32 hex digits at the end of every name.
const hex = (n: number) => n.toString(16).padStart(32, "0");
const HOME = hex(0xa1);
const ONBOARDING = hex(0xa2);
const FIRST_WEEK = hex(0xa3);
const PROJECTS = hex(0xb1);
const WEBSITE = hex(0xb2);
const MOBILE = hex(0xb3);
const INTRANET = hex(0xb4);
const TASKS = hex(0xc1);
const DESIGN = hex(0xc2);
const COPY = hex(0xc3);
const BETA = hex(0xc4);
const GHOST = hex(0xdead);
const UUID = "4f2e8c1a-1b2c-4d3e-8f90-123456789abc";

const home = `Workspace Home ${HOME}`;
const projects = `${home}/Projects ${PROJECTS}`;
const tasks = `Tasks ${TASKS}`;
const notionUrl = (title: string, id: string) => `https://www.notion.so/${title.replace(/\s+/g, "-")}-${id}?pvs=21`;
const taskLink = (from: string, title: string, id: string) => `${title} (${from}${enc(`${tasks}/${title} ${id}.md`)})`;

const projectsCsv = [
  "Name,Status,Owner,Start,Budget,Website,Contact,Archived,Tasks,Files",
  `Website,In progress,Erhan Erbas,"September 1, 2026",1200,https://example.com,web@example.com,No,"${taskLink("../", "Design homepage", DESIGN)}, ${taskLink("../", "Write copy", COPY)}",${enc(`Website ${WEBSITE}/brief.pdf`)}`,
  `Mobile app,In progress,Jane Doe,"October 1, 2026",800,,,No,,`,
  `Old intranet,Done,Erhan Erbas,"January 5, 2025",,,,Yes,"Ghost task (${notionUrl("Ghost task", GHOST)}), Legacy cleanup",`,
].join("\n");
const tasksCsv = [
  "Name,Done,Due,Tags,Project,Assignee,Estimate",
  `Design homepage,Yes,"September 10, 2026","design, web","Website (${notionUrl("Website", WEBSITE)})",Erhan Erbas,3`,
  `Write copy,No,"September 12, 2026 → September 14, 2026",web,"Website (${notionUrl("Website", WEBSITE)})",Jane Doe,2`,
  `Ship beta,No,,mobile,Mobile app (${enc(`${projects}/Mobile app ${MOBILE}.md`)}),Erhan Erbas,5`,
  `Legacy cleanup,Yes,,,Old intranet (${notionUrl("Old intranet", INTRANET)}),Jane Doe,`,
].join("\n");

const part1 = zip({
  [`${home}.md`]: [
    "# Workspace Home",
    "",
    "Welcome to the team wiki.",
    "",
    "<aside>",
    `💡 Start with the [Onboarding](${enc(`${home}/Onboarding ${ONBOARDING}.md`)}) guide.`,
    "",
    "</aside>",
    "",
    `[Onboarding](${enc(`${home}/Onboarding ${ONBOARDING}.md`)})`,
    "",
    `[Projects](${enc(`${home}/Projects ${PROJECTS}.csv`)})`,
    "",
    `The task list lives [on its own page](${notionUrl("Tasks", TASKS)}); [elsewhere](https://www.notion.so/Other-${GHOST}) stays a link.`,
    "",
    `![Team photo](${enc(`${home}/team.png`)})`,
  ].join("\n"),
  [`${home}/team.png`]: png(),
  [`${home}/unused-diagram.png`]: png(),
  [`${home}/Onboarding ${ONBOARDING}.md`]: [
    "# Onboarding",
    "",
    `Back to [home](../${enc(`${home}.md`)}).`,
    "",
    `[First week](${enc(`Onboarding ${ONBOARDING}/First week ${FIRST_WEEK}.md`)})`,
    "",
    "<details>",
    "<summary>Accounts to request</summary>",
    "",
    "- Email",
    "- Chat",
    "",
    "</details>",
    "",
    "- [x] Read the handbook",
    "- [ ] Meet the team",
    "",
    "| Day | Topic |",
    "| --- | --- |",
    "| 1 | Tools |",
    "| 2 | Code |",
    "",
    "Velocity is $`v = \\frac{d}{t}`$.",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    `[handbook.pdf](${enc(`Onboarding ${ONBOARDING}/handbook.pdf`)})`,
  ].join("\n"),
  [`${home}/Onboarding ${ONBOARDING}/handbook.pdf`]: "%PDF-1.4 handbook",
  [`${home}/Onboarding ${ONBOARDING}/First week ${FIRST_WEEK}.md`]: "# First week\n\nPair with a buddy.",
});

const part2 = zip({
  [`Export-${UUID}-Part-2/${projects}.csv`]: projectsCsv.split("\n").slice(0, 3).join("\n"),
  [`Export-${UUID}-Part-2/${projects}_all.csv`]: projectsCsv,
  [`Export-${UUID}-Part-2/${projects}.md`]: "# Projects\n",
  [`Export-${UUID}-Part-2/${projects}/Website ${WEBSITE}.md`]: [
    "# Website",
    "",
    "Status: In progress",
    "Owner: Erhan Erbas",
    "Start: September 1, 2026",
    "Budget: 1200",
    "Website: https://example.com",
    "Contact: web@example.com",
    "Archived: No",
    `Tasks: ${taskLink("../../", "Design homepage", DESIGN)}, ${taskLink("../../", "Write copy", COPY)}`,
    `Files: [brief.pdf](${enc(`Website ${WEBSITE}/brief.pdf`)})`,
    "",
    "The site relaunch.",
  ].join("\n"),
  [`Export-${UUID}-Part-2/${projects}/Website ${WEBSITE}/brief.pdf`]: "%PDF-1.4 brief",
  [`Export-${UUID}-Part-2/${projects}/Mobile app ${MOBILE}.md`]: [
    "# Mobile app",
    "",
    "Status: In progress",
    "Owner: Jane Doe",
    "Start: October 1, 2026",
    "Budget: 800",
    "Archived: No",
    `Tasks: [Ship beta](../../${enc(`${tasks}/Ship beta ${BETA}.md`)})`,
    "",
  ].join("\n"),
  [`Export-${UUID}-Part-2/${tasks}.csv`]: tasksCsv,
  [`Export-${UUID}-Part-2/${tasks}_all.csv`]: tasksCsv,
  [`Export-${UUID}-Part-2/${tasks}/Design homepage ${DESIGN}.md`]: [
    "# Design homepage",
    "",
    "Done: Yes",
    "Due: September 10, 2026",
    "Tags: design, web",
    `Project: [Website](../${enc(`${projects}/Website ${WEBSITE}.md`)})`,
    "Assignee: Erhan Erbas",
    "Estimate: 3",
    "",
    `Follow the [onboarding](../${enc(`${home}/Onboarding ${ONBOARDING}.md`)}) first.`,
    "",
    `![Mockup](${enc(`Design homepage ${DESIGN}/mockup.png`)})`,
  ].join("\n"),
  [`Export-${UUID}-Part-2/${tasks}/Design homepage ${DESIGN}/mockup.png`]: png(),
  [`Export-${UUID}-Part-2/${tasks}/Write copy ${COPY}.md`]: "# Write copy\n\nDone: No\n",
  "../../escape.md": "outside the archive",
});

const exportZip = zip({ [`Export-${UUID}-Part-1.zip`]: part1, [`Export-${UUID}-Part-2.zip`]: part2 });

try {
  await db.insert(user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.test` });
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values({ workspaceId, userId: ownerId, role: "owner" });
  const owner = { userId: ownerId };
  const team = await createTeamspace(ownerId, workspaceId, { name: "Imported", access: "open" });

  const result = await importPages(owner, {
    workspaceId,
    parentId: null,
    teamspaceId: team.id,
    files: [{ path: `Export-${UUID}.zip`, data: exportZip }],
  });
  check(
    JSON.stringify(result.pages.map((p) => `${p.kind}:${p.title}`).sort()) === JSON.stringify(["database:Tasks", "page:Workspace Home"]),
    "a split Notion export becomes its top-level pages, ids left out of the titles",
    result.pages,
  );
  check(
    result.created.pages === 3 && result.created.databases === 2 && result.created.rows === 7 && result.created.files === 4,
    "…with its pages, both databases, their rows and the four files pages show",
    result.created,
  );
  const top = await children(null);
  check(top.length === 2 && top.every((p) => p.teamspaceId === team.id), "the pages land in the teamspace the import was started from", top);

  const homePage = (await child(null, "Workspace Home"))!;
  const tasksDb = (await child(null, "Tasks"))!;
  check(
    JSON.stringify((await children(homePage.id)).map((c) => `${c.kind}:${c.title}`)) === JSON.stringify(["page:Onboarding", "database:Projects"]),
    "subpages and a database sit under the page whose folder holds them, the database's own .md left out",
    await children(homePage.id),
  );
  const onboarding = (await child(homePage.id, "Onboarding"))!;
  const projectsDb = (await child(homePage.id, "Projects"))!;
  const firstWeek = (await child(onboarding.id, "First week"))!;
  check(Boolean(firstWeek), "…at any depth");

  // The home page
  await eventually(async () => (await body(homePage.id)).includes("Welcome"), "the home body");
  const homeBlocks = await blocks(homePage.id);
  check(
    JSON.stringify(homeBlocks.map((b) => b.type)) === JSON.stringify(["paragraph", "callout", "pageLink", "pageLink", "paragraph", "image"]),
    "the home page: text, a callout, its subpage and database as link-to-page blocks where Notion had them, and the image",
    homeBlocks.map((b) => b.type),
  );
  check(homeBlocks[1].props?.icon === "💡", "the callout keeps its icon", homeBlocks[1]);
  check(homeBlocks[2].props?.pageId === onboarding.id && homeBlocks[3].props?.pageId === projectsDb.id, "…and the link-to-page blocks point at the imported pages", homeBlocks);
  const homeBody = await body(homePage.id);
  check(homeBody.includes(pagePath(workspaceId, tasksDb.id)), "a notion.so link to a page of the export points at the imported page", homeBody);
  check(homeBody.includes(`https://www.notion.so/Other-${GHOST}`), "…and one to a page outside it stays as it was", homeBody);
  check(!homeBody.includes(HOME) && !homeBody.includes("<aside>"), "no Notion ids or HTML are left in the body", homeBody);

  // Onboarding: toggles, to-dos, tables, equations, attachments, links back up
  await eventually(async () => (await body(onboarding.id)).includes("handbook"), "the onboarding body");
  const onboardingBlocks = await blocks(onboarding.id);
  const types = onboardingBlocks.map((b) => b.type);
  check(
    ["pageLink", "toggleListItem", "checkListItem", "table", "math"].every((t) => types.includes(t)),
    "toggles, to-dos, tables and equations come in as their blocks",
    types,
  );
  const onboardingBody = await body(onboarding.id);
  check(onboardingBody.includes(pagePath(workspaceId, homePage.id)), "a link back up a folder points at the parent page", onboardingBody);
  check(onboardingBody.includes("v = \\frac{d}{t}"), "an inline equation is kept", onboardingBody);
  const stored = await db.select().from(file).where(eq(file.workspaceId, workspaceId));
  const storedNamed = (name: string) => stored.find((f) => f.name === name);
  check(
    storedNamed("handbook.pdf")?.pageId === onboarding.id && onboardingBody.includes(`/api/files/${storedNamed("handbook.pdf")!.id}`),
    "an attachment is uploaded to the page and linked",
    stored,
  );
  check(storedNamed("team.png")?.pageId === homePage.id, "an image is uploaded to the page that shows it", stored);

  // Databases: types, rows, row pages
  const projectsInfo = await databases.getDatabase(ownerId, projectsDb.id);
  const typeOf = Object.fromEntries(projectsInfo.properties.map((p) => [p.name, p.type]));
  check(
    JSON.stringify(typeOf) ===
      JSON.stringify({
        Status: "select",
        Owner: "select",
        Start: "date",
        Budget: "number",
        Website: "url",
        Contact: "email",
        Archived: "checkbox",
        Files: "text",
        Tasks: "relation",
      }),
    "the full CSV (_all) becomes the database, its column types guessed and its relation column a relation",
    typeOf,
  );
  const tasksProp = projectsInfo.properties.find((p) => p.name === "Tasks")!;
  check(tasksProp.options.relation?.databaseId === tasksDb.id, "…to the database its links lead to", tasksProp);
  const tasksInfo = await databases.getDatabase(ownerId, tasksDb.id);
  const projectProp = tasksInfo.properties.find((p) => p.name === "Project")!;
  check(projectProp.type === "relation" && projectProp.options.relation?.databaseId === projectsDb.id, "notion.so links in cells make a relation too", tasksInfo.properties);
  check(
    JSON.stringify(Object.fromEntries(tasksInfo.properties.map((p) => [p.name, p.type]))) ===
      JSON.stringify({ Done: "checkbox", Due: "date", Tags: "multi_select", Assignee: "select", Estimate: "number", Project: "relation" }),
    "…next to the other columns' guessed types",
    tasksInfo.properties,
  );

  const projectRows = await databases.listRows(ownerId, projectsDb.id);
  const taskRows = await databases.listRows(ownerId, tasksDb.id);
  const taskId = (title: string) => taskRows.find((r) => r.title === title)!.id;
  const projectRow = (title: string) => projectRows.find((r) => r.title === title)!;
  check(
    JSON.stringify(projectRows.map((r) => r.title)) === JSON.stringify(["Website", "Mobile app", "Old intranet"]) &&
      JSON.stringify(taskRows.map((r) => r.title)) === JSON.stringify(["Design homepage", "Write copy", "Ship beta", "Legacy cleanup"]),
    "each CSV line is a row, the row pages matched to them",
    { projectRows: projectRows.map((r) => r.title), taskRows: taskRows.map((r) => r.title) },
  );
  const linksOf = (row: { properties: Record<string, unknown> }, propId: string) => (row.properties[propId] as string[] | undefined) ?? [];
  check(
    JSON.stringify(linksOf(projectRow("Website"), tasksProp.id)) === JSON.stringify([taskId("Design homepage"), taskId("Write copy")]),
    "relation cells with relative links link those rows",
    projectRow("Website").properties,
  );
  check(
    JSON.stringify(linksOf(projectRow("Mobile app"), tasksProp.id)) === JSON.stringify([taskId("Ship beta")]),
    "an empty cell takes the links from the row page's property list",
    projectRow("Mobile app").properties,
  );
  check(
    JSON.stringify(linksOf(projectRow("Old intranet"), tasksProp.id)) === JSON.stringify([taskId("Legacy cleanup")]),
    "an entry without a link links the row of that title; one leading outside the export is left out",
    projectRow("Old intranet").properties,
  );
  check(
    taskRows.every((r) => linksOf(r, projectProp.id).length === 1) &&
      linksOf(taskRows.find((r) => r.title === "Ship beta")!, projectProp.id)[0] === projectRow("Mobile app").id &&
      linksOf(taskRows.find((r) => r.title === "Design homepage")!, projectProp.id)[0] === projectRow("Website").id,
    "notion.so links in relation cells link the rows they name",
    taskRows.map((r) => r.properties),
  );
  const estimate = tasksInfo.properties.find((p) => p.name === "Estimate")!;
  const due = tasksInfo.properties.find((p) => p.name === "Due")!;
  const design = taskRows.find((r) => r.title === "Design homepage")!;
  check(design.properties[estimate.id] === 3 && design.properties[due.id] === "2026-09-10", "numbers and Notion's dates are read", design.properties);
  check(taskRows.find((r) => r.title === "Write copy")!.properties[due.id] === "2026-09-12/2026-09-14", "a date range keeps its start and end");

  await eventually(async () => (await body(projectRow("Website").id)).includes("relaunch"), "the website row body");
  const websiteBody = await body(projectRow("Website").id);
  check(!websiteBody.includes("Status:") && !websiteBody.includes("Owner:") && !websiteBody.includes("Tasks:"), "a row page's property list is taken off its body", websiteBody);
  check(
    websiteBody.includes("Files:") && websiteBody.includes(`/api/files/${storedNamed("brief.pdf")?.id}`),
    "…except files it links to, which are uploaded and kept at the top",
    websiteBody,
  );
  await eventually(async () => (await body(design.id)).includes("Follow the"), "the task row body");
  const designBody = await body(design.id);
  check(
    designBody.includes(pagePath(workspaceId, onboarding.id)) && designBody.includes(`/api/files/${storedNamed("mockup.png")?.id}`) && !designBody.includes("Estimate:"),
    "a row page's own links and images come along",
    designBody,
  );

  const warned = result.warnings.map((w) => `${w.code}:${"path" in w ? w.path : "column" in w ? w.column : ""}:${"reason" in w ? w.reason : "count" in w ? w.count : ""}`);
  check(
    warned.includes(`skipped:${home}/unused-diagram.png:unused`) &&
      warned.includes("skipped:../../escape.md:unsafePath") &&
      !warned.some((w) => w.endsWith(":duplicate")) &&
      warned.includes("invalidValues:Tasks:1"),
    "the result reports the unused file, the unsafe path and the relation entry it couldn't link, not Notion's expected duplicates",
    warned,
  );

  // Through the route, into a page
  const token = randomBytes(24).toString("hex");
  await db.insert(session).values({ id: `${RUN}-session`, token, userId: ownerId, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`;
  const form = new FormData();
  form.append("mode", "pages");
  form.append("workspaceId", workspaceId);
  form.append("parentId", onboarding.id);
  form.append("file", new Blob([Buffer.from(exportZip)]), `Export-${UUID}.zip`);
  form.append("path", `Export-${UUID}.zip`);
  const request = new Request("http://localhost:5000/api/import", { method: "POST", body: form, headers: { cookie, "x-leafdesk-import": "1" } });
  const bytes = await request.arrayBuffer();
  const response = await importRoute.POST(
    new Request(request.url, { method: "POST", body: bytes, headers: { ...Object.fromEntries(request.headers), "content-length": String(bytes.byteLength) } }),
  );
  const json = await response.json();
  check(response.status === 201 && json.created.databases === 2 && json.created.rows === 7, "the /api/import route takes the Notion ZIP too", json);
  check(
    JSON.stringify((await children(onboarding.id)).map((c) => c.title).sort()) === JSON.stringify(["First week", "Tasks", "Workspace Home"]),
    "…and puts it under the page it was started from",
    await children(onboarding.id),
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(eq(user.id, ownerId));
  await rm(uploadDir, { recursive: true, force: true });
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
