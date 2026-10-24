/**
 * End-to-end check of property options: a relation limited to one row refuses more on every write
 * (values that already hold more stay until written), its two-way other side moves a row instead
 * of adding it when that side is limited, linked rows bring the values their relation shows (with
 * the people they name, and without values the viewer may not see), formulas and rollups take a
 * bar or a ring, created times take a date format but no reminder, and a row template's "@today",
 * "@now" and "@me" in its title become the day, the time and the maker's name.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/prop-extras-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const databases = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { createRow, createRowTemplate } = await import("@/server/templates");
const { setPropertyAccess } = await import("@/server/property-access");
const { setPagePermission } = await import("@/server/permissions");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `prop-extras-e2e-${Date.now().toString(36)}`;
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

/** The code a write is refused with, or null when it goes through. */
async function refused(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof PropertyValueError) return error.code ?? "unknown";
    throw error;
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const workspaceId = `${RUN}-ws`;
const valuesOf = async (rowId: string) =>
  ((await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)))[0]?.properties ?? {}) as Record<string, unknown>;
const titleOf = async (rowId: string) => (await db.select({ title: page.title }).from(page).where(eq(page.id, rowId)))[0]?.title;

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Ada Owner", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Max Member", email: `${ids.member}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const projects = (await createPage(actor, { workspaceId, kind: "database", title: "Projects" })).id;
  const tasks = (await createPage(actor, { workspaceId, kind: "database", title: "Tasks" })).id;
  const status = await databases.addProperty(ids.owner, tasks, { name: "Stage", type: "status" });
  const lead = await databases.addProperty(ids.owner, tasks, { name: "Lead", type: "person" });
  const hours = await databases.addProperty(ids.owner, tasks, { name: "Hours", type: "number" });
  const secret = await databases.addProperty(ids.owner, tasks, { name: "Secret", type: "text" });
  const double = await databaseFormula(tasks, "Double", `prop("Hours") * 2`);
  const project = await databases.addProperty(ids.owner, tasks, {
    name: "Project",
    type: "relation",
    relation: { databaseId: projects, twoWay: true, pairedName: "Tasks" },
  });
  const pairedId = (await databases.getProperties(tasks)).find((p) => p.id === project.id)!.options.relation!.pairedPropertyId!;
  const total = await databases.addProperty(ids.owner, projects, {
    name: "Total hours",
    type: "rollup",
    rollup: { relationPropertyId: pairedId, targetPropertyId: hours.id, function: "sum" },
  });
  const row = async (database: string, title: string, properties: Record<string, unknown> = {}) =>
    (await createPage(actor, { workspaceId, parentId: database, title, properties })).id;
  const [alpha, beta, gamma] = [await row(projects, "Alpha"), await row(projects, "Beta"), await row(projects, "Gamma")];
  const stage = (await databases.getProperties(tasks)).find((p) => p.id === status.id)!.options.options!;
  const t1 = await row(tasks, "Write spec", { [status.id]: stage[1].id, [lead.id]: [ids.member], [hours.id]: 3, [secret.id]: "hush" });
  const t2 = await row(tasks, "Review spec");

  // A relation limited to one row.
  await databases.updateProperty(ids.owner, project.id, { relation: { limit: "one" } });
  const limited = (await databases.getProperties(tasks)).find((p) => p.id === project.id)!;
  check(limited.options.relation?.limit === "one" && limited.options.relation.pairedPropertyId === pairedId, "a relation takes a limit of one row, keeping its pairing");
  check(
    (await refused(() => databases.updateRowProperties(ids.owner, t1, { [project.id]: [alpha, beta] }))) === "relationLimit",
    "…and refuses two rows with a clear error",
  );
  check((await refused(() => databases.updateRowProperties(ids.owner, t1, { Project: ["Alpha"] }))) === null, "…while one row, by title, goes in");
  check(JSON.stringify((await valuesOf(alpha))[pairedId]) === JSON.stringify([t1]), "…and shows on the other side");
  check(
    (await refused(() => databases.createRows(ids.owner, tasks, [{ title: "Bulk", properties: { [project.id]: [alpha, gamma] } }]))) === "relationLimit",
    "…and new rows are held to it too",
  );

  // Values from before the limit stay until the property is written.
  await databases.updateProperty(ids.owner, project.id, { relation: { limit: "any" } });
  await databases.updateRowProperties(ids.owner, t2, { [project.id]: [beta, gamma] });
  await databases.updateProperty(ids.owner, project.id, { relation: { limit: "one" } });
  await databases.updateRowProperties(ids.owner, t2, { [hours.id]: 1 });
  check(((await valuesOf(t2))[project.id] as string[]).length === 2, "a value holding more stays while other properties are written");
  check(
    (await refused(() => databases.updateRowProperties(ids.owner, t2, { [project.id]: [beta, gamma] }))) === "relationLimit",
    "…and must come down to one when the relation itself is written",
  );
  await databases.updateRowProperties(ids.owner, t2, { [project.id]: [gamma] });
  check(
    JSON.stringify((await valuesOf(t2))[project.id]) === JSON.stringify([gamma]) && !((await valuesOf(beta))[pairedId] as string[] | undefined)?.length,
    "…which unlinks the other side",
  );

  // The other side of a two-way relation has its own limit: linking from there moves the row.
  await databases.updateRowProperties(ids.owner, beta, { [pairedId]: [t1] });
  check(JSON.stringify((await valuesOf(t1))[project.id]) === JSON.stringify([beta]), "linking from the unlimited side replaces the limited side's row");
  check(!((await valuesOf(alpha))[pairedId] as string[] | undefined)?.includes(t1), "…and takes the row off the list it was on");
  check(
    (await refused(() => databases.updateRowProperties(ids.owner, beta, { [pairedId]: [t1, t2] }))) === null &&
      ((await valuesOf(beta))[pairedId] as string[]).length === 2,
    "…while the unlimited side holds any number",
  );

  // What linked rows show beside their title.
  check(
    (await refused(() => databases.updateProperty(ids.owner, pairedId, { relation: { show: ["nope"] } }))) === "invalidRelationOptions",
    "linked rows can only show properties of the related database",
  );
  check(
    (await refused(() => databases.updateProperty(ids.owner, pairedId, { relation: { show: [double.id] } }))) === "invalidRelationOptions",
    "…and not formulas",
  );
  await databases.updateProperty(ids.owner, pairedId, { relation: { show: [status.id, "title", lead.id, secret.id], display: "section" } });
  const shown = (await databases.getProperties(projects)).find((p) => p.id === pairedId)!.options.relation!;
  check(
    JSON.stringify(shown.show) === JSON.stringify([status.id, "title", lead.id, secret.id]) && shown.display === "section",
    "a relation keeps what its linked rows show, in order, and shows as a section",
    shown,
  );
  const projectProps = await databases.getProperties(projects);
  const targets = await databases.getRelationTargets(ids.owner, projectProps);
  const linked = targets[pairedId].rows.find((r) => r.id === t1);
  check(
    linked?.values?.[status.id] === stage[1].id && JSON.stringify(linked.values[lead.id]) === JSON.stringify([ids.member]) && linked.values[secret.id] === "hush",
    "linked rows come with the values their relation shows",
    linked,
  );
  check(targets[pairedId].people?.some((p) => p.id === ids.member && p.name === "Max Member"), "…and the people they name");
  check(!targets[pairedId].rows.find((r) => r.id === t2)?.values?.[status.id], "…and nothing for values a row doesn't have");
  const plain = await databases.getRelationTargets(ids.owner, (await databases.getProperties(tasks)).filter((p) => p.id === project.id));
  check(plain[project.id].rows.every((r) => r.values === undefined), "relations that show only titles load no values");
  // A property the member may not see is left out of what they get (rules don't hold for full access).
  await setPagePermission(ids.owner, tasks, ids.owner, "full");
  await setPagePermission(ids.owner, tasks, null, "edit");
  await setPropertyAccess(ids.owner, secret.id, { everyone: "none", exceptions: [] });
  const asMember = (await databases.getRelationTargets(ids.member, projectProps))[pairedId].rows.find((r) => r.id === t1);
  check(asMember?.values?.[secret.id] === undefined && asMember?.values?.[status.id] === stage[1].id, "…and values the viewer may not see are left out", asMember);
  const copy = await databases.duplicateProperty(ids.owner, pairedId, "Tasks copy");
  const copied = (await databases.getProperties(projects)).find((p) => p.id === copy.id)!.options.relation!;
  check(copied.display === "section" && copied.show?.length === 4 && !copied.pairedPropertyId, "a copy of the relation keeps how it shows, linking one way");

  // Bars and rings for formulas and rollups.
  check((await refused(() => databases.updateProperty(ids.owner, double.id, { numberDisplay: { display: "ring", color: "green", divideBy: 10 } }))) === null, "a formula giving a number shows as a ring");
  check((await refused(() => databases.updateProperty(ids.owner, total.id, { numberDisplay: { display: "bar", divideBy: 40 } }))) === null, "…a rollup as a bar");
  check((await refused(() => databases.updateProperty(ids.owner, secret.id, { numberDisplay: { display: "bar" } }))) === "invalidNumberFormat", "…text never");
  await databases.updateProperty(ids.owner, double.id, { formula: { expression: `prop("Secret")` } });
  check(!(await databases.getProperties(tasks)).find((p) => p.id === double.id)!.options.numberDisplay, "a formula that stops giving a number drops its ring");

  // Date formats.
  const created = await databases.addProperty(ids.owner, tasks, { name: "Created", type: "created_time" });
  check((await refused(() => databases.updateProperty(ids.owner, created.id, { date: { format: "dmy", clock: "24h" } }))) === null, "a created time takes a date format and a clock");
  check(
    (await databases.getProperties(tasks)).find((p) => p.id === created.id)!.options.date?.format === "dmy" &&
      (await databases.getProperties(tasks)).find((p) => p.id === created.id)!.options.date?.clock === "24h",
    "…stored as given",
    (await databases.getProperties(tasks)).find((p) => p.id === created.id)!.options,
  );
  check((await refused(() => databases.updateProperty(ids.owner, created.id, { date: { reminderDays: 1 } }))) === "invalidDateOptions", "…but no reminder");
  check((await refused(() => databases.updateProperty(ids.owner, secret.id, { date: { format: "full" } }))) === "invalidDateOptions", "text has no date format");
  check((await refused(() => databases.updateProperty(ids.owner, created.id, { date: { format: "weird" as never } }))) === "invalidDateOptions", "…and only known formats go in");

  // Row template titles.
  const template = await createRowTemplate(actor, tasks, { title: "Standup @today by @me" });
  const now = new Date();
  const made = await createRow({ userId: ids.member }, tasks, { templateId: template.id, timeZone: "Pacific/Kiritimati", locale: "en" });
  const expected = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "Pacific/Kiritimati" }).format(now);
  check((await titleOf(made.id)) === `Standup ${expected} by Max Member`, "a row template's @today and @me become the maker's day and name", await titleOf(made.id));
  const iso = await createRow({ userId: ids.owner }, tasks, { templateId: template.id, timeZone: "UTC" });
  check((await titleOf(iso.id)) === `Standup ${now.toISOString().slice(0, 10)} by Ada Owner`, "…as an ISO date without a language (MCP, the API)", await titleOf(iso.id));
  check((await titleOf(template.id)) === "Standup @today by @me", "…and the template keeps its words");
  const named = await createRow({ userId: ids.owner }, tasks, { templateId: template.id, title: "Given @today" });
  check((await titleOf(named.id)) === "Given @today", "a title given with the row is kept as written");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

async function databaseFormula(databaseId: string, name: string, expression: string) {
  return databases.addProperty(ids.owner, databaseId, { name, type: "formula", formula: { expression } });
}
