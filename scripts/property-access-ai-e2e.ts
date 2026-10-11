/**
 * End-to-end check of property access in search and AI, against the database: values of a
 * restricted property leave the semantic index as soon as the rule is set (and come back when it's
 * removed), rows keep their other chunks and are indexed again even when a rule on a property that
 * isn't indexed changes nothing in their text; AI autofill never sends the model a property the
 * person can't know of, refuses settings that name one, doesn't tell whether one exists, and only
 * writes values the person may change (a restricted person's edit doesn't flip the value to
 * "failed" for everyone); rollups over restricted properties of related rows don't feed it either.
 * Embeddings come from the fake OpenAI-compatible server, the autofill model from pi-ai's faux
 * provider. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/property-access-ai-e2e.ts
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
const { aiPropertyState, page, pageChunk, pageIndexState, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage, searchPages } = await import("@/server/pages");
const databases = await import("@/server/databases");
const { setPagePermission } = await import("@/server/permissions");
const { setPropertyAccess } = await import("@/server/property-access");
const { AccessError } = await import("@/server/access");
const { installFauxAi, resetAi, setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi } = await import("@/server/ai/fake-openai");
const index = await import("@/server/semantic-index");
const { clearQueryCache, semanticSearch } = await import("@/server/semantic-search");
const { AutofillError, databaseAi, isQueued, requestAutofill, setAutofill } = await import("@/server/ai-properties");

const RUN = `propaccess-ai-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();

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

async function failure(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
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

async function chunksOf(pageId: string) {
  return db.select({ text: pageChunk.text, blockId: pageChunk.blockId }).from(pageChunk).where(eq(pageChunk.pageId, pageId));
}

async function valueOf(rowId: string, propertyId: string) {
  const [row] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId));
  return row.properties[propertyId];
}

async function autofillSettled(propertyId: string, rowIds: string[], timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const pending = await db
      .select({ rowId: aiPropertyState.rowId })
      .from(aiPropertyState)
      .where(and(eq(aiPropertyState.propertyId, propertyId), eq(aiPropertyState.status, "pending")));
    if (!pending.length && rowIds.every((id) => !isQueued(id, propertyId))) return;
    await sleep(50);
  }
  throw new Error("AI values did not settle in time");
}

const ids = { owner: `${RUN}-owner`, editor: `${RUN}-editor` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const staff = await createPage(actor, { workspaceId, kind: "database", title: "Staff" });
  await setPagePermission(ids.owner, staff.id, ids.owner, "full");
  await setPagePermission(ids.owner, staff.id, null, "none");
  await setPagePermission(ids.owner, staff.id, ids.editor, "edit");
  const codename = await databases.addProperty(ids.owner, staff.id, { name: "Codename", type: "text" });
  const notes = await databases.addProperty(ids.owner, staff.id, { name: "Notes", type: "text" });
  const lead = await databases.addProperty(ids.owner, staff.id, { name: "Lead", type: "person" });

  // ── The semantic index ──────────────────────────────────────────────────────────────────────
  setAiEnv({
    AI_EMBEDDINGS_MODEL: "fake-embed",
    AI_EMBEDDINGS_BASE_URL: fake.baseUrl,
    AI_EMBEDDINGS_API_KEY: "local-test",
    AI_EMBEDDINGS_MIN_SIMILARITY: "0.25",
    AI_WORKSPACE_RATE_LIMIT: "1000",
    AI_RATE_LIMIT: "1000",
    AI_CONCURRENCY: "4",
  });
  const ada = await createPage(actor, {
    workspaceId,
    parentId: staff.id,
    title: "Ada",
    properties: { Codename: "zebracorn quasar", Notes: "likes gardening", Lead: [ids.editor] },
    // Longer than a chunk: the body has chunks of its own, apart from the values'.
    markdown: `Onboarding checklist for the new hire. ${"Read the handbook and meet the team. ".repeat(26)}`,
  });
  await settle();
  const hasCodename = async () => (await chunksOf(ada.id)).some((c) => c.text.includes("zebracorn"));
  check(await hasCodename(), "without rules a row's values are indexed");
  const found = async (userId: string, q: string) => (await semanticSearch(userId, q, { workspaceId })).map((h) => h.id);
  check((await found(ids.editor, "zebracorn quasar")).includes(ada.id), "…and found by meaning");

  await setPropertyAccess(ids.owner, codename.id, { everyone: "none", exceptions: [] });
  check(!(await hasCodename()), "restricting a property drops its values from the index at once");
  clearQueryCache();
  const hits = await searchPages(ids.editor, "zebracorn quasar", { workspaceId });
  check(!hits.some((h) => h.id === ada.id), "…so it can't be found by them", hits);
  check(!(await searchPages(ids.owner, "zebracorn quasar", { workspaceId })).some((h) => h.id === ada.id), "…by anyone: the index is shared");
  check((await chunksOf(ada.id)).some((c) => c.text.includes("Onboarding")), "…the body's chunks stay");
  await settle();
  const after = await chunksOf(ada.id);
  check(!after.some((c) => c.text.includes("zebracorn") || c.text.includes("Codename")), "the row is indexed again without the property", after);
  check(after.some((c) => c.text.includes("Notes: likes gardening")), "…with its other values");
  check((await found(ids.editor, "likes gardening")).includes(ada.id), "…which are still found by meaning");

  // A rule on a property that isn't indexed changes nothing in the text: the row still gets its
  // values chunk back.
  await setPropertyAccess(ids.owner, lead.id, { everyone: "view", exceptions: [] });
  await settle();
  check((await chunksOf(ada.id)).some((c) => c.blockId === null && c.text.includes("likes gardening")), "a rule on a property that isn't indexed keeps the row's values chunk");
  const [state] = await db.select().from(pageIndexState).where(eq(pageIndexState.pageId, ada.id));
  check(Boolean(state), "…and its index state");

  await setPropertyAccess(ids.owner, codename.id, { everyone: "inherit", exceptions: [] });
  await settle();
  check(await hasCodename(), "removing the restriction brings the values back into the index");
  await setPropertyAccess(ids.owner, lead.id, { everyone: "inherit", exceptions: [] });
  await settle();
  resetAi();

  // ── AI autofill ─────────────────────────────────────────────────────────────────────────────
  const prompts: string[] = [];
  installFauxAi(async ({ prompt }) => {
    prompts.push(prompt);
    return "A value.";
  });
  const pitch = await databases.addProperty(ids.owner, staff.id, { name: "Pitch", type: "text" });
  const other = await databases.addProperty(ids.owner, staff.id, { name: "Other", type: "text" });
  await setPropertyAccess(ids.owner, codename.id, { everyone: "none", exceptions: [] });

  const code = (error: unknown) => (error instanceof AutofillError ? error.code : error instanceof AccessError ? "access" : String(error));
  check(
    code(await failure(() => setAutofill(ids.editor, other.id, { mode: "custom", prompt: "Use {Codename}" }))) === "unknownPlaceholder",
    "autofill settings can't name a property the person can't know of",
  );
  check(
    code(await failure(() => setAutofill(ids.editor, other.id, { mode: "translation", language: "de", source: codename.id }))) === "unknownSource",
    "…nor translate one",
  );
  check(
    code(await failure(() => setAutofill(ids.editor, codename.id, { mode: "summary" }))) === "access",
    "such a property can't be set up, like one that doesn't exist",
  );
  check(code(await failure(() => requestAutofill(ids.editor, codename.id, [ada.id]))) === "access", "…nor refreshed");
  check(await setAutofill(ids.owner, other.id, { mode: "custom", prompt: "Use {Codename}" }), "someone who sees it may name it");

  await setAutofill(ids.owner, pitch.id, { mode: "summary" });
  await requestAutofill(ids.owner, pitch.id, [ada.id]);
  await autofillSettled(pitch.id, [ada.id]);
  // Restricted values never feed autofill, not even the owner's: the value it writes can be read
  // by people the inputs are hidden from.
  check(
    !prompts.at(-1)?.includes("zebracorn") && prompts.at(-1)?.includes("likes gardening"),
    "the owner's summary reads every unrestricted value, and no restricted one",
    prompts.at(-1),
  );
  const queued = await requestAutofill(ids.editor, pitch.id, [ada.id]);
  check(queued.queued === 1, "the editor may refresh a value");
  await autofillSettled(pitch.id, [ada.id]);
  check(!prompts.at(-1)?.includes("zebracorn") && !prompts.at(-1)?.includes("Codename"), "…and their prompt has nothing of what they can't know of", prompts.at(-1));

  // Values they may see but not change.
  await setPropertyAccess(ids.owner, pitch.id, { everyone: "view", exceptions: [] });
  await db.update(page).set({ properties: { ...(await db.select().from(page).where(eq(page.id, ada.id)))[0].properties, [pitch.id]: "Kept" } }).where(eq(page.id, ada.id));
  const refused = await requestAutofill(ids.editor, pitch.id, [ada.id]);
  check(refused.queued === 0 && refused.skipped === 1, "rows where they can't change the value are skipped", refused);
  // An automatic update after their edit runs as them: it leaves the value and its state alone.
  await setAutofill(ids.owner, pitch.id, { mode: "summary", auto: true });
  await db.delete(aiPropertyState).where(eq(aiPropertyState.rowId, ada.id));
  const before = prompts.length;
  await databases.updateRowProperties(ids.editor, ada.id, { [notes.id]: "likes chess" });
  await sleep(5_000);
  await autofillSettled(pitch.id, [ada.id]);
  check((await valueOf(ada.id, pitch.id)) === "Kept" && prompts.length === before, "an automatic update doesn't write for someone who can't change the value");
  const states = await db.select().from(aiPropertyState).where(eq(aiPropertyState.rowId, ada.id));
  check(states.length === 0, "…nor marks it failed", states);

  // A failed value shows as failed only to people who see the value.
  await setPropertyAccess(ids.owner, pitch.id, { everyone: "view_property", exceptions: [] });
  await db.insert(aiPropertyState).values({ rowId: ada.id, propertyId: pitch.id, status: "error", error: "provider" });
  const aiOf = async (userId: string) => {
    const snap = await databases.getDatabaseSnapshot(userId, staff.id);
    return databaseAi(staff.id, snap.properties, snap.rows);
  };
  check(!(await aiOf(ids.editor)).states[ada.id]?.[pitch.id], "an autofill failure isn't shown where the value is hidden");
  check((await aiOf(ids.owner)).states[ada.id]?.[pitch.id]?.status === "error", "…but is to someone who sees the value");
  await db.delete(aiPropertyState).where(eq(aiPropertyState.rowId, ada.id));

  await setPropertyAccess(ids.owner, pitch.id, { everyone: "none", exceptions: [] });
  check(code(await failure(() => requestAutofill(ids.editor, pitch.id, [ada.id]))) === "access", "a property they can't know of can't be refreshed");
  check(code(await failure(() => setAutofill(ids.editor, pitch.id, null))) === "access", "…nor set up");

  // A rollup over a restricted property of related rows never feeds autofill either: whoever's
  // edit sets it off, the value it writes can be read by people the related value is hidden from.
  await setAutofill(ids.owner, pitch.id, { mode: "summary" });
  const salaries = await createPage(actor, { workspaceId, kind: "database", title: "Salaries" });
  await setPagePermission(ids.owner, salaries.id, ids.owner, "full");
  await setPagePermission(ids.owner, salaries.id, null, "none");
  await setPagePermission(ids.owner, salaries.id, ids.editor, "view");
  const salary = await databases.addProperty(ids.owner, salaries.id, { name: "Salary", type: "number" });
  const grade = await databases.addProperty(ids.owner, salaries.id, { name: "Grade", type: "text" });
  const adaPay = await createPage(actor, { workspaceId, parentId: salaries.id, title: "Ada's pay", properties: { Salary: 987654, Grade: "grade-xyzzy" } });
  await setPropertyAccess(ids.owner, salary.id, { everyone: "view_property", exceptions: [] });
  const pay = await databases.addProperty(ids.owner, staff.id, { name: "Pay", type: "relation", relation: { databaseId: salaries.id } });
  await databases.addProperty(ids.owner, staff.id, { name: "Pay salary", type: "rollup", rollup: { relationPropertyId: pay.id, targetPropertyId: salary.id, function: "show_original" } });
  await databases.addProperty(ids.owner, staff.id, { name: "Pay grade", type: "rollup", rollup: { relationPropertyId: pay.id, targetPropertyId: grade.id, function: "show_original" } });
  await databases.updateRowProperties(ids.owner, ada.id, { [pay.id]: [adaPay.id] });
  const brief = await databases.addProperty(ids.owner, staff.id, { name: "Brief", type: "text" });
  await setAutofill(ids.owner, brief.id, { mode: "summary" });
  const asked = prompts.length;
  await requestAutofill(ids.owner, brief.id, [ada.id]);
  await autofillSettled(brief.id, [ada.id]);
  const briefPrompt = prompts.slice(asked).join("\n");
  check(briefPrompt.includes("grade-xyzzy"), "a rollup over an open property of related rows feeds autofill", briefPrompt);
  check(!briefPrompt.includes("987654"), "…one over a restricted property there doesn't, not even the owner's", briefPrompt);

  console.log(`\n${passed} checks passed`);
} finally {
  resetAi();
  await settle().catch(() => {});
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
