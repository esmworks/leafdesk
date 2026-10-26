/**
 * End-to-end check of properties that keep their values unique (lib/unique-values) against the
 * database: the rule can't be turned on while two rows share a value; once on, a value another row
 * holds is refused whichever way it is written (one row, new rows, a bulk edit, two writes
 * at once; a paste leaves it out and counts it), case and spaces aside and numbers by amount; empty values don't count; a row in the
 * trash frees its value and can't come back while another row holds it; a duplicated row leaves
 * the value out; a merge moves a value to the row kept; turning the rule off or changing the property's type lets rows share values again. Creates its own user and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/unique-values-e2e.ts
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
const { page, uniqueValue, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const databases = await import("@/server/databases");
const { archivePage, createPage, restorePage } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { pasteRows } = await import("@/server/paste");
const { mergeRows } = await import("@/server/merge-rows");
const { FormError, submitForm } = await import("@/server/forms");
const { FORM_TITLE } = await import("@/lib/forms");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `unique-e2e-${Date.now().toString(36)}`;
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

/** The code a PropertyValueError carries, "resolved" when the call went through, else the error. */
async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "resolved";
  } catch (error) {
    return error instanceof PropertyValueError ? (error.code ?? error.message) : String(error);
  }
}

const owner = `${RUN}-owner`;
const workspaceId = `${RUN}-ws`;
const stored = async (rowId: string) =>
  (await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)))[0].properties as Record<string, unknown>;

