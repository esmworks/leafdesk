/**
 * End-to-end check of building databases with AI, against the database, with a scripted faux model
 * (src/server/ai/testing.ts): a description becomes a plan (a plan that doesn't pass is sent back
 * once with what is wrong), the plan is created as the person with its intro page, typed
 * properties, option colors and status groups, a two-way relation, views with their grouping,
 * dates and filters, and example rows linked to each other; a plan that fails halfway leaves
 * nothing behind; a database or a page the person may only read can't take it; AI off and a model
 * that never answers with a plan are refused. The AI chat's create_database goes the same way
 * (scripts/ai-chat-tools-e2e.ts). Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/ai-build-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, databaseProperty, databaseView, page, teamspace, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { isAiError } = await import("@/server/ai");
const { disableAi, installFauxAi, resetAi } = await import("@/server/ai/testing");
const { draftDatabasePlan } = await import("@/server/ai-build");
const { createFromPlan, PlanError } = await import("@/server/database-plan");
const { AccessError } = await import("@/server/access");

const RUN = `ai-build-e2e-${Date.now().toString(36)}`;

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

async function failure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "none";
  } catch (error) {
    if (isAiError(error)) return `ai:${error.code}`;
    if (error instanceof PlanError) return `plan:${error.code}`;
    if (error instanceof AccessError) return "access";
    return `other:${String(error)}`;
  }
}

/** A plan as a model writes it, before it is checked. */
type RawPlan = {
  intro: { title: string; icon: string; markdown: string } | null;
  databases: {
    key: string;
    title: string;
    icon?: string;
    properties: { name: string; type: string; description?: string; options?: { name: string; color?: string; group?: string }[]; database?: string; two_way?: boolean; paired_name?: string }[];
    views: Record<string, unknown>[];
    rows: { title: string; values: Record<string, unknown> }[];
  }[];
};

const hiring = (title = `${RUN} Hiring`): RawPlan => ({
  intro: { title, icon: "🧑‍💼", markdown: "How we hire, step by step." },
  databases: [
    {
      key: "candidates",
      title: "Candidates",
      icon: "🙂",
      properties: [
        { name: "Stage", type: "status", options: [{ name: "Applied" }, { name: "Interviewing" }, { name: "Hired", color: "green" }] },
        { name: "Role", type: "select", options: [{ name: "Engineer", color: "blue" }, { name: "Designer", color: "pink" }] },
        { name: "Start", type: "date", description: "The first working day." },
        { name: "Owner", type: "person" },
      ],
      views: [
        { name: "Pipeline", type: "board", group_by: "Stage" },
        { name: "Mine", type: "table", filters: [{ property: "Owner", op: "contains", value: "me" }], sorts: [{ property: "Start", direction: "desc" }] },
        { type: "calendar", date_by: "Start" },
      ],
      rows: [
        { title: "Ada", values: { Stage: "Interviewing", Role: "Engineer", Start: "2026-11-02", Owner: "me" } },
        { title: "Grace", values: { Stage: "Applied", Role: "Designer" } },
      ],
    },
    {
      key: "interviews",
      title: "Interviews",
      icon: "🗓️",
      properties: [
        { name: "Candidate", type: "relation", database: "candidates", two_way: true, paired_name: "Interviews" },
        { name: "When", type: "date" },
        { name: "Passed", type: "checkbox" },
      ],
      views: [],
      rows: [{ title: "Ada, first round", values: { Candidate: ["Ada"], When: "2026-10-30", Passed: true } }],
    },
  ],
});

