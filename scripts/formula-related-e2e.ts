/**
 * End-to-end check of formulas that read related rows (`prop(row, "…")`) and of styled formula
 * results, against the database. A Teams database links Staff rows; its formulas sum, list and
 * filter properties of the linked staff. An editor whose access to Staff is restricted (Salary's
 * values hidden, Secret unknown, Notes only in rows naming them, one row they can't open) gets
 * the formulas over what they may see, and formulas over anything else hidden — in the snapshot,
 * row pages, filters, sorts, MCP and exports — while the owner sees every value. Styles reach
 * snapshots and row pages, never stored values or exports.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/formula-related-e2e.ts
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
const databases = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setPropertyAccess } = await import("@/server/property-access");
const ops = await import("@/server/operations");
const { databaseCsv } = await import("@/server/export");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `fxrel-e2e-${Date.now().toString(36)}`;

registerCollab({
  broadcast: () => {},
  async disconnectLostAccess() {},
} as unknown as Parameters<typeof registerCollab>[0]);

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

const ids = { owner: `${RUN}-owner`, editor: `${RUN}-editor` };
const workspaceId = `${RUN}-ws`;
const has = (o: object, key: string) => Object.hasOwn(o, key);

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id.split("-").at(-1)!, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const staff = await createPage(actor, { workspaceId, kind: "database", title: "Staff" });
  const teams = await createPage(actor, { workspaceId, kind: "database", title: "Teams" });
  const salary = await databases.addProperty(ids.owner, staff.id, { name: "Salary", type: "number" });
  const hours = await databases.addProperty(ids.owner, staff.id, { name: "Hours", type: "number" });
  const secret = await databases.addProperty(ids.owner, staff.id, { name: "Secret", type: "text" });
  const notes = await databases.addProperty(ids.owner, staff.id, { name: "Notes", type: "text" });
  const manager = await databases.addProperty(ids.owner, staff.id, { name: "Manager", type: "person" });
  await databases.addProperty(ids.owner, staff.id, { name: "Level", type: "select", options: [{ name: "Senior" }, { name: "Junior" }] });
  // A formula over Salary on Staff itself: hidden for the editor by the same-row rule.
  await databases.addProperty(ids.owner, staff.id, { name: "Yearly", type: "formula", formula: { expression: 'prop("Salary") * 12' } });
  for (const id of [staff.id, teams.id]) {
    await setPagePermission(ids.owner, id, ids.owner, "full");
    await setPagePermission(ids.owner, id, null, "none");
    await setPagePermission(ids.owner, id, ids.editor, "edit");
  }

  const ada = await createPage(actor, {
    workspaceId,
    parentId: staff.id,
    title: "Ada",
    properties: { Salary: 100, Hours: 2, Secret: "S-ADA", Notes: "ada-note", Manager: [ids.editor], Level: "Senior" },
  });
  const bob = await createPage(actor, {
    workspaceId,
    parentId: staff.id,
    title: "Bob",
    properties: { Salary: 200, Hours: 3, Secret: "S-BOB", Notes: "bob-note", Manager: [ids.owner], Level: "Junior" },
  });
  // A row the editor can't open.
  const cy = await createPage(actor, {
    workspaceId,
    parentId: staff.id,
    title: "Cy",
    properties: { Salary: 400, Hours: 40, Secret: "S-CY", Notes: "cy-note", Manager: [ids.editor], Level: "Senior" },
  });
  await setPagePermission(ids.owner, cy.id, ids.editor, "none");

  const members = await databases.addProperty(ids.owner, teams.id, { name: "Members", type: "relation", relation: { databaseId: staff.id } });
  const formulas = {
    names: 'prop("Members")',
    hours: 'sum(map(prop("Members"), prop(current, "Hours")))',
    levels: 'map(prop("Members"), prop(current, "Level"))',
    seniors: 'length(filter(prop("Members"), prop(current, "Level") == "Senior"))',
    managers: 'map(prop("Members"), prop(current, "Manager"))',
    styled: 'style(sum(map(prop("Members"), prop(current, "Hours"))), "b", "blue")',
    parts: 'style("Lead: ", "i") + style(prop(first(prop("Members")), "title"), "red_background")',
    payroll: 'sum(map(prop("Members"), prop(current, "Salary")))',
    yearly: 'sum(map(prop("Members"), prop(current, "Yearly")))',
    chain: 'prop("Payroll") + 1',
    secrets: 'length(filter(prop("Members"), startsWith(prop(current, "Secret"), "S-A")))',
    notes: 'map(prop("Members"), prop(current, "Notes"))',
  };
  const names: Record<keyof typeof formulas, string> = {
    names: "Names",
    hours: "Hours",
    levels: "Levels",
    seniors: "Seniors",
    managers: "Managers",
    styled: "Styled",
    parts: "Parts",
    payroll: "Payroll",
    yearly: "Yearly",
    chain: "Chain",
    secrets: "Secrets",
    notes: "Notes",
  };
  const fx = {} as Record<keyof typeof formulas, string>;
  for (const key of Object.keys(formulas) as (keyof typeof formulas)[]) {
    fx[key] = (await databases.addProperty(ids.owner, teams.id, { name: names[key], type: "formula", formula: { expression: formulas[key] } })).id;
  }
  const team = await createPage(actor, { workspaceId, parentId: teams.id, title: "Core", properties: { Members: [ada.id, bob.id, cy.id] } });
  const solo = await createPage(actor, { workspaceId, parentId: teams.id, title: "Solo", properties: { Members: [bob.id] } });

  // The stored expression names related properties by id, so renaming them there keeps it working.
  const stored = (await databases.getProperties(teams.id)).find((p) => p.id === fx.hours)!.options.formula!.expression;
  check(stored.includes(`"${hours.id}"`) && !stored.includes('"Hours"'), "related properties are stored by id", stored);
  await databases.updateProperty(ids.owner, hours.id, { name: "Effort" });

  // Restrict Staff for the editor.
  await setPropertyAccess(ids.owner, salary.id, { everyone: "view_property", exceptions: [] });
  await setPropertyAccess(ids.owner, secret.id, { everyone: "none", exceptions: [] });
  await setPropertyAccess(ids.owner, notes.id, { everyone: "view_property", exceptions: [{ personPropertyId: manager.id, level: "view" }] });

  // The owner sees everything.
  const owner = await databases.getDatabaseSnapshot(ids.owner, teams.id);
  const ownCore = owner.rows.find((r) => r.id === team.id)!;
  check(ownCore.properties[fx.hours] === 45, "the owner's sum reads every linked row", ownCore.properties);
  check(ownCore.properties[fx.payroll] === 700 && ownCore.properties[fx.chain] === 701, "…and every value");
  check(ownCore.properties[fx.yearly] === 8400, "…and formulas of the related rows");
  check(ownCore.properties[fx.secrets] === 1, "…and properties nobody else knows of");
  check(ownCore.properties[fx.levels] === "Senior, Junior, Senior", "lists read the related select");
  check(ownCore.properties[fx.seniors] === 2, "filters work on related values");
  check(ownCore.properties[fx.names] === "Ada, Bob, Cy", "a relation alone still reads as titles");
  check(!ownCore.hidden?.length, "nothing is hidden from the owner", ownCore.hidden);

  // The editor: rows they can't open don't count, hidden values hide the formulas over them.
  const snap = await databases.getDatabaseSnapshot(ids.editor, teams.id);
  const core = snap.rows.find((r) => r.id === team.id)!;
  const soloRow = snap.rows.find((r) => r.id === solo.id)!;
  check(core.properties[fx.names] === "Ada, Bob", "the editor's titles leave out the row they can't open", core.properties[fx.names]);
  check(core.properties[fx.hours] === 5, "…and so do sums over related rows", core.properties[fx.hours]);
  check(core.properties[fx.levels] === "Senior, Junior" && core.properties[fx.seniors] === 1, "…and lists and filters");
  check(String(core.properties[fx.managers]).includes("editor"), "related people read as names");
  for (const key of ["payroll", "yearly", "chain", "secrets"] as const) {
    check(!has(core.properties, fx[key]) && core.hidden?.includes(fx[key]), `${names[key]}: a formula over a value the editor may not see shows nothing`, core);
  }
  check(!has(core.properties, fx.notes) && core.hidden?.includes(fx.notes), "a per-row rule hides Notes where a linked row doesn't name the editor");
  check(!has(soloRow.properties, fx.notes) && soloRow.hidden?.includes(fx.notes), "…Bob doesn't");
  const adaTeam = await createPage(actor, { workspaceId, parentId: teams.id, title: "Ada's", properties: { Members: [ada.id] } });
  const adaRow = (await databases.getRow(ids.editor, adaTeam.id)).row;
  check(adaRow.properties[fx.notes] === "ada-note", "…and shows it where every linked row does", adaRow);
  const leaked = (out: unknown) => JSON.stringify(out).match(/.{0,60}(S-ADA|[:,]700\b|[:,]8400\b).{0,20}/g);
  check(!leaked(snap), "the snapshot holds no hidden value", leaked(snap));

  // Styles: shown in snapshots and row pages, never stored with the value.
  check(core.properties[fx.styled] === 5 && JSON.stringify(core.styles?.[fx.styled]) === '{"styles":["b","blue"]}', "a styled result keeps its value and shows its styles", core.styles);
  const parts = core.styles?.[fx.parts] as { parts?: { text: string; styles: string[] }[] } | undefined;
  check(core.properties[fx.parts] === "Lead: Ada" && parts?.parts?.length === 2 && parts.parts[1].styles[0] === "red_background", "styled parts show each part's style", core.styles);
  const corePage = await databases.getRow(ids.editor, team.id);
  check(JSON.stringify(corePage.row.styles?.[fx.styled]) === '{"styles":["b","blue"]}', "the row page shows the styles");
  check(corePage.row.hidden?.includes(fx.payroll) && !has(corePage.row.properties, fx.payroll), "the row page hides the same formulas");

  // Filters and sorts on the hidden formula don't tell the editor anything; on the visible one they work.
  const byPayroll = await databases.listRows(ids.editor, teams.id, { filters: [{ propertyId: fx.payroll, op: "gt", value: 300 }] });
  check(!byPayroll.some((r) => r.id === team.id), "filtering on a hidden related formula finds nothing", byPayroll.map((r) => r.title));
  const ownerByPayroll = await databases.listRows(ids.owner, teams.id, { filters: [{ propertyId: fx.payroll, op: "gt", value: 300 }] });
  check(ownerByPayroll.some((r) => r.id === team.id), "…while the owner's filter finds the team");
  const order = async (userId: string, propertyId: string, direction: "asc" | "desc") =>
    JSON.stringify(
      (await databases.listRows(userId, teams.id, { sorts: [{ propertyId, direction }] }))
        .filter((r) => r.id === team.id || r.id === solo.id)
        .map((r) => r.title),
    );
  check((await order(ids.owner, fx.payroll, "desc")) === '["Core","Solo"]', "the owner's sort ranks by the related sum");
  check((await order(ids.owner, fx.payroll, "asc")) === '["Solo","Core"]', "…both ways");
  // For the editor every row is empty there: both directions keep the manual order.
  check(
    (await order(ids.editor, fx.payroll, "asc")) === (await order(ids.editor, fx.payroll, "desc")),
    "the editor's sort doesn't rank by it",
    await order(ids.editor, fx.payroll, "asc"),
  );
  check((await order(ids.editor, fx.styled, "desc")) === '["Core","Solo"]', "a styled result sorts by its value");
  check((await order(ids.editor, fx.styled, "asc")) === '["Solo","Core"]', "…both ways");
  const styledFilter = await databases.listRows(ids.editor, teams.id, { filters: [{ propertyId: fx.styled, op: "gt", value: 4 }] });
  check(styledFilter.some((r) => r.id === team.id) && !styledFilter.some((r) => r.id === solo.id), "…and filters by it");

  // MCP and exports: plain values, nothing hidden.
  const ctx = { userId: ids.editor, actor: { userId: ids.editor } };
  const query = JSON.stringify(await ops.queryDatabase(ctx, { database_id: teams.id, limit: 50 }));
  check(!leaked(query), "MCP rows hold no hidden value");
  check(!query.includes('"styles"') && !query.includes("blue"), "MCP rows hold plain values");
  const { csv } = await databaseCsv(ids.editor, teams.id);
  check(!leaked(csv) && !csv.includes(",700"), "the editor's CSV holds no hidden value", csv);
  check(csv.includes("Lead: Ada") && !csv.includes("red_background"), "CSV exports the plain value");
  check((await databaseCsv(ids.owner, teams.id)).csv.includes("700"), "…while the owner's export holds it");

  // Saving a formula over a property the editor can't know of is refused like a missing one.
  const refusedSecret = await databases
    .addProperty(ids.editor, teams.id, { name: "Leak", type: "formula", formula: { expression: 'map(prop("Members"), prop(current, "Secret"))' } })
    .then(
      () => false,
      (e: unknown) => e instanceof PropertyValueError,
    );
  check(refusedSecret, "the editor can't write a formula over a property they don't know of");
  const peek = await databases.addProperty(ids.editor, teams.id, {
    name: "Peek",
    type: "formula",
    formula: { expression: 'sum(map(prop("Members"), prop(current, "Salary")))' },
  });
  const peeked = (await databases.getRow(ids.editor, team.id)).row;
  check(!has(peeked.properties, peek.id) && peeked.hidden?.includes(peek.id), "a formula the editor writes over hidden values shows them nothing");
  check((await databases.getRow(ids.owner, team.id)).row.properties[peek.id] === 700, "…and the owner its value");

  // One hop: a formula can't read a related formula that reads related rows itself.
  await databases.addProperty(ids.owner, staff.id, { name: "Teams", type: "relation", relation: { databaseId: teams.id } });
  await databases.updateRowProperties(ids.owner, ada.id, { Teams: [team.id] });
  const refusedDepth = (database: string, name: string, expression: string) =>
    databases.addProperty(ids.owner, database, { name, type: "formula", formula: { expression } }).then(
      () => null,
      (e: unknown) => (e as { params?: { message?: string } }).params?.message ?? String(e),
    );
  const reason = await refusedDepth(staff.id, "Team hours", 'sum(map(prop("Teams"), prop(current, "Hours")))');
  check(reason?.includes("reads related rows itself"), "a formula can't read a related formula that reads related rows itself", reason);
  await databases.addProperty(ids.owner, staff.id, { name: "Team names", type: "formula", formula: { expression: 'map(prop("Teams"), prop(current, "Names"))' } });
  check(
    (await refusedDepth(teams.id, "Deep", 'map(prop("Members"), prop(current, "Team names"))'))?.includes("reads related rows itself"),
    "…in either direction",
  );
  const adaPage = (await databases.getRow(ids.owner, ada.id)).row;
  check(Object.values(adaPage.properties).includes("Ada, Bob, Cy"), "a related formula over a relation reads its titles", adaPage.properties);

  console.log(`\n${passed} checks passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(page).where(eq(page.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  process.exit();
}
