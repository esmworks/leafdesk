/**
 * End-to-end check of the AI features against the database, with pi-ai's faux provider standing in
 * for a model (no network): the writing assistant's server path (an action streamed as the person
 * asking, a history version before applying, the change made through the page's shared document),
 * AI autofill properties (settings checks, per-row and bulk refresh through the queue within its
 * concurrency limit, failures, automatic updates after a row changes and what they set off: the
 * row's activity, automations, the AI values reading them; interrupted values; values of select,
 * multi-select, number and checkbox properties and rows skipped for an empty input; turning it off),
 * access checks, the workspace switch, and everything being off without a provider.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/ai-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, desc, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { aiPropertyState, automationRun, databaseAutomation, databaseProperty, page, rowActivity, user, workspace, workspaceMember } =
  await import("@/db/schema");
const { registerCollab, getCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage, listSnapshots } = await import("@/server/pages");
const { getPageHeaderInfo } = await import("@/server/page-meta");
const databases = await import("@/server/databases");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");
const { isAiError } = await import("@/server/ai");
const { disableAi, installFauxAi } = await import("@/server/ai/testing");
const { snapshotBeforeAiEdit, startEditorAction } = await import("@/server/ai-writing");
const { AutofillError, autofillStates, databaseAi, isQueued, requestAutofill, setAutofill } = await import("@/server/ai-properties");
const { describeProperty } = await import("@/server/mcp/query");
const { asAutomation } = await import("@/server/automations/queue");

const RUN = `ai-e2e-${Date.now().toString(36)}`;

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

/** The error `fn` throws (or null). */
async function failure(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}
const aiCode = (error: unknown) => (isAiError(error) ? error.code : error instanceof Error ? `${error.name}:${error.message}` : String(error));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The outsider isn't in the workspace: they can't see any of its pages.
const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

// The faux model: answers depend on the prompt, so each check knows what to expect.
let active = 0;
let most = 0;
let calls = 0;
const prompts: string[] = [];
const script = async ({ prompt }: { prompt: string }) => {
  calls++;
  prompts.push(prompt);
  active++;
  most = Math.max(most, active);
  try {
    await sleep(40);
    if (prompt.includes("Improve the writing")) return "An improved sentence.";
    if (prompt.includes("Summarize this page")) return "A short summary of the page.";
    if (prompt.includes("Title: Broken")) throw new Error("model overloaded");
    // Values of other types, answered the way models do: with a full stop, another case, a sentence.
    const genre = /Genre of (\S+)/.exec(prompt)?.[1];
    if (genre) return { Dune: "Science fiction.", Emma: "romance", Ulysses: "Western" }[genre] ?? "none";
    if (prompt.includes("Topics of")) return 'Sure: ["Space", "politics"]';
    if (prompt.includes("Pages of")) return "About 412 pages";
    if (prompt.includes("Is it a classic")) return "Yes.";
    const hook = /Hook for (\S+)/.exec(prompt);
    if (hook) return `HOOK:${hook[1]}`;
    const pitch = /Pitch (.+?) to (\S+)/.exec(prompt);
    if (pitch) return `"PITCH:${pitch[1]}:${pitch[2]}"`;
    return "Something else";
  } finally {
    active--;
  }
};

async function valueOf(rowId: string, propertyId: string) {
  const [row] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId));
  return row.properties[propertyId];
}