const ids = { owner: `${RUN}-owner`, alice: `${RUN}-alice` };
const userIds = Object.values(ids);
const { owner, alice } = ids;
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));

  // ── Drafting ──────────────────────────────────────────────────────────────────────────────
  const requests: { system: string; prompt: string }[] = [];
  const ai = installFauxAi(({ system, prompt }) => {
    requests.push({ system, prompt });
    // First a plan with a formula and a board without columns, then the plan fixed.
    if (requests.length === 1) return JSON.stringify({ databases: [{ key: "x", title: "X", properties: [{ name: "Score", type: "formula" }], views: [{ type: "board" }] }] });
    return "Here it is:\n```json\n" + JSON.stringify(hiring()) + "\n```";
  });
  const drafted = await draftDatabasePlan(alice, workspaceId, "A hiring pipeline with candidates and interviews");
  check(drafted.databases.map((d) => d.title).join() === "Candidates,Interviews" && drafted.intro?.title === `${RUN} Hiring`, "a description becomes a plan of databases", drafted);
  check(
    requests.length === 2 && requests[0].prompt.includes("<request>") && requests[1].prompt.includes("formula properties can't be part of a plan") && requests[1].prompt.includes("a board needs group_by"),
    "…a plan that doesn't pass goes back to the model once, with what is wrong",
    requests.map((r) => r.prompt),
  );
  check(drafted.databases[0].properties[0].options?.map((o) => `${o.name}:${o.color}:${o.group}`).join() === "Applied:gray:todo,Interviewing:brown:in_progress,Hired:green:done", "…with colors and status groups filled in", drafted.databases[0].properties[0]);

  ai.setScript(() => "I can't do that.");
  requests.length = 0;
  check((await failure(() => draftDatabasePlan(alice, workspaceId, "Something"))) === "plan:unusable", "a model that never answers with a plan is refused as unusable");
  check((await failure(() => draftDatabasePlan(alice, workspaceId, "   "))) === "ai:invalid", "an empty description is refused");
  check((await failure(() => draftDatabasePlan(`${RUN}-nobody`, workspaceId, "Tasks"))) === "access", "someone outside the workspace can't draft in it");

  disableAi();
  check((await failure(() => draftDatabasePlan(alice, workspaceId, "Tasks"))) === "ai:disabled", "with AI off, drafting is refused");
  resetAi();

  // ── Creating ──────────────────────────────────────────────────────────────────────────────
  const made = await createFromPlan({ userId: alice }, workspaceId, drafted, { teamspaceId: general.id });
  const [intro] = await db.select().from(page).where(eq(page.id, made.rootId));
  const [candidates, interviews] = made.databases;
  const databases = await db.select().from(page).where(inArray(page.id, [candidates.id, interviews.id]));
  check(
    intro?.title === `${RUN} Hiring` && intro.teamspaceId === general.id && intro.createdBy === alice && databases.every((d) => d.parentId === intro.id && d.kind === "database" && d.createdBy === alice),
    "the plan is created as the person: the intro page in the teamspace, the databases under it",
    { intro, databases },
  );
  check(intro.contentMarkdown?.includes("How we hire") || intro.contentText?.includes("How we hire"), "…the intro page with its text", intro);

  const props = await db.select().from(databaseProperty).where(and(inArray(databaseProperty.databaseId, [candidates.id, interviews.id]), isNull(databaseProperty.deletedAt)));
  const of = (databaseId: string) => props.filter((p) => p.databaseId === databaseId);
  const named = (databaseId: string, name: string) => of(databaseId).find((p) => p.name === name)!;
  check(
    ["Stage:status", "Role:select", "Start:date", "Owner:person", "Interviews:relation"].every((want) => of(candidates.id).some((p) => `${p.name}:${p.type}` === want)) &&
      ["Candidate:relation", "When:date", "Passed:checkbox"].every((want) => of(interviews.id).some((p) => `${p.name}:${p.type}` === want)),
    "…with the properties and types of the plan, the relation shown on both databases",
    props.map((p) => `${p.databaseId === candidates.id ? "C" : "I"}.${p.name}:${p.type}`),
  );
  const stage = named(candidates.id, "Stage");
  const role = named(candidates.id, "Role");
  check(
    stage.options.options?.map((o) => `${o.name}:${o.color}:${o.group}`).join() === "Applied:gray:todo,Interviewing:brown:in_progress,Hired:green:done" &&
      role.options.options?.map((o) => `${o.name}:${o.color}`).join() === "Engineer:blue,Designer:pink",
    "…options with the plan's colors and status groups",
    { stage: stage.options, role: role.options },
  );
  check(named(candidates.id, "Start").options.description === "The first working day.", "…and the properties' descriptions", named(candidates.id, "Start"));
  const relation = named(interviews.id, "Candidate");
  check(relation.options.relation?.databaseId === candidates.id && relation.options.relation.pairedPropertyId === named(candidates.id, "Interviews").id, "…the relation links to the candidates, both ways", relation.options);

  const views = await db.select().from(databaseView).where(inArray(databaseView.databaseId, [candidates.id, interviews.id])).orderBy(databaseView.position);
  const candidateViews = views.filter((v) => v.databaseId === candidates.id);
  const board = candidateViews.find((v) => v.name === "Pipeline");
  const mine = candidateViews.find((v) => v.name === "Mine");
  const calendar = candidateViews.find((v) => v.type === "calendar");
  check(
    candidateViews.map((v) => v.type).join() === "board,table,calendar" && board?.config.groupBy === stage.id && calendar?.config.dateBy === named(candidates.id, "Start").id && calendar.name === "Calendar",
    "…the views of the plan in its order, the board grouped by the status, the calendar by the date, an unnamed view named for its type",
    candidateViews,
  );
  check(
    JSON.stringify(mine?.config.filters ?? []).includes(named(candidates.id, "Owner").id) && mine?.config.sorts?.[0]?.propertyId === named(candidates.id, "Start").id,
    "…a view's filters and sorts saved by property id",
    mine?.config,
  );
  check(views.filter((v) => v.databaseId === interviews.id).map((v) => v.type).join() === "table", "…and a database given no views has one table (the starter view made way)", views.filter((v) => v.databaseId === interviews.id));

  const rows = await db.select().from(page).where(and(inArray(page.parentId, [candidates.id, interviews.id]), eq(page.kind, "page")));
  const ada = rows.find((r) => r.title === "Ada");
  const round = rows.find((r) => r.title === "Ada, first round");
  check(rows.length === 3 && ada && round && rows.every((r) => r.createdBy === alice), "…the example rows", rows.map((r) => r.title));
  const adaValues = ada!.properties as Record<string, unknown>;
  const roundValues = round!.properties as Record<string, unknown>;
  check(
    adaValues[stage.id] === stage.options.options?.find((o) => o.name === "Interviewing")?.id && JSON.stringify(adaValues[named(candidates.id, "Owner").id]) === JSON.stringify([alice]),
    "…with their values: options by id, \"me\" as the person",
    adaValues,
  );
  check(JSON.stringify(roundValues[relation.id]) === JSON.stringify([ada!.id]), "…and the interview linked to Ada", roundValues);

  const audits = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "page.created")));
  check(audits.length === 1 && audits[0].targetId === intro.id, "one audit event for what was made: the intro page", audits.map((a) => a.targetId));

  // ── All or nothing ────────────────────────────────────────────────────────────────────────
  const broken = hiring(`${RUN} Broken`);
  // Passes the plan's check (a date's shape) but not the database's: there is no 30 February.
  broken.databases[1].rows[0].values.When = "2026-02-30";
  const brokenResult = await failure(() => createFromPlan({ userId: alice }, workspaceId, broken, { teamspaceId: general.id }));
  const leftovers = await db.select({ id: page.id }).from(page).where(and(eq(page.workspaceId, workspaceId), eq(page.title, `${RUN} Broken`)));
  const strays = await db.select({ id: page.id }).from(page).where(and(eq(page.workspaceId, workspaceId), eq(page.title, "Candidates")));
  check(brokenResult !== "none" && leftovers.length === 0 && strays.length === 1, "a plan that fails halfway is taken back whole", { brokenResult, leftovers, strays });

  const invalid = hiring();
  invalid.databases[0].properties.push({ name: "Stage", type: "text" } as never);
  check((await failure(() => createFromPlan({ userId: alice }, workspaceId, invalid, {}))) === "plan:invalid", "a plan that doesn't pass the check is refused before anything is made");

  // ── Where it may go ───────────────────────────────────────────────────────────────────────
  check((await failure(() => createFromPlan({ userId: alice }, workspaceId, hiring(`${RUN} In db`), { parentId: candidates.id }))) === "plan:parent", "a database can't take a plan");
  const handbook = await createPage({ userId: owner }, { workspaceId, teamspaceId: null, title: "Handbook" });
  await setPagePermission(owner, handbook.id, alice, "view");
  check((await failure(() => createFromPlan({ userId: alice }, workspaceId, hiring(`${RUN} Read only`), { parentId: handbook.id }))) === "access", "nor a page the person may only read");

  const inPage = await createPage({ userId: alice }, { workspaceId, teamspaceId: general.id, title: "Team page" });
  const underPage = await createFromPlan({ userId: alice }, workspaceId, { ...hiring(), intro: null }, { parentId: inPage.id });
  const underRows = await db.select().from(page).where(inArray(page.id, underPage.databases.map((d) => d.id)));
  check(underPage.rootId === underPage.databases[0].id && underRows.every((d) => d.parentId === inPage.id), "without an intro page, the databases go straight under the page", underRows);

  const privatePlan = await createFromPlan({ userId: alice }, workspaceId, { intro: null, databases: [{ key: "notes", title: `${RUN} Private`, properties: [] }] }, { teamspaceId: null });
  const [privateDb] = await db.select().from(page).where(eq(page.id, privatePlan.rootId));
  const privateProps = await db.select().from(databaseProperty).where(and(eq(databaseProperty.databaseId, privateDb.id), isNull(databaseProperty.deletedAt)));
  check(privateDb.teamspaceId === null && privateDb.parentId === null && privateProps.length === 0, "a database at the top, private, with no properties when the plan gives none", { privateDb, privateProps });
  const seeded = await createFromPlan({ userId: alice }, workspaceId, { intro: null, databases: [{ key: "list", title: `${RUN} Seeded`, properties: [] }] }, { teamspaceId: null }, { seedEmpty: true });
  const seededProps = await db.select().from(databaseProperty).where(and(eq(databaseProperty.databaseId, seeded.rootId), isNull(databaseProperty.deletedAt)));
  check(seededProps.map((p) => p.type).sort().join() === "multi_select,status", "…or the status and tags a new database starts with (seedEmpty, as the chat asks)", seededProps.map((p) => p.type));

  console.log(`\n${passed} checks passed`);
} finally {
  resetAi();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