try {
  await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test` });
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values({ workspaceId, userId: owner, role: "owner" });
  const actor = { userId: owner };
  const people = await createPage(actor, { workspaceId, kind: "database", title: "People" });
  for (const prop of await databases.getProperties(people.id)) await databases.deleteProperty(owner, prop.id);
  const email = await databases.addProperty(owner, people.id, { name: "Email", type: "email" });
  const code = await databases.addProperty(owner, people.id, { name: "Code", type: "number" });
  const row = (title: string, properties: Record<string, unknown> = {}) => createPage(actor, { workspaceId, parentId: people.id, title, properties });

  const ada = await row("Ada", { Email: "ada@example.test", Code: 1 });
  const bob = await row("Bob", { Email: "ADA@example.test " });
  const cem = await row("Cem");

  // Not while two rows share a value.
  check((await outcome(() => databases.updateProperty(owner, email.id, { unique: true }))) === "duplicateValues", "the rule waits for shared values to go");
  check(!(await databases.getProperties(people.id)).find((p) => p.id === email.id)?.options.unique, "the property stays as it was");
  await databases.updateRowProperties(owner, bob.id, { Email: "bob@example.test" });
  await databases.updateProperty(owner, email.id, { unique: true });
  check((await databases.getProperties(people.id)).find((p) => p.id === email.id)?.options.unique === true, "the rule is on once values differ");
  const keys = await db.select().from(uniqueValue).where(eq(uniqueValue.propertyId, email.id));
  check(keys.length === 2 && keys.some((k) => k.key === "ada@example.test"), "the rows' values are counted", keys);

  // Refused whichever way a value is written.
  check((await outcome(() => databases.updateRowProperties(owner, cem.id, { Email: " Ada@Example.test" }))) === "notUnique", "an edit repeating another row's value is refused");
  check((await stored(cem.id))[email.id] === undefined, "the refused edit wrote nothing");
  check((await outcome(() => databases.createRows(owner, people.id, [{ title: "Dee", properties: { Email: "bob@example.test" } }]))) === "notUnique", "a new row with another row's value is refused");
  check(
    (await outcome(() =>
      databases.createRows(owner, people.id, [
        { title: "Eve", properties: { Email: "eve@example.test" } },
        { title: "Eve 2", properties: { Email: "EVE@example.test" } },
      ]),
    )) === "notUnique",
    "two new rows with the same value are refused together",
  );
  const titles = (await databases.listRows(owner, people.id)).map((r) => r.title).sort();
  check(titles.join() === "Ada,Bob,Cem", "no row was made by the refused writes", titles);
  const fen = await row("Fen");
  check(
    (await outcome(() => databases.updateRowsProperties(owner, people.id, [cem.id, fen.id], { Email: "same@example.test" }))) === "notUnique",
    "a bulk edit giving two rows one value is refused",
  );
  check((await stored(cem.id))[email.id] === undefined && (await stored(fen.id))[email.id] === undefined, "the refused bulk edit wrote nothing");
  // A paste leaves out what it can't keep, counted, instead of stopping partway.
  const pasted = await pasteRows(actor, people.id, {
    updates: [{ rowId: cem.id, values: { [email.id]: "bob@example.test" } }],
    newRows: [
      { title: "Hal", values: { [email.id]: "hal@example.test" } },
      { title: "Ivy", values: { [email.id]: " HAL@example.test" } },
    ],
  });
  check(pasted.invalid === 2 && pasted.created.length === 2, "a paste leaves out values another row holds or an earlier one takes", pasted);
  check((await stored(cem.id))[email.id] === undefined, "the left-out value wasn't written");
  const [hal, ivy] = await Promise.all(pasted.created.map(stored));
  check(hal[email.id] === "hal@example.test" && ivy[email.id] === undefined, "the first pasted row keeps the value", { hal, ivy });
  await db.delete(page).where(inArray(page.id, pasted.created));
  const both = await Promise.allSettled([
    databases.updateRowProperties(owner, cem.id, { Email: "race@example.test" }),
    databases.updateRowProperties(owner, fen.id, { Email: "race@example.test" }),
  ]);
  check(both.filter((r) => r.status === "fulfilled").length === 1, "of two writes at once, one goes through", both.map((r) => r.status));

  // Empty values and numbers.
  await databases.updateRowProperties(owner, cem.id, { Email: null });
  await databases.updateRowProperties(owner, fen.id, { Email: null });
  check((await outcome(() => databases.updateRowProperties(owner, bob.id, { Email: null }))) === "resolved", "any number of rows may be empty");
  await databases.updateProperty(owner, code.id, { unique: true });
  check((await outcome(() => databases.updateRowProperties(owner, bob.id, { Code: "1.0" }))) === "notUnique", "numbers compare by amount");
  check((await outcome(() => databases.updateRowProperties(owner, bob.id, { Code: 2 }))) === "resolved", "another number goes in");

  // The trash frees a value; a row can't come back while another holds it.
  await archivePage(owner, ada.id);
  await databases.updateRowProperties(owner, cem.id, { Email: "ada@example.test" });
  check((await stored(cem.id))[email.id] === "ada@example.test", "a value held by a row in the trash is free");
  check((await outcome(() => restorePage(owner, ada.id))) === "notUnique", "a row whose value was taken stays in the trash");
  await databases.updateRowProperties(owner, cem.id, { Email: "cem@example.test" });
  await restorePage(owner, ada.id);
  check((await stored(ada.id))[email.id] === "ada@example.test", "once free, the row comes back with its value");

  // A duplicated row leaves the value out, keeping the others.
  const copy = await duplicatePage(actor, ada.id);
  const copied = await stored(copy.id);
  check(copied[email.id] === undefined && copied[code.id] === undefined, "a duplicated row leaves unique values out", copied);

  // A form's answer repeating another row's value is that question's error.
  const form = await databases.addView(owner, people.id, { name: "Ask", type: "form" });
  const answered = await submitForm(owner, form.id, { [FORM_TITLE]: "Hal", [email.id]: "ADA@example.test" }).then(
    () => null,
    (error: unknown) => error,
  );
  check(
    answered instanceof FormError && answered.code === "invalidAnswers" && answered.answers[0]?.propertyId === email.id && answered.answers[0]?.code === "notUnique",
    "a form's answer repeating another row's value is refused at its question",
    answered,
  );

  // Merging rows: the kept row may take a value from the row merged into it.
  const gus = await row("Gus", { Email: "gus@example.test" });
  const gus2 = await row("Gus 2");
  await mergeRows(actor, { keptRowId: gus2.id, otherRowIds: [gus.id], choices: { [email.id]: gus.id } });
  check((await stored(gus2.id))[email.id] === "gus@example.test", "a merged row's value goes to the row kept");

  // Off again, deleted or made a select: rows may share values.
  await databases.updateProperty(owner, code.id, { unique: false });
  check((await outcome(() => databases.updateRowProperties(owner, copy.id, { Code: 1 }))) === "resolved", "turned off, numbers may repeat");
  check((await db.select().from(uniqueValue).where(eq(uniqueValue.propertyId, code.id))).length === 0, "turned off, its values are no longer counted");
  await databases.changePropertyType(owner, email.id, { type: "select", yes: "Yes" });
  check(!(await databases.getProperties(people.id)).find((p) => p.id === email.id)?.options.unique, "a new type drops the rule");
  check((await db.select().from(uniqueValue).where(eq(uniqueValue.propertyId, email.id))).length === 0, "made a select, its values are no longer counted");
  check(
    (await outcome(() => databases.updateProperty(owner, email.id, { unique: true }))) === "unsupportedType",
    "a select can't keep its values unique",
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(eq(user.id, owner));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