/** Waits until no value of `propertyId` is queued or pending. */
async function settled(propertyId: string, rowIds: string[], timeoutMs = 10_000) {
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

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const owner = { userId: ids.owner };
  const doc = await createPage(owner, { workspaceId, title: "Draft" });
  await getCollab().replaceContent(doc.id, "The first paragraph was writen quickly.\n\nA second paragraph.", owner);

  // ------------------------------------------------------------------ off without a provider
  disableAi();
  check(
    aiCode(await failure(() => startEditorAction(ids.owner, { pageId: doc.id, action: "improve", text: "x" }))) === "disabled",
    "without a provider the writing assistant is off",
  );
  check((await getPageHeaderInfo(ids.owner, doc.id)).ai === false, "…and the page doesn't offer it");
  const books = await createPage(owner, { workspaceId, kind: "database", title: "Books" });
  const audience = await databases.addProperty(ids.owner, books.id, { name: "Audience", type: "text" });
  const pitchProp = await databases.addProperty(ids.owner, books.id, { name: "Pitch", type: "text" });
  check(
    aiCode(await failure(() => setAutofill(ids.owner, pitchProp.id, { mode: "summary" }))) === "disabled",
    "…and AI autofill can't be turned on",
  );
  check((await databaseAi(books.id, [], [])).enabled === false, "…and databases say AI is off");

  // ----------------------------------------------------------------------- writing assistant
  installFauxAi(script, { config: { maxInputChars: 3000, concurrency: 2 } });
  check((await getPageHeaderInfo(ids.owner, doc.id)).ai === true, "with a provider the page offers the assistant");

  const answer = await startEditorAction(ids.owner, { pageId: doc.id, action: "improve", text: "The first paragraph was writen quickly." });
  let streamed = "";
  for await (const event of answer) streamed += event.delta;
  const result = await answer.result();
  check(streamed === "An improved sentence." && result.text === streamed, "an editor action streams the model's answer", streamed);
  check(prompts.at(-1)?.includes("<text>\nThe first paragraph was writen quickly.\n</text>"), "…with the selection sent as data");

  const summary = await startEditorAction(ids.owner, { pageId: doc.id, action: "summarize" });
  check((await summary.result()).text === "A short summary of the page.", "summarizing reads the page on the server");
  check(prompts.at(-1)?.includes("A second paragraph."), "…whole, as it is in the shared document");

  // Applying: a version first, then the change through the shared document (as the editor does).
  await snapshotBeforeAiEdit(ids.owner, doc.id);
  const versions = await listSnapshots(ids.owner, doc.id);
  check(
    versions[0]?.reason === "before_ai_edit" && versions[0].authorName === ids.owner,
    "applying a suggestion saves a history version first",
    versions.map((v) => v.reason),
  );
  await getCollab().replaceContent(doc.id, `${result.text}\n\nA second paragraph.`, owner);
  const after = await getCollab().readPage(doc.id);
  check(
    after.markdown.includes("An improved sentence.") && !after.markdown.includes("writen"),
    "…and the suggestion lands in the page",
    after.markdown,
  );

  check(
    aiCode(await failure(() => startEditorAction(ids.owner, { pageId: doc.id, action: "improve", text: "x".repeat(5000) }))) === "tooLarge",
    "a selection over the size limit is refused, not cut",
  );
  check(
    aiCode(await failure(() => startEditorAction(ids.owner, { pageId: doc.id, action: "translate", text: "Hallo", language: "xx" }))) ===
      "invalid",
    "translating needs a known language",
  );
  const controller = new AbortController();
  const cancelled = await startEditorAction(ids.owner, { pageId: doc.id, action: "summarize" }, controller.signal);
  controller.abort();
  check(aiCode(await failure(() => cancelled.result())) === "aborted", "cancelling stops the request");

  // Access: someone who can't see the page learns nothing and sends nothing.
  const before = calls;
  check(
    aiCode(await failure(() => startEditorAction(ids.outsider, { pageId: doc.id, action: "summarize" }))) === "noAccess",
    "a person without access to the page is refused",
  );
  check(aiCode(await failure(() => snapshotBeforeAiEdit(ids.outsider, doc.id))) === "noAccess", "…and can't save versions of it");
  check(calls === before, "…and nothing reached the model");

  // Owners turn AI off for the workspace.
  await updateWorkspaceSettings(ids.owner, workspaceId, { ai: false });
  check(
    aiCode(await failure(() => startEditorAction(ids.owner, { pageId: doc.id, action: "summarize" }))) === "disabled",
    "with AI off for the workspace the assistant is refused",
  );
  check((await getPageHeaderInfo(ids.owner, doc.id)).ai === false, "…and not offered");
  check((await failure(() => updateWorkspaceSettings(ids.member, workspaceId, { ai: true }))) !== null, "members can't turn it back on");
  await updateWorkspaceSettings(ids.owner, workspaceId, { ai: true });

  // ------------------------------------------------------------------------- autofill settings
  check(
    (await failure(() => setAutofill(ids.owner, pitchProp.id, { mode: "custom", prompt: "Pitch {title} to {Nobody}" }))) instanceof
      AutofillError,
    "a prompt naming an unknown property is refused",
  );
  const statusProp = (await databases.getProperties(books.id)).find((p) => p.type === "status")!;
  const statusSummary = await failure(() => setAutofill(ids.owner, statusProp.id, { mode: "summary" }));
  check(statusSummary instanceof AutofillError && statusSummary.code === "invalidMode", "only text properties take a summary");
  check((await failure(() => setAutofill(ids.outsider, pitchProp.id, { mode: "summary" }))) instanceof AccessError, "…and only by editors");

  const saved = await setAutofill(ids.owner, pitchProp.id, { mode: "custom", prompt: "Pitch {title} to {Audience}" });
  check(saved?.mode === "custom" && saved.prompt === "Pitch {title} to {Audience}", "a custom prompt with placeholders is saved");
  const [stored] = await db.select().from(databaseProperty).where(eq(databaseProperty.id, pitchProp.id));
  const described = describeProperty(stored, undefined, await databases.getProperties(books.id));
  check(
    described.type === "text" && JSON.stringify(described.ai_autofill) === JSON.stringify({ mode: "custom", prompt: "Pitch {title} to {Audience}", include_body: false, auto_update: false }),
    "MCP describes the property as AI autofill",
    described,
  );

  // ------------------------------------------------------------------------- autofill values
  const titles = ["Dune", "Emma", "Ulysses", "Beloved", "Middlemarch"];
  const rows = [];
  for (const title of titles) rows.push(await createPage(owner, { workspaceId, parentId: books.id, title, properties: { [audience.id]: "teens" } }));
  const rowIds = rows.map((r) => r.id);

  most = 0;
  const queued = await requestAutofill(ids.owner, pitchProp.id, rowIds);
  check(queued.queued === 5 && queued.skipped === 0, "updating all rows queues each of them", queued);
  const pendingNow = await autofillStates([stored]);
  check(Object.keys(pendingNow).length > 0, "…which show as pending meanwhile", pendingNow);
  await settled(pitchProp.id, rowIds);
  const values = await Promise.all(rowIds.map((id) => valueOf(id, pitchProp.id)));
  check(
    values.join("|") === titles.map((t) => `PITCH:${t}:teens`).join("|"),
    "every row gets its value, with the placeholders filled in and quotes cleaned off",
    values,
  );
  check(most <= 2, "no more values were worked out at once than AI_CONCURRENCY allows", { most });
  check(Object.keys(await autofillStates([stored])).length === 0, "done values have no state left to show");

  // Values are ordinary text: the snapshot, filters and exports read them as such.
  const snapshot = await databases.getDatabaseSnapshot(ids.owner, books.id);
  check(
    snapshot.rows.find((r) => r.id === rowIds[0])?.properties[pitchProp.id] === "PITCH:Dune:teens",
    "values are stored as plain text values",
  );

  // One row, after its inputs changed.
  await databases.updateRowProperties(ids.owner, rowIds[0], { [audience.id]: "adults" });
  await requestAutofill(ids.owner, pitchProp.id, [rowIds[0]]);
  await settled(pitchProp.id, [rowIds[0]]);
  check((await valueOf(rowIds[0], pitchProp.id)) === "PITCH:Dune:adults", "refreshing one row works its value out again");

  // A failing row keeps its old value and shows why.
  const broken = await createPage(owner, { workspaceId, parentId: books.id, title: "Broken", properties: { [pitchProp.id]: "kept", [audience.id]: "x" } });
  await requestAutofill(ids.owner, pitchProp.id, [broken.id]);
  await settled(pitchProp.id, [broken.id]);
  const failed = (await autofillStates([stored]))[broken.id]?.[pitchProp.id];
  check(failed?.status === "error" && failed.code === "provider", "a value the model fails on shows as failed", failed);
  check((await valueOf(broken.id, pitchProp.id)) === "kept", "…and keeps what it had");

  // A value marked pending that no job works on (the server restarted) shows as interrupted.
  await db.update(aiPropertyState).set({ status: "pending", error: null }).where(eq(aiPropertyState.rowId, broken.id));
  const interrupted = (await autofillStates([stored]))[broken.id]?.[pitchProp.id];
  check(interrupted?.status === "error" && interrupted.code === "interrupted", "a value left pending by a restart shows as interrupted");

  // Access: rows are worked out as the person asking.
  check(
    (await failure(() => requestAutofill(ids.outsider, pitchProp.id, rowIds))) instanceof AccessError,
    "a person who can't see the database can't have its values worked out",
  );

  // Automatic updates follow a row's changes, once its inputs settle, and only when they changed.
  const auto = await setAutofill(ids.owner, pitchProp.id, { mode: "custom", prompt: "Pitch {title} to {Audience}", auto: true });
  check(auto?.auto === true, "values can follow their row");
  // An automation waiting for the AI value to change, and an AI value reading it.
  const [watching] = await db
    .insert(databaseAutomation)
    .values({
      databaseId: books.id,
      workspaceId,
      name: "Pitch changed",
      trigger: { type: "property_changed", propertyId: pitchProp.id },
      secretSalt: "e2e",
      runAs: ids.owner,
    })
    .returning();
  const hookProp = await databases.addProperty(ids.owner, books.id, { name: "Hook", type: "text" });
  await setAutofill(ids.owner, hookProp.id, { mode: "custom", prompt: "Hook for {Pitch}", auto: true });
  const looping = await failure(() => setAutofill(ids.owner, pitchProp.id, { mode: "custom", prompt: "Pitch {title} to {Hook}", auto: true }));
  check(looping instanceof AutofillError && looping.code === "cycle" && looping.params.name === "Hook", "AI values can't read each other in a circle", looping);
  await databases.updateRowProperties(ids.owner, rowIds[1], { [audience.id]: "poets" });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && (await valueOf(rowIds[1], pitchProp.id)) !== "PITCH:Emma:poets") await sleep(200);
  check((await valueOf(rowIds[1], pitchProp.id)) === "PITCH:Emma:poets", "a row's value updates a few seconds after the row changes");
  // Recorded right after the value is saved; merged into the entry of the earlier value (same person).
  const pitchActivity = () =>
    db.select().from(rowActivity).where(and(eq(rowActivity.rowId, rowIds[1]), eq(rowActivity.propertyId, pitchProp.id)));
  let activity = await pitchActivity();
  for (const until = Date.now() + 3_000; Date.now() < until && !activity.some((a) => a.newValue === "PITCH:Emma:poets"); ) {
    await sleep(100);
    activity = await pitchActivity();
  }
  check(
    activity.some((a) => a.newValue === "PITCH:Emma:poets" && a.actorUserId === ids.owner && a.actorKind === "ai"),
    "…recorded in the row's activity as the AI's, for the person whose change set it off",
    activity,
  );
  const runs = await db
    .select()
    .from(automationRun)
    .where(and(eq(automationRun.automationId, watching.id), eq(automationRun.rowId, rowIds[1])));
  check(runs.length === 1 && runs[0].changed.includes(pitchProp.id), "…starting the automation waiting for it to change", runs);
  const hookDeadline = Date.now() + 12_000;
  while (Date.now() < hookDeadline && (await valueOf(rowIds[1], hookProp.id)) !== "HOOK:PITCH:Emma:poets") await sleep(200);
  check((await valueOf(rowIds[1], hookProp.id)) === "HOOK:PITCH:Emma:poets", "…and updating the AI value reading it", await valueOf(rowIds[1], hookProp.id));
  const pitchPrompts = () => prompts.filter((p) => p.includes("Pitch Emma to")).length;
  const pitchesBefore = pitchPrompts();
  await sleep(5_500);
  check(pitchPrompts() === pitchesBefore, "…whose new value doesn't work out the values it doesn't read again", { pitchesBefore, now: pitchPrompts() });
  check(!prompts.filter((p) => p.includes("Pitch Emma to")).some((p) => p.includes("HOOK:")), "…nor go into their prompts");

  // An automation's change sets off AI values that start no automations: the two can't loop.
  await asAutomation(() => databases.updateRowProperties(ids.owner, rowIds[3], { [audience.id]: "kids" }));
  const byAutomation = Date.now() + 12_000;
  while (Date.now() < byAutomation && (await valueOf(rowIds[3], pitchProp.id)) !== "PITCH:Beloved:kids") await sleep(200);
  check((await valueOf(rowIds[3], pitchProp.id)) === "PITCH:Beloved:kids", "an automation's change updates the AI values following the row");
  // Hook, reading Pitch, follows in the same cascade (as the automation too).
  while (Date.now() < byAutomation + 6_000 && (await valueOf(rowIds[3], hookProp.id)) !== "HOOK:PITCH:Beloved:kids") await sleep(200);
  check((await valueOf(rowIds[3], hookProp.id)) === "HOOK:PITCH:Beloved:kids", "…and the values reading them");
  await sleep(500);
  const loopRuns = await db
    .select()
    .from(automationRun)
    .where(and(eq(automationRun.automationId, watching.id), eq(automationRun.rowId, rowIds[3])));
  check(loopRuns.length === 0, "…which start no automations, as the automation's own changes don't", loopRuns);
  const [automationPitch] = await db
    .select()
    .from(rowActivity)
    .where(and(eq(rowActivity.rowId, rowIds[3]), eq(rowActivity.propertyId, pitchProp.id)))
    .orderBy(desc(rowActivity.createdAt));
  check(
    automationPitch?.newValue === "PITCH:Beloved:kids" && automationPitch.actorKind === "ai" && automationPitch.actorUserId === ids.owner,
    "…and read as the AI's in the row's activity, for the automation's person",
    automationPitch,
  );
  const callsBefore = calls;
  await databases.updateRowProperties(ids.owner, rowIds[1], { [audience.id]: "poets" });
  await sleep(5_500);
  check(calls === callsBefore, "…and nothing is sent when its inputs didn't change", { calls, callsBefore });

  // ---------------------------------------------------------------- values of other types
  const dateProp = await databases.addProperty(ids.owner, books.id, { name: "Read on", type: "date" });
  const unsupported = await failure(() => setAutofill(ids.owner, dateProp.id, { mode: "custom", prompt: "When?" }));
  check(unsupported instanceof AutofillError && unsupported.code === "unsupportedType", "a date property can't be filled in by AI");
  const genre = await databases.addProperty(ids.owner, books.id, { name: "Genre", type: "select", options: ["Science fiction", "Romance"] });
  const typedSummary = await failure(() => setAutofill(ids.owner, genre.id, { mode: "summary" }));
  check(typedSummary instanceof AutofillError && typedSummary.code === "invalidMode", "a select is filled in from a prompt, not as a summary");
  const empty = await databases.addProperty(ids.owner, books.id, { name: "Shelf", type: "select" });
  const noOptions = await failure(() => setAutofill(ids.owner, empty.id, { mode: "custom", prompt: "Which shelf?" }));
  check(noOptions instanceof AutofillError && noOptions.code === "noOptions", "…and needs options to pick from");
  await setAutofill(ids.owner, genre.id, { mode: "custom", prompt: "Genre of {title}" });
  const topics = await databases.addProperty(ids.owner, books.id, { name: "Topics", type: "multi_select", options: ["Space", "Politics", "Love"] });
  await setAutofill(ids.owner, topics.id, { mode: "custom", prompt: "Topics of {title}" });
  const pages = await databases.addProperty(ids.owner, books.id, { name: "Pages", type: "number" });
  await setAutofill(ids.owner, pages.id, { mode: "custom", prompt: "Pages of {title}" });
  const classic = await databases.addProperty(ids.owner, books.id, { name: "Classic", type: "checkbox" });
  await setAutofill(ids.owner, classic.id, { mode: "custom", prompt: "Is it a classic? {title}" });
  const typed = [genre, topics, pages, classic];
  const typedIds = rowIds.slice(0, 3);
  for (const prop of typed) await requestAutofill(ids.owner, prop.id, typedIds);
  for (const prop of typed) await settled(prop.id, typedIds);
  const schema = await databases.getProperties(books.id);
  const optionId = (propId: string, name: string) => schema.find((p) => p.id === propId)!.options.options!.find((o) => o.name === name)!.id;
  check((await valueOf(rowIds[0], genre.id)) === optionId(genre.id, "Science fiction"), "a select gets the option the model names, as its id");
  check((await valueOf(rowIds[1], genre.id)) === optionId(genre.id, "Romance"), "…written in any case");
  const offList = (await autofillStates(schema.filter((p) => p.id === genre.id)))[rowIds[2]]?.[genre.id];
  check(offList?.status === "error" && offList.code === "empty" && (await valueOf(rowIds[2], genre.id)) === undefined, "an option the select doesn't have fails, and nothing is made up", offList);
  check(
    JSON.stringify(await valueOf(rowIds[0], topics.id)) === JSON.stringify([optionId(topics.id, "Space"), optionId(topics.id, "Politics")]),
    "a multi-select gets the options of the model's list",
    await valueOf(rowIds[0], topics.id),
  );
  check((await valueOf(rowIds[0], pages.id)) === 412, "a number is read from the answer");
  check((await valueOf(rowIds[0], classic.id)) === true, "a checkbox is ticked for yes");
  const genrePrompt = prompts.find((p) => p.includes("Genre of Dune"))!;
  check(genrePrompt.includes("<options>") && genrePrompt.includes("Science fiction") && genrePrompt.includes("Romance"), "the prompt lists the options to pick from");

  // Only rows where the properties it waits for have a value.
  const waits = await setAutofill(ids.owner, pages.id, { mode: "custom", prompt: "Pages of {title}", requires: [audience.id] });
  check(JSON.stringify(waits?.requires) === JSON.stringify([audience.id]), "a value can wait for other properties");
  const blank = await createPage(owner, { workspaceId, parentId: books.id, title: "Blank", properties: { [pages.id]: 7 } });
  const asked = prompts.length;
  await requestAutofill(ids.owner, pages.id, [blank.id]);
  await settled(pages.id, [blank.id]);
  check(
    (await valueOf(blank.id, pages.id)) === 7 && !prompts.slice(asked).some((p) => p.includes("Pages of Blank")),
    "…and a row without them keeps its value, with nothing sent",
  );
  check(!(await autofillStates(schema.filter((p) => p.id === pages.id)))[blank.id], "…and shows no error");
  await databases.updateRowProperties(ids.owner, blank.id, { [audience.id]: "everyone" });
  await requestAutofill(ids.owner, pages.id, [blank.id]);
  await settled(pages.id, [blank.id]);
  check((await valueOf(blank.id, pages.id)) === 412, "…until they have one");
  const [pagesStored] = await db.select().from(databaseProperty).where(eq(databaseProperty.id, pages.id));
  check(
    JSON.stringify(describeProperty(pagesStored, undefined, schema).ai_autofill?.only_rows_with) === JSON.stringify(["Audience"]),
    "MCP names the properties it waits for",
  );

  // Workspace switch applies to properties too.
  await updateWorkspaceSettings(ids.owner, workspaceId, { ai: false });
  check(
    aiCode(await failure(() => requestAutofill(ids.owner, pitchProp.id, rowIds))) === "disabled",
    "with AI off for the workspace, values aren't worked out",
  );
  check((await databaseAi(books.id, [stored], rowIds.map((id) => ({ id })))).enabled === false, "…and the database says so");
  await updateWorkspaceSettings(ids.owner, workspaceId, { ai: true });

  // Turning autofill off keeps the values as plain text.
  check((await setAutofill(ids.owner, pitchProp.id, null)) === null, "AI autofill can be turned off");
  const [plain] = await db.select().from(databaseProperty).where(eq(databaseProperty.id, pitchProp.id));
  check(!plain.options.ai && (await valueOf(rowIds[2], pitchProp.id)) === "PITCH:Ulysses:teens", "…keeping the values as text");
  const leftover = await db.select().from(aiPropertyState).where(inArray(aiPropertyState.status, ["pending", "error"]));
  check(!leftover.some((s) => s.propertyId === pitchProp.id), "…and dropping its pending and failed states");

  console.log(`\n${passed} checks passed`);
} finally {
  disableAi();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
