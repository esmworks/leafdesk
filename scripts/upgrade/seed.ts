/**
 * The first half of the upgrade path test (scripts/upgrade-test.sh): fills a database that an
 * older release migrated with a realistic workspace, through that release's own server code, and
 * writes a manifest of what that release reads back. scripts/upgrade-e2e.ts reads the same things
 * with the current code once the database is upgraded, and compares.
 *
 * It runs inside the older release's checkout, copied to its scripts/ folder so "@/…" imports
 * resolve to the old src, with the old release's node_modules. It is written against the v0.5.0
 * API, which is why typecheck and lint leave it out:
 *
 *   node_modules/.bin/tsx scripts/upgrade-seed.ts <manifest.json>
 *
 * Env: DATABASE_URL (an empty database the old release migrated), BETTER_AUTH_SECRET, APP_URL and
 * UPLOAD_DIR (absolute: the default ./data/uploads is relative to the old checkout, so the files
 * would look lost after the upgrade). The driver passes them explicitly.
 *
 * The workspace: an owner with a password and a signed-in session, a member, a guest and a former
 * member who still holds page grants, a property grant and an API token (migration 0056 removes
 * those on purpose), a member's sign-in provider account with stored tokens (0055 clears those),
 * workspace settings, a closed teamspace with a group in it, nested pages with Markdown bodies
 * (headings, lists, to-dos, code, a quote, a table, a callout, an equation, a picture and a file,
 * links, a "Link to page" block, [[wikilinks]], person and date mentions), icons, a background, a
 * page's typeface and width, a locked page, a trashed page with a subpage, page history (written,
 * saved by hand, restored), two related databases with every property type v0.5.0 has (number
 * formats, a two-way relation, rollups, formulas, sub-items, dependencies, files), 40 rows, views of
 * every type with filters, sorts and grouping, a default row template, comments (a thread with a
 * reply and a reaction, a resolved page thread, a guest's thread, a row's thread), page, group and
 * property permissions, API tokens, automations (one with a webhook to an address that is never
 * called), uploaded files, a workspace template, favorites and a published page. Date ranges came
 * after v0.5.0: Start and End dates and a timeline stand in for them.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { createHash } = await import("node:crypto");
const { mkdir, readFile, writeFile } = await import("node:fs/promises");
const { dirname, isAbsolute } = await import("node:path");
const { Readable } = await import("node:stream");

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Usage: tsx scripts/upgrade-seed.ts <manifest.json>");
if (!process.env.UPLOAD_DIR || !isAbsolute(process.env.UPLOAD_DIR)) {
  throw new Error("UPLOAD_DIR must be an absolute path, so the upgraded release finds the files too");
}
process.env.STORAGE_DRIVER = "local";

// Imported after the environment is set: the database client reads DATABASE_URL when it is created.
const { eq, sql } = await import("drizzle-orm");
const { hashPassword } = await import("better-auth/crypto");
const { db } = await import("@/db");
const schema = await import("@/db/schema");
const { createCollab } = await import("@/server/collab/service");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { resolvePageAccess } = await import("@/server/access");
const pages = await import("@/server/pages");
const databases = await import("@/server/databases");
const workspaces = await import("@/server/workspaces");
const teamspaces = await import("@/server/teamspaces");
const groups = await import("@/server/groups");
const permissions = await import("@/server/permissions");
const propertyAccess = await import("@/server/property-access");
const comments = await import("@/server/comments");
const files = await import("@/server/files");
const templates = await import("@/server/templates");
const tokens = await import("@/server/api/tokens");
const automations = await import("@/server/automations/manage");
const mentions = await import("@/server/mentions");
const pageMeta = await import("@/server/page-meta");
const publication = await import("@/server/publication");
const notifications = await import("@/server/notifications");
const { readPageStyle, writePageStyle } = await import("@/lib/page-style");
const { auth } = await import("@/lib/auth");
const Y = await import("yjs");

// The real collab service: bodies get a Yjs document, stored Markdown and text, links and history,
// exactly as the old server saved them.
const { hocuspocus, service } = createCollab();
registerCollab(service);

const started = Date.now();
const step = (label: string) => console.log(`seed  ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);

const OWNER_PASSWORD = "upgrade-owner-password-1";
const people = {
  owner: { id: "upgrade-owner", name: "Ada Owner", email: "ada.owner@upgrade.test" },
  member: { id: "upgrade-member", name: "Ben Member", email: "ben.member@upgrade.test" },
  guest: { id: "upgrade-guest", name: "Cem Guest", email: "cem.guest@upgrade.test" },
  former: { id: "upgrade-former", name: "Dora Former", email: "dora.former@upgrade.test" },
};
const owner = { userId: people.owner.id };
const ben = { userId: people.member.id };

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** Plain JSON: dates as ISO strings, functions and undefined left out. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null));

/** A read of the old release, by name and arguments, with what it returned (or the error code it threw). */
type Read = { kind: string; args: unknown[]; result?: unknown; error?: string };
const reads: Read[] = [];
async function read(kind: string, args: unknown[], fn: () => Promise<unknown>) {
  try {
    reads.push({ kind, args, result: plain(await fn()) });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    reads.push({ kind, args, error: typeof code === "string" ? code : (error as Error).name || "Error" });
  }
}

// A 1×1 PNG and a small text file, uploaded through uploadFile.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const NOTES = Buffer.from("Upgrade notes\n\nThe zeppelin leaves at noon; bring the quokka.\n", "utf8");
const BRIEF = Buffer.from("Project brief: relaunch the website before the holidays.\n", "utf8");

async function upload(userId: string, pageId: string, name: string, contentType: string, body: Buffer) {
  return files.uploadFile(userId, pageId, { name, contentType, body: Readable.from([body]), declaredSize: body.length });
}

try {
  const empty = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${schema.user}`);
  if (Number(empty[0]?.n) !== 0) throw new Error("The database already has users: the upgrade test needs an empty one");

  // ----- People, the workspace and its spaces
  await db.insert(schema.user).values(
    Object.values(people).map((p) => ({ id: p.id, name: p.name, email: p.email, emailVerified: true })),
  );
  await db.insert(schema.account).values({
    id: `${people.owner.id}-credential`,
    accountId: people.owner.id,
    providerId: "credential",
    userId: people.owner.id,
    password: await hashPassword(OWNER_PASSWORD),
  });
  // A sign-in provider's account as it was stored before 0055, tokens and all (that migration
  // clears them on purpose). Social sign-in can't run offline, so the row goes in directly.
  await db.insert(schema.account).values({
    id: `${people.member.id}-github`,
    accountId: "4242",
    providerId: "github",
    userId: people.member.id,
    accessToken: "gho_upgradeTestAccessToken",
    refreshToken: "ghr_upgradeTestRefreshToken",
    scope: "read:user,user:email",
  });

  const ws = await workspaces.createWorkspace(people.owner.id, "Upgrade Co");
  const workspaceId = ws.id;
  for (const p of [people.member, people.former]) {
    const added = await workspaces.addMemberAs(people.owner.id, workspaceId, p.email, "member");
    if (added.kind !== "added") throw new Error(`${p.name} was not added: ${added.kind}`);
  }
  await workspaces.addGuest(people.owner.id, workspaceId, people.guest.id, people.guest.email);
  await workspaces.updateWorkspaceSettings(people.owner.id, workspaceId, {
    trashRetentionDays: 0,
    guestInvites: "members",
    memberInvites: "members_with_approval",
  });
  const generalId = await teamspaces.defaultTeamspaceId(workspaceId);
  if (!generalId) throw new Error("createWorkspace made no default teamspace");
  const reviewers = await groups.createGroup(people.owner.id, workspaceId, "Reviewers", [people.member.id, people.former.id]);
  const engineering = await teamspaces.createTeamspace(people.owner.id, workspaceId, {
    name: "Engineering",
    icon: "🛠️",
    description: "Systems, runbooks and architecture",
    access: "closed",
    memberLevel: "edit",
  });
  await teamspaces.addTeamspaceMembers(people.owner.id, engineering.id, [people.member.id, people.former.id]);
  await teamspaces.addTeamspaceGroups(people.owner.id, engineering.id, [reviewers.id]);
  step("people, workspace, teamspace, group");

  // ----- Pages (bodies come after, so links between them resolve)
  const make = (title: string, extra: Record<string, unknown> = {}, actor = owner) =>
    pages.createPage(actor, { workspaceId, title, ...extra });
  const handbook = await make("Handbook", { icon: "📘", teamspaceId: generalId });
  const onboarding = await make("Onboarding", { parentId: handbook.id, icon: "👋" });
  const policies = await make("Policies", { parentId: handbook.id });
  const travel = await make("Travel policy", { parentId: policies.id, icon: "✈️" });
  const roadmap = await make("Roadmap", { icon: "🗺️", teamspaceId: generalId });
  const meeting = await make("Meeting notes", { teamspaceId: generalId });
  const spec = await make("Locked spec", { icon: "🔒", teamspaceId: generalId });
  const draft = await make("Old draft", { teamspaceId: generalId });
  const appendix = await make("Old draft appendix", { parentId: draft.id });
  const plan = await make("Q4 Plan", { icon: "🎯", teamspaceId: generalId });
  const privateNotes = await make("Ada's private notes", { teamspaceId: null });
  const architecture = await make("Architecture", { icon: "🏛️", teamspaceId: engineering.id });
  const runbook = await make("Runbook", { parentId: architecture.id });
  const bens = await make("Ben's notes", { teamspaceId: generalId }, ben);
  const projects = await make("Projects", { kind: "database", icon: "📊", teamspaceId: generalId });
  const tasks = await make("Tasks", { kind: "database", icon: "✅", teamspaceId: generalId });
  step("pages");

  // ----- Files (the body below shows them)
  const notesFile = await upload(people.owner.id, handbook.id, "upgrade-notes.txt", "text/plain", NOTES);
  const pixelFile = await upload(people.owner.id, handbook.id, "pixel.png", "image/png", PIXEL);

  // ----- Bodies
  const link = (text: string, pageId: string) => `[${text}](/w/${workspaceId}/p/${pageId})`;
  const write = (pageId: string, markdown: string, actor = owner, snapshot = false) =>
    getCollab().replaceContent(pageId, markdown, actor, snapshot);
  await write(
    handbook.id,
    [
      "# Welcome to the handbook",
      "",
      `This handbook explains how **Upgrade Co** works. Read the ${link("roadmap", roadmap.id)} first, then ask @Ben Member about anything unclear. Next review on @2026-11-02.`,
      "",
      "## Lists",
      "",
      "- A bullet with *emphasis*, ~~a strike~~ and `inline code`",
      "- A second bullet",
      "    - A nested bullet",
      "",
      "1. First step",
      "2. Second step",
      "",
      "- [ ] Write the welcome mail",
      "- [x] Order the laptops",
      "",
      "## Code",
      "",
      "```ts",
      "export function greet(name: string) {",
      "  return `Hello, ${name}!`;",
      "}",
      "```",
      "",
      "> The zeppelin leaves at noon.",
      "",
      "| Team | Lead | Size |",
      "| --- | --- | --- |",
      "| Engineering | Ada | 4 |",
      "| Design | Ben | 2 |",
      "",
      "> [!NOTE]",
      "> 💡 Callouts keep their kind and their icon.",
      "",
      "$$",
      "E = mc^2",
      "$$",
      "",
      `![pixel](/api/files/${pixelFile.id})`,
      "",
      `Attachment: [upgrade-notes.txt](/api/files/${notesFile.id})`,
      "",
      `${link("Projects", projects.id)} <!-- leafdesk:page-link -->`,
    ].join("\n"),
  );
  await write(
    onboarding.id,
    [
      "# Day one",
      "",
      "- [ ] Meet @Ada Owner",
      "- [ ] Read [[Travel policy]] before booking anything",
      "- [x] Get a badge",
      "",
      `Questions go to the ${link("handbook", handbook.id)}.`,
    ].join("\n"),
  );
  await write(policies.id, "Every policy lives under this page.\n\n- Travel\n- Expenses\n- Security");
  await write(
    travel.id,
    [
      "## Booking",
      "",
      "Book trains when the trip takes under four hours.",
      "",
      "| Trip | Class |",
      "| --- | --- |",
      "| Train | Second |",
      "| Flight | Economy |",
    ].join("\n"),
  );
  await write(
    roadmap.id,
    [
      "# Roadmap 2027",
      "",
      `The quokka initiative ships in Q1. See the ${link("handbook", handbook.id)} and [[Travel policy]].`,
      "",
      "## Q1",
      "",
      "- Launch the quokka beta",
      "- Hire two engineers",
      "",
      "## Q2",
      "",
      "1. Expand to Istanbul",
      "2. Open the Berlin office",
    ].join("\n"),
  );
  await write(spec.id, "# Spec\n\nThe API answers in JSON. Nobody edits this page by accident.");
  await write(draft.id, "An idea we dropped: a zeppelin delivery service.");
  await write(appendix.id, "Numbers for the dropped idea.");
  await write(plan.id, "# Q4 targets\n\n- Revenue up 20%\n- Two new hires\n\nShared with a few people only.");
  await write(privateNotes.id, "Only Ada sees this. Budget thoughts for next year.");
  await write(
    architecture.id,
    [
      "# Architecture",
      "",
      "```sql",
      "select id, title from page where archived_at is null;",
      "```",
      "",
      `Operations live in the ${link("runbook", runbook.id)}.`,
    ].join("\n"),
  );
  await write(runbook.id, "1. Check the health endpoint\n2. Restart the worker\n3. Page the on-call engineer");
  await write(bens.id, "Ben's scratchpad: follow up on the budget review with @Ada Owner.", ben);
  step("bodies");

  // ----- History: written, rewritten with a snapshot, saved by hand, restored
  await write(meeting.id, "# Weekly sync\n\nAgenda: budget review.");
  await write(meeting.id, "# Weekly sync\n\nAgenda: budget review.\n\nDecision: approve the budget.", owner, true);
  await getCollab().snapshot(meeting.id, "manual", owner);
  await write(meeting.id, "# Weekly sync\n\nAgenda: budget review.\n\nDecision: postpone.", owner, true);
  const meetingHistory = await pages.listSnapshots(people.owner.id, meeting.id);
  const rewrite = meetingHistory.filter((s) => s.reason === "before_mcp_write").at(-1);
  if (!rewrite) throw new Error("rewriting with a snapshot left no history version");
  await pages.restoreSnapshot(owner, rewrite.id);
  await getCollab().snapshot(handbook.id, "manual", owner);
  step("history");

  // ----- Page details: icon, background, lock, trash, favorites, publication
  await pages.setPageIcon(people.owner.id, meeting.id, "🗓️");
  await pages.setPageBackground(people.owner.id, handbook.id, { color: "blue", pattern: "dots" });
  await pages.setPageBackground(people.owner.id, roadmap.id, { color: "green", pattern: null });
  // Typeface, text size and width live in the page's document, which the browser writes; the
  // server has no call for it, so this edits the document the way an open editor does.
  const styled = await hocuspocus.openDirectConnection(`page:${travel.id}`, { userId: people.owner.id });
  try {
    writePageStyle(styled.document!, { font: "serif", smallText: true, fullWidth: true });
  } finally {
    await styled.disconnect();
  }
  await pages.setPageLocked(people.owner.id, spec.id, true);
  await pages.archivePage(people.owner.id, draft.id);
  await pageMeta.setFavorite(people.owner.id, handbook.id, true);
  await pageMeta.setFavorite(people.member.id, roadmap.id, true);
  await publication.publishPage(people.owner.id, roadmap.id);
  step("page details");

  // ----- Databases: properties
  const props = async (databaseId: string) => (await databases.getDatabase(people.owner.id, databaseId)).properties;
  const option = (prop: { options: { options?: { id: string; name: string }[] } }, name: string) => {
    const found = prop.options.options?.find((o) => o.name === name);
    if (!found) throw new Error(`no option ${name}`);
    return found.id;
  };
  const add = (databaseId: string, input: Record<string, unknown>) =>
    databases.addProperty(people.owner.id, databaseId, input as Parameters<typeof databases.addProperty>[2]);

  const taskStatus = (await props(tasks.id)).find((p) => p.type === "status")!;
  const taskTags = (await props(tasks.id)).find((p) => p.type === "multi_select")!;
  await databases.ensureOption(people.owner.id, taskTags.id, "bug");
  await databases.ensureOption(people.owner.id, taskTags.id, "feature");
  const hours = await add(tasks.id, { name: "Hours", type: "number", number: { format: "number", decimals: 1 } });
  const due = await add(tasks.id, { name: "Due", type: "date" });
  const assignee = await add(tasks.id, { name: "Assignee", type: "person" });
  const done = await add(tasks.id, { name: "Done", type: "checkbox" });
  const effort = await add(tasks.id, { name: "Effort", type: "select", options: ["S", "M", "L"] });
  const internal = await add(tasks.id, { name: "Internal note", type: "text" });
  const blockedBy = await databases.setDependencies(people.owner.id, tasks.id, {
    on: true,
    names: { blockedBy: "Blocked by", blocking: "Blocking" },
    settings: { shift: "keep_gap", skipWeekends: true },
  });

  const status = (await props(projects.id)).find((p) => p.type === "status")!;
  const priority = await add(projects.id, { name: "Priority", type: "select", options: ["High", "Medium", "Low"] });
  const labels = await add(projects.id, { name: "Labels", type: "multi_select", options: ["frontend", "backend", "design", "infra"] });
  const budget = await add(projects.id, { name: "Budget", type: "number", number: { format: "currency", currency: "EUR" } });
  await add(projects.id, { name: "Progress", type: "number", number: { format: "percent" } });
  const start = await add(projects.id, { name: "Start", type: "date" });
  const end = await add(projects.id, { name: "End", type: "date" });
  const lead = await add(projects.id, { name: "Lead", type: "person" });
  const approved = await add(projects.id, { name: "Approved", type: "checkbox" });
  await add(projects.id, { name: "Website", type: "url" });
  const contact = await add(projects.id, { name: "Contact", type: "email" });
  const phone = await add(projects.id, { name: "Phone", type: "phone" });
  const notes = await add(projects.id, { name: "Notes", type: "text" });
  await add(projects.id, { name: "Steps", type: "checklist" });
  const attachments = await add(projects.id, { name: "Attachments", type: "files" });
  const taskLinks = await add(projects.id, {
    name: "Tasks",
    type: "relation",
    relation: { databaseId: tasks.id, twoWay: true, pairedName: "Project" },
  });
  await add(projects.id, {
    name: "Task count",
    type: "rollup",
    rollup: { relationPropertyId: taskLinks.id, targetPropertyId: "title", function: "count_all" },
  });
  await add(projects.id, {
    name: "Total hours",
    type: "rollup",
    rollup: { relationPropertyId: taskLinks.id, targetPropertyId: hours.id, function: "sum" },
  });
  await add(projects.id, {
    name: "Latest due",
    type: "rollup",
    rollup: { relationPropertyId: taskLinks.id, targetPropertyId: due.id, function: "latest_date" },
  });
  await add(projects.id, { name: "Budget with VAT", type: "formula", formula: { expression: 'prop("Budget") * 1.2' } });
  await add(projects.id, {
    name: "Headline",
    type: "formula",
    formula: { expression: 'upper(prop("title")) + if(prop("Approved"), " ✓", "")' },
  });
  await add(projects.id, { name: "Created by", type: "created_by" });
  await add(projects.id, { name: "Created", type: "created_time" });
  await add(projects.id, { name: "Edited by", type: "last_edited_by" });
  await add(projects.id, { name: "Edited", type: "last_edited_time" });
  const parentProject = await databases.setSubItems(people.owner.id, projects.id, {
    on: true,
    names: { parent: "Parent project", subItems: "Sub-projects" },
  });
  step("properties");

  // ----- Rows
  const projectRows = await databases.createRows(people.owner.id, projects.id, [
    { title: "Website relaunch", properties: { Status: "In progress", Priority: "High", Labels: ["frontend", "design"], Budget: 48000, Progress: 0.4, Start: "2026-09-01", End: "2026-12-15", Lead: [people.member.id], Approved: true, Website: "https://example.com/relaunch", Contact: "web@example.com", Phone: "+90 212 555 0101", Notes: "Zeppelin-themed landing page", Steps: [{ text: "Brief", checked: true }, { text: "Design", checked: false }] } },
    { title: "Mobile app", properties: { Status: "Not started", Priority: "High", Labels: ["frontend"], Budget: 120000, Progress: 0, Start: "2027-01-10", End: "2027-06-30", Lead: [people.owner.id], Approved: false, Notes: "Native shells around the web app" } },
    { title: "Data warehouse", properties: { Status: "In progress", Priority: "Medium", Labels: ["backend", "infra"], Budget: 75000, Progress: 0.65, Start: "2026-06-01", End: "2026-11-30", Lead: [people.member.id], Approved: true, Contact: "data@example.com" } },
    { title: "Brand refresh", properties: { Status: "Done", Priority: "Low", Labels: ["design"], Budget: 18000, Progress: 1, Start: "2026-03-01", End: "2026-05-31", Lead: [people.owner.id], Approved: true, Website: "https://example.com/brand" } },
    { title: "Office move", properties: { Status: "Done", Priority: "Medium", Budget: 32000, Progress: 1, Start: "2026-02-01", End: "2026-04-15", Approved: true, Phone: "+49 30 555 0199" } },
    { title: "Security audit", properties: { Status: "In progress", Priority: "High", Labels: ["infra"], Budget: 26000, Progress: 0.3, Start: "2026-10-01", End: "2026-10-31", Lead: [people.owner.id, people.member.id], Approved: true } },
    { title: "Customer portal", properties: { Status: "Not started", Priority: "Medium", Labels: ["frontend", "backend"], Budget: 64000, Start: "2027-02-01", Notes: "Depends on the data warehouse" } },
    { title: "Hiring drive", properties: { Status: "In progress", Priority: "Low", Budget: 12000, Progress: 0.5, Start: "2026-09-15", End: "2027-01-31", Lead: [people.member.id] } },
    { title: "Quokka beta", properties: { Status: "Not started", Priority: "High", Labels: ["frontend", "backend", "design"], Budget: 90000, Start: "2027-01-05", End: "2027-03-31", Notes: "The quokka initiative" } },
    { title: "Support tooling", properties: { Status: "Done", Priority: "Low", Labels: ["backend"], Budget: 8000, Progress: 1, Approved: true } },
    { title: "Partner API", properties: { Status: "Not started", Priority: "Medium", Labels: ["backend"], Budget: 41000, Start: "2027-04-01", End: "2027-07-31" } },
    { title: "Analytics dashboard", properties: { Status: "In progress", Priority: "Medium", Labels: ["frontend", "infra"], Budget: 23000, Progress: 0.8, Start: "2026-08-01", End: "2026-11-15", Approved: true } },
    { title: "Localization", properties: { Status: "Not started", Priority: "Low", Labels: ["frontend"], Budget: 15000, Start: "2027-03-01", Notes: "Turkish and German first" } },
    { title: "Backup strategy", properties: { Status: "Done", Priority: "High", Labels: ["infra"], Budget: 5000, Progress: 1, Start: "2026-01-10", End: "2026-02-10", Approved: true } },
  ]);
  const projectId = (title: string) => projectRows.find((r) => r.title === title)!.id;
  // A row with a body, made like one from the "New" button.
  const kickoff = await pages.createPage(owner, {
    workspaceId,
    parentId: projects.id,
    title: "Kickoff week",
    properties: { Status: "Not started", Priority: "Low", Budget: 2500, Start: "2026-11-02", End: "2026-11-06" },
    markdown: `## Agenda\n\n- Welcome\n- Tour of the ${link("handbook", handbook.id)}\n\n- [ ] Book the room`,
  });

  const taskSpecs: [string, Record<string, unknown>][] = [
    ["Design the landing page", { Status: "In progress", Hours: 12, Due: "2026-10-20", Assignee: [people.member.id], Effort: "M", Tags: ["feature"], Project: [projectId("Website relaunch")] }],
    ["Write the copy", { Status: "Not started", Hours: 6, Due: "2026-10-25", Assignee: [people.owner.id], Effort: "S", Project: [projectId("Website relaunch")] }],
    ["Set up analytics", { Status: "Done", Hours: 3, Due: "2026-09-30", Assignee: [people.member.id], Done: true, Effort: "S", Project: [projectId("Website relaunch"), projectId("Analytics dashboard")] }],
    ["Fix the contact form", { Status: "Done", Hours: 2.5, Due: "2026-09-12", Assignee: [people.member.id], Done: true, Effort: "S", Tags: ["bug"], Project: [projectId("Website relaunch")], "Internal note": "Spam filter was too strict" }],
    ["Pick a mobile framework", { Status: "Not started", Hours: 8, Due: "2027-01-20", Assignee: [people.owner.id], Effort: "M", Project: [projectId("Mobile app")] }],
    ["Model the sales tables", { Status: "In progress", Hours: 20, Due: "2026-11-10", Assignee: [people.member.id], Effort: "L", Project: [projectId("Data warehouse")] }],
    ["Nightly import job", { Status: "Not started", Hours: 10, Due: "2026-11-20", Effort: "M", Tags: ["feature"], Project: [projectId("Data warehouse")] }],
    ["New logo files", { Status: "Done", Hours: 4, Due: "2026-04-01", Assignee: [people.owner.id], Done: true, Effort: "S", Project: [projectId("Brand refresh")] }],
    ["Pack the archive", { Status: "Done", Hours: 16, Due: "2026-03-20", Done: true, Effort: "L", Project: [projectId("Office move")] }],
    ["Review firewall rules", { Status: "In progress", Hours: 5, Due: "2026-10-18", Assignee: [people.owner.id], Effort: "M", Tags: ["bug"], Project: [projectId("Security audit")], "Internal note": "Two rules are wide open" }],
    ["Rotate the secrets", { Status: "Not started", Hours: 3, Due: "2026-10-28", Assignee: [people.member.id], Effort: "S", Project: [projectId("Security audit")] }],
    ["Sketch the portal", { Status: "Not started", Hours: 7, Due: "2027-02-15", Effort: "M", Project: [projectId("Customer portal")] }],
    ["Post the job ads", { Status: "Done", Hours: 2, Due: "2026-09-20", Assignee: [people.member.id], Done: true, Effort: "S", Project: [projectId("Hiring drive")] }],
    ["Interview round one", { Status: "In progress", Hours: 14, Due: "2026-11-05", Assignee: [people.owner.id, people.member.id], Effort: "L", Project: [projectId("Hiring drive")] }],
    ["Quokka beta signup page", { Status: "Not started", Hours: 9, Due: "2027-01-12", Effort: "M", Tags: ["feature"], Project: [projectId("Quokka beta")] }],
    ["Support macros", { Status: "Done", Hours: 6, Due: "2026-07-01", Done: true, Effort: "M", Project: [projectId("Support tooling")] }],
    ["Partner API draft", { Status: "Not started", Hours: 12, Due: "2027-04-15", Effort: "L", Project: [projectId("Partner API")] }],
    ["Dashboard filters", { Status: "In progress", Hours: 8, Due: "2026-10-30", Assignee: [people.member.id], Effort: "M", Project: [projectId("Analytics dashboard")] }],
    ["Translate the menus", { Status: "Not started", Hours: 5, Due: "2027-03-10", Effort: "S", Project: [projectId("Localization")] }],
    ["Test a restore", { Status: "Done", Hours: 4, Due: "2026-02-05", Assignee: [people.owner.id], Done: true, Effort: "S", Project: [projectId("Backup strategy")] }],
    ["Order the snacks", { Status: "Not started", Hours: 1, Due: "2026-11-02", Effort: "S", Project: [kickoff.id] }],
    ["Plan the week", { Status: "In progress", Hours: 3, Due: "2026-10-27", Assignee: [people.owner.id], Effort: "S", Project: [kickoff.id] }],
    ["Unassigned chore", { Status: "Not started", Effort: "S" }],
  ];
  const taskRows = await databases.createRows(
    people.owner.id,
    tasks.id,
    taskSpecs.map(([title, properties]) => ({ title, properties })),
  );
  const taskId = (title: string) => taskRows.find((r) => r.title === title)!.id;
  // Rows with bodies, by the member.
  await pages.createPage(ben, {
    workspaceId,
    parentId: tasks.id,
    title: "Login button misaligned",
    properties: { Status: "Not started", Hours: 1.5, Due: "2026-10-22", Assignee: [people.member.id], Effort: "S", Tags: ["bug"] },
    markdown: `Steps: open the ${link("handbook", handbook.id)} on a phone and look at the header.\n\n- [ ] Reproduce on Safari`,
  });
  await pages.createPage(ben, {
    workspaceId,
    parentId: tasks.id,
    title: "Write release notes",
    properties: { Status: "In progress", Hours: 2, Due: "2026-10-24", Assignee: [people.member.id], Effort: "S" },
    markdown: "Draft in the shared folder; mention the zeppelin.",
  });

  // Sub-projects, dependencies, files, and edits after creation.
  const parentProp = parentProject!;
  await databases.updateRowProperties(people.owner.id, projectId("Quokka beta"), { [parentProp.id]: [projectId("Mobile app")] });
  await databases.updateRowProperties(people.owner.id, projectId("Customer portal"), { [parentProp.id]: [projectId("Data warehouse")] });
  await databases.updateRowProperties(people.owner.id, kickoff.id, { [parentProp.id]: [projectId("Hiring drive")] });
  const blockedProp = blockedBy!;
  await databases.updateRowProperties(people.owner.id, taskId("Write the copy"), { [blockedProp.id]: [taskId("Design the landing page")] });
  await databases.updateRowProperties(people.owner.id, taskId("Nightly import job"), { [blockedProp.id]: [taskId("Model the sales tables")] });
  await databases.updateRowProperties(people.owner.id, taskId("Rotate the secrets"), {
    [blockedProp.id]: [taskId("Review firewall rules")],
  });
  const briefFile = await upload(people.owner.id, projectId("Website relaunch"), "brief.txt", "text/plain", BRIEF);
  const coverFile = await upload(people.owner.id, projectId("Website relaunch"), "cover.png", "image/png", PIXEL);
  await databases.updateRowProperties(people.owner.id, projectId("Website relaunch"), {
    [attachments.id]: [{ url: `/api/files/${briefFile.id}` }, { url: `/api/files/${coverFile.id}` }],
  });
  await databases.updateRowProperties(people.member.id, taskId("Dashboard filters"), { [hours.id]: 9.5, [taskStatus.id]: "Done", [done.id]: true });
  await pages.renamePage(owner, projectId("Support tooling"), "Support tooling v2");
  await pages.setPageIcon(people.owner.id, projectId("Website relaunch"), "🌐");
  step("rows");

  // ----- Views
  const view = async (databaseId: string, name: string, type: string, config: Record<string, unknown>) => {
    const created = await databases.addView(people.owner.id, databaseId, { name, type } as never);
    await databases.updateView(people.owner.id, created.id, { config } as never);
    return created;
  };
  const projectsTable = (await databases.getDatabase(people.owner.id, projects.id)).views[0];
  await databases.updateView(people.owner.id, projectsTable.id, {
    config: {
      sorts: [{ propertyId: budget.id, direction: "desc" }],
      hidden: [phone.id, contact.id],
      calculations: { [budget.id]: "sum", title: "count_all" },
      columnWidths: { title: 280, [notes.id]: 320 },
      wrapped: [notes.id],
      frozenThrough: "title",
      subItems: "nested",
    },
  } as never);
  const doneOption = option(status, "Done");
  await view(projects.id, "Active", "table", {
    filters: [{ propertyId: status.id, op: "not_equals", value: doneOption }],
    sorts: [{ propertyId: start.id, direction: "asc" }],
    groupBy: priority.id,
    subItems: "flat",
  });
  await view(projects.id, "Board", "board", { groupBy: status.id, sorts: [{ propertyId: "title", direction: "asc" }] });
  await view(projects.id, "Calendar", "calendar", { dateBy: start.id });
  await view(projects.id, "Timeline", "timeline", { dateBy: start.id, endDateBy: end.id, zoom: "month", groupBy: priority.id });
  await view(projects.id, "Gallery", "gallery", { cardSize: "large", cover: { source: "property", propertyId: attachments.id } });
  await view(projects.id, "Focus", "list", {
    filterCombinator: "or",
    filters: [
      { propertyId: priority.id, op: "equals", value: option(priority, "High") },
      {
        type: "group",
        combinator: "and",
        rules: [
          { propertyId: labels.id, op: "contains", value: option(labels, "design") },
          { propertyId: approved.id, op: "equals", value: true },
        ],
      },
    ],
    sorts: [{ propertyId: "title", direction: "asc" }],
  });
  await view(projects.id, "Budget by priority", "chart", {
    chartType: "bar",
    groupBy: priority.id,
    chartAggregate: { fn: "sum", propertyId: budget.id },
    showValues: true,
  });
  await view(projects.id, "Big budgets", "table", {
    filters: [{ propertyId: budget.id, op: "gt", value: 30000 }],
    sorts: [{ propertyId: lead.id, direction: "asc" }, { propertyId: "title", direction: "desc" }],
    groupBy: status.id,
    groupStatusBy: "group",
  });
  await view(projects.id, "Intake form", "form", {
    form: {
      title: "Propose a project",
      description: "Tell us what you want to build.",
      questions: [
        { propertyId: "title", required: true, label: "Project name" },
        { propertyId: priority.id },
        { propertyId: notes.id, label: "Why?", description: "One or two sentences" },
      ],
      defaults: { [status.id]: "Not started" },
      confirmation: "Thanks, we'll look at it on Monday.",
    },
  });
  const tasksTable = (await databases.getDatabase(people.owner.id, tasks.id)).views[0];
  await databases.updateView(people.owner.id, tasksTable.id, {
    config: { sorts: [{ propertyId: due.id, direction: "asc" }, { propertyId: "title", direction: "asc" }], calculations: { [hours.id]: "sum" } },
  } as never);
  await view(tasks.id, "Mine", "table", {
    filters: [{ propertyId: assignee.id, op: "contains", value: "me" }],
    sorts: [{ propertyId: due.id, direction: "desc" }],
  });
  await view(tasks.id, "Board", "board", { groupBy: taskStatus.id, groupStatusBy: "group", hideEmptyGroups: true });
  await view(tasks.id, "Schedule", "timeline", { dateBy: due.id, zoom: "week", showTable: false });
  await view(tasks.id, "By effort", "table", {
    groupBy: effort.id,
    sorts: [{ propertyId: hours.id, direction: "desc" }],
    filters: [{ propertyId: hours.id, op: "gt", value: 2 }],
    collapsedGroups: [option(effort, "L")],
  });
  await view(tasks.id, "Calendar", "calendar", { dateBy: due.id });
  await view(tasks.id, "Open bugs", "list", {
    filters: [
      { propertyId: taskTags.id, op: "contains", value: option((await props(tasks.id)).find((p) => p.id === taskTags.id)!, "bug") },
      { propertyId: taskStatus.id, op: "not_equals", value: option(taskStatus, "Done") },
    ],
  });
  step("views");

  // ----- Row templates and a workspace template
  const bugTemplate = await templates.createRowTemplate(owner, tasks.id, {
    title: "Bug report",
    properties: { Effort: "S", Tags: ["bug"], Status: "Not started" },
    markdown: "## Steps to reproduce\n\n1. Open the page\n\n## Expected\n\nIt works.",
  });
  await templates.setDefaultRowTemplate(people.owner.id, tasks.id, bugTemplate.id);
  await templates.saveAsTemplate(owner, roadmap.id);
  await templates.saveAsTemplate(owner, projectId("Brand refresh"));
  step("templates");

  // ----- Sharing: page, group and property permissions (the former member's are kept by v0.5.0)
  await permissions.setPagePermission(people.owner.id, plan.id, people.owner.id, "full");
  await permissions.setPagePermission(people.owner.id, plan.id, null, "none");
  await permissions.setPagePermission(people.owner.id, plan.id, people.member.id, "edit");
  await permissions.setPagePermission(people.owner.id, plan.id, people.guest.id, "comment");
  await permissions.setPagePermission(people.owner.id, plan.id, people.former.id, "view");
  await permissions.setPageGroupPermission(people.owner.id, plan.id, reviewers.id, "comment");
  await permissions.setPagePermission(people.owner.id, projects.id, people.guest.id, "view");
  await permissions.setPagePermission(people.owner.id, tasks.id, people.former.id, "edit");
  await permissions.setPagePermission(people.owner.id, roadmap.id, people.guest.id, "view");
  await permissions.setPageGroupPermission(people.owner.id, architecture.id, reviewers.id, "full");
  await propertyAccess.setPropertyAccess(people.owner.id, hours.id, {
    everyone: "view",
    exceptions: [
      { userId: people.member.id, level: "edit" },
      { userId: people.former.id, level: "edit" },
      { groupId: reviewers.id, level: "edit_values" },
      { personPropertyId: assignee.id, level: "edit_values" },
    ],
  });
  await propertyAccess.setPropertyAccess(people.owner.id, internal.id, {
    everyone: "none",
    exceptions: [{ userId: people.member.id, level: "view" }],
  });
  await propertyAccess.setPropertyAccess(people.owner.id, budget.id, { everyone: "view_property", exceptions: [{ groupId: reviewers.id, level: "view" }] });
  step("permissions");

  // ----- Comments
  const thread = await comments.changeComments(people.owner.id, handbook.id, {
    type: "createThread",
    body: "Is this section still accurate?",
    anchor: { quote: "explains how" },
  });
  if (!thread.anchored) throw new Error("the handbook thread wasn't anchored");
  const reply = await comments.changeComments(people.member.id, handbook.id, {
    type: "addComment",
    threadId: thread.thread!.id,
    body: [{ type: "paragraph", content: [{ type: "text", text: "Yes, ", styles: {} }, { type: "text", text: "updated last week", styles: { bold: true } }, "."] }],
  });
  await comments.changeComments(people.owner.id, handbook.id, {
    type: "addReaction",
    threadId: thread.thread!.id,
    commentId: reply.comment!.id,
    emoji: "👍",
  });
  const pageThread = await comments.changeComments(people.member.id, handbook.id, {
    type: "createThread",
    body: [{ type: "paragraph", content: ["Please add a ", { type: "link", href: "https://example.com/style", content: "style guide" }, " link."] }],
  });
  await comments.changeComments(people.owner.id, handbook.id, { type: "resolveThread", threadId: pageThread.thread!.id });
  await comments.changeComments(people.guest.id, plan.id, { type: "createThread", body: "Looks good to me.", anchor: { quote: "Q4 targets" } });
  await comments.changeComments(people.owner.id, projectId("Website relaunch"), { type: "createThread", body: "Kickoff moved to Monday." });
  step("comments");

  // ----- API tokens, then the former member leaves
  const ownerToken = await tokens.createApiToken(people.owner.id, { name: "Owner automation", scopes: ["pages:read", "pages:write"] });
  await tokens.createApiToken(people.member.id, { name: "Ben's integration", scopes: ["pages:write"], workspaceId, expiresInDays: 365 });
  const formerToken = await tokens.createApiToken(people.former.id, { name: "Dora's sync", scopes: ["pages:read"], workspaceId });
  await workspaces.removeMember(people.owner.id, workspaceId, people.former.id);
  // What 0056 is meant to clear: v0.5.0 keeps it all after the person left.
  const formerGrants = {
    pagePermissionIds: (
      await db.select({ id: schema.pagePermission.id }).from(schema.pagePermission).where(eq(schema.pagePermission.userId, people.former.id))
    ).map((r) => r.id),
    propertyPermissionIds: (
      await db
        .select({ id: schema.propertyPermission.id })
        .from(schema.propertyPermission)
        .where(eq(schema.propertyPermission.userId, people.former.id))
    ).map((r) => r.id),
    apiTokenIds: [formerToken.token.id],
  };
  if (formerGrants.pagePermissionIds.length !== 2 || formerGrants.propertyPermissionIds.length !== 1) {
    throw new Error(`the former member's grants should outlive their membership in v0.5.0: ${JSON.stringify(formerGrants)}`);
  }
  const [stillToken] = await db.select({ id: schema.apiToken.id }).from(schema.apiToken).where(eq(schema.apiToken.id, formerToken.token.id));
  if (!stillToken) throw new Error("the former member's API token should outlive their membership in v0.5.0");
  step("tokens and a departure");

  // A browser session from before the upgrade: whoever was signed in stays signed in.
  const signedIn = await auth.api.signInEmail({ body: { email: people.owner.email, password: OWNER_PASSWORD }, asResponse: true });
  const sessionCookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!signedIn.ok || !sessionCookie) throw new Error(`signing in failed (${signedIn.status})`);
  const session = await auth.api.getSession({ headers: new Headers({ cookie: sessionCookie }) });
  if (session?.user.id !== people.owner.id) throw new Error("the new session doesn't sign the owner in");
  step("a session");

  // ----- Automations, last: no row write after them, so nothing is queued and the webhook is never called
  const tasksProps = await props(tasks.id);
  await automations.createAutomation(people.owner.id, tasks.id, {
    name: "Close finished tasks",
    trigger: { type: "property_changed", property: taskStatus.id, to: "Done" },
    actions: [
      { type: "set_properties", values: { [done.id]: true } },
      { type: "webhook", url: "https://hooks.example.invalid/leafdesk-upgrade" },
    ],
  });
  await automations.createAutomation(people.owner.id, tasks.id, {
    name: "Triage new tasks",
    trigger: { type: "row_created" },
    actions: [
      { type: "set_properties", values: { Effort: "M", [due.id]: { $: "now" } } },
      { type: "notify", people: [people.member.id], properties: [tasksProps.find((p) => p.id === assignee.id)!.name] },
    ],
  });
  await automations.createAutomation(people.owner.id, projects.id, {
    name: "Approval watch",
    enabled: false,
    trigger: { type: "property_changed", property: "Approved" },
    actions: [{ type: "notify", people: ["me"] }],
  });
  const queued = await db.select({ id: schema.automationRun.id }).from(schema.automationRun);
  if (queued.length) throw new Error(`automations queued ${queued.length} runs; the webhook must never be called`);
  step("automations");

  // ----- What v0.5.0 reads back
  const all = await db
    .select({ id: schema.page.id, title: schema.page.title, kind: schema.page.kind, parentId: schema.page.parentId })
    .from(schema.page)
    .where(eq(schema.page.workspaceId, workspaceId));
  const userIds = Object.values(people).map((p) => p.id);
  for (const p of all) {
    await read("readPage", [p.id], () => getCollab().readPage(p.id));
    await read("readBlocks", [p.id], () => getCollab().readBlocks(p.id));
    await read("listComments", [people.owner.id, p.id], () => comments.listComments(people.owner.id, p.id));
    await read("listSnapshots", [people.owner.id, p.id], () => pages.listSnapshots(people.owner.id, p.id));
    await read("listBacklinks", [people.owner.id, p.id], () => mentions.listBacklinks(people.owner.id, p.id));
    await read("listPagePermissions", [people.owner.id, p.id], () => permissions.listPagePermissions(people.owner.id, p.id));
    await read("getBreadcrumbs", [people.owner.id, p.id], () => pages.getBreadcrumbs(people.owner.id, p.id));
    await read("pageStyle", [p.id], async () => {
      const [row] = await db.select({ ydoc: schema.page.ydoc }).from(schema.page).where(eq(schema.page.id, p.id));
      const doc = new Y.Doc();
      if (row?.ydoc) Y.applyUpdate(doc, row.ydoc);
      return readPageStyle(doc);
    });
  }
  const access: { userId: string; pageId: string; level: string }[] = [];
  for (const userId of userIds) {
    for (const p of all) access.push({ userId, pageId: p.id, level: (await resolvePageAccess(userId, p.id)).level });
  }
  for (const s of await db.select({ id: schema.pageSnapshot.id }).from(schema.pageSnapshot)) {
    await read("getSnapshot", [people.owner.id, s.id], () => pages.getSnapshot(people.owner.id, s.id));
  }
  for (const databaseId of [projects.id, tasks.id]) {
    await read("getDatabase", [people.owner.id, databaseId], async () => {
      const { database, properties, views, propertyAccess: info } = await databases.getDatabase(people.owner.id, databaseId);
      return { database, properties, views, propertyAccess: info };
    });
    for (const userId of [people.owner.id, people.member.id, people.guest.id]) {
      await read("listRows", [userId, databaseId], () => databases.listRows(userId, databaseId));
    }
    const { views } = await databases.getDatabase(people.owner.id, databaseId);
    for (const v of views) {
      for (const userId of [people.owner.id, people.member.id]) {
        await read("listRowsInView", [userId, databaseId, v.id], async () =>
          (await databases.listRows(userId, databaseId, v.config)).map((r) => r.id),
        );
      }
    }
    await read("listAutomations", [people.owner.id, databaseId], () => automations.listAutomations(people.owner.id, databaseId));
    await read("listRowTemplates", [people.owner.id, databaseId], () => templates.listRowTemplates(people.owner.id, databaseId));
  }
  for (const prop of [hours, internal, budget]) {
    await read("getPropertyAccessSettings", [people.owner.id, prop.id], () => propertyAccess.getPropertyAccessSettings(people.owner.id, prop.id));
  }
  for (const userId of userIds) {
    await read("getTree", [userId, workspaceId], () => pages.getTree(userId, workspaceId));
    await read("listFavorites", [userId, workspaceId], () => pageMeta.listFavorites(userId, workspaceId));
    await read("listApiTokens", [userId], () => tokens.listApiTokens(userId));
  }
  await read("listTemplates", [people.owner.id, workspaceId], () => templates.listTemplates(people.owner.id, workspaceId));
  await read("listTrash", [people.owner.id, workspaceId], () => pages.listTrash(people.owner.id, workspaceId));
  await read("listTeamspaces", [people.owner.id, workspaceId], () => teamspaces.listTeamspaces(people.owner.id, workspaceId));
  for (const teamspaceId of [generalId, engineering.id]) {
    await read("listTeamspaceMembers", [people.owner.id, teamspaceId], () => teamspaces.listTeamspaceMembers(people.owner.id, teamspaceId));
    await read("listTeamspaceGroups", [people.owner.id, teamspaceId], () => teamspaces.listTeamspaceGroups(people.owner.id, teamspaceId));
  }
  await read("getSession", [sessionCookie], async () => (await auth.api.getSession({ headers: new Headers({ cookie: sessionCookie }) }))?.user.id ?? null);
  await read("listGroups", [people.owner.id, workspaceId], () => groups.listGroups(people.owner.id, workspaceId));
  await read("listMembers", [people.owner.id, workspaceId], () => workspaces.listMembers(people.owner.id, workspaceId));
  await read("getWorkspaceSettings", [people.owner.id, workspaceId], () => workspaces.getWorkspaceSettings(people.owner.id, workspaceId));
  await read("getPublication", [people.owner.id, roadmap.id], () => publication.getPublication(people.owner.id, roadmap.id));
  const published = await publication.getPublication(people.owner.id, roadmap.id);
  if (!published) throw new Error("the roadmap isn't published");
  await read("getPublishedPage", [published.token], () => publication.getPublishedPage(published.token));
  for (const userId of [people.owner.id, people.member.id, people.guest.id]) {
    await read("listNotifications", [userId, { workspaceId }], () => notifications.listNotifications(userId, { workspaceId }));
  }
  const queries = ["zeppelin", "quokka", "handbook", "architecture", "budget", "Istanbul"];
  for (const q of queries) {
    await read("searchPages", [people.owner.id, q, workspaceId], async () =>
      (await pages.searchPages(people.owner.id, q, { workspaceId })).map((h) => h.id),
    );
  }
  for (const userId of [people.member.id, people.guest.id]) {
    await read("searchPages", [userId, "budget", workspaceId], async () =>
      (await pages.searchPages(userId, "budget", { workspaceId })).map((h) => h.id),
    );
  }
  const fileRows = await db.select().from(schema.file).where(eq(schema.file.workspaceId, workspaceId));
  const storedFiles: { id: string; name: string; size: number; sha256: string; storageKey: string }[] = [];
  for (const f of fileRows) {
    const bytes = await files.readStored(f);
    if (!bytes) throw new Error(`file ${f.id} has no stored bytes`);
    storedFiles.push({ id: f.id, name: f.name, size: f.size, sha256: sha256(bytes), storageKey: f.storageKey });
    for (const userId of userIds) {
      await read("fileForViewer", [userId, f.id], async () => (await files.fileForViewer(userId, f.id))?.id ?? null);
    }
  }
  const links = await db.select().from(schema.pageLink);
  step(`reads (${reads.length} reads, ${access.length} access levels)`);

  const manifest = {
    format: 1,
    version: (JSON.parse(await readFile("package.json", "utf8")) as { version: string }).version,
    createdAt: new Date().toISOString(),
    uploadDir: process.env.UPLOAD_DIR,
    people,
    ownerPassword: OWNER_PASSWORD,
    workspaceId,
    databases: { projects: projects.id, tasks: tasks.id },
    pages: all,
    token: { id: ownerToken.token.id, secret: ownerToken.secret },
    formerToken: { id: formerToken.token.id, secret: formerToken.secret },
    formerGrants,
    files: storedFiles,
    links: links.map((l) => ({ sourceId: l.sourceId, targetId: l.targetId })),
    access,
    reads,
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 1));
  console.log(`seed  wrote ${manifestPath}: ${all.length} pages, ${reads.length} reads (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} finally {
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
// Timers the old modules started (sweeps, debounced indexing) would keep the process alive.
process.exit(0);
