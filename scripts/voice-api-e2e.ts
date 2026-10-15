/**
 * End-to-end check of voice notes through the REST API (`POST /api/v1/voice-notes`) against the
 * database, with a faux model and a faux transcription standing in for the providers (no
 * network): a recording saved as a private page and as a database row (select values picked from
 * the options), the transcript toggle in the person's language, the AI falling back to the
 * transcript, workspace-bound tokens, and every refusal (speech to text off, AI off in the
 * workspace, apps only reading, a read-only token, no workspace, a file that isn't audio, JSON,
 * nothing heard), and which databases the quick note offers. The API's handler runs in this
 * process. Creates its own users and workspaces and
 * deletes them afterwards.
 *
 *   pnpm tsx scripts/voice-api-e2e.ts
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
const { archivePage, createPage } = await import("@/server/pages");
const { voiceNoteDatabases } = await import("@/server/voice-notes");
const { getProperties, makeOption, updateProperty } = await import("@/server/databases");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { rememberLocale } = await import("@/server/mail/locale");
const { createApiToken } = await import("@/server/api/tokens");
const { handleApiRequest, openApiDocument } = await import("@/server/api");
const { disableAi, installFauxAi } = await import("@/server/ai/testing");

const RUN = `voice-api-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

type Res = { status: number; body: any };
async function api(method: string, path: string, token: string, body?: FormData | string): Promise<Res> {
  const res = await handleApiRequest(
    new Request(`http://app.test/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body } : {}),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const errorCode = (res: Res) => res.body?.error?.code;

/** A "recording" whose transcript is its text (see the faux transcription below). */
function recording(said: string, fields: Record<string, string> = {}, file = new File([said], "memo.webm", { type: "audio/webm" })) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  form.set("audio", file);
  return form;
}

// The faux model writes a note when it sees a transcript, picking Tags when the database has them;
// a transcript asking for it to fail makes it fail.
const script = async ({ prompt }: { prompt: string }) => {
  if (!prompt.includes("<transcript>")) return "ok";
  if (prompt.includes("please fail")) throw new Error("model overloaded");
  const tags = prompt.includes('"Tags"') ? 'Property "Tags": home, Garden\n' : "";
  return `Title: Groceries\n${tags}---\n## Shopping\n\n- Milk\n- Bread`;
};
const transcribe = async (audio: { bytes: Blob }) => (await audio.bytes.text()).trim();

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const wsA = `${RUN}-ws-a`;
const wsB = `${RUN}-ws-b`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: wsA, name: `${RUN} A` },
    { id: wsB, name: `${RUN} B` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: wsA, userId: ids.owner, role: "owner" },
    { workspaceId: wsB, userId: ids.owner, role: "owner" },
    { workspaceId: wsA, userId: ids.member, role: "member" },
  ]);
  const W = (await createApiToken(ids.owner, { name: "voice write", scopes: ["pages:write"] })).secret;
  const R = (await createApiToken(ids.owner, { name: "voice read", scopes: ["pages:read"] })).secret;
  const boundB = (await createApiToken(ids.owner, { name: "voice bound", scopes: ["pages:write"], workspaceId: wsB })).secret;

  const database = await createPage({ userId: ids.owner }, { workspaceId: wsA, kind: "database", title: `${RUN} Inbox`, teamspaceId: null });
  const tags = (await getProperties(database.id)).find((p) => p.type === "multi_select");
  check(tags, "the new database has a multi-select property");
  await updateProperty(ids.owner, tags.id, { name: "Tags", options: ["Home", "Work"].map((name, i) => makeOption(name, i)) });

  // ------------------------------------------------------------------ off without speech to text
  disableAi();
  const off = await api("POST", "/voice-notes", W, recording("Buy milk.", { workspace_id: wsA }));
  check(off.status === 409 && errorCode(off) === "voice_notes_unavailable", "without speech to text: 409 voice_notes_unavailable", off.body);

  installFauxAi(script, { transcribe });

  // ------------------------------------------------------------------ a private page
  const created = await api("POST", "/voice-notes", W, recording("Okay so um tomorrow buy milk and bread.", { workspace_id: wsA }));
  check(created.status === 201 && created.body.id && created.body.url.endsWith(`/p/${created.body.id}`), "POST /voice-notes saves a note (201)", created.body);
  check(created.body.title === "Groceries" && created.body.rewritten === true, "…titled and written up by AI", created.body);
  check(created.body.transcript === "Okay so um tomorrow buy milk and bread." && created.body.database_id === null, "…answering with the transcript");
  const [saved] = await db.select().from(page).where(eq(page.id, created.body.id));
  check(saved.workspaceId === wsA && saved.teamspaceId === null && saved.parentId === null && saved.title === "Groceries", "…as a private page of the workspace", saved);
  const read = await api("GET", `/pages/${created.body.id}`, R);
  check(/^[*-] Milk$/m.test(read.body.markdown) && read.body.markdown.includes("Shopping"), "…whose body is the note, lists kept", read.body.markdown);
  check(read.body.markdown.includes("Transcript") && read.body.markdown.includes("Okay so um tomorrow"), "…with the transcript in a toggle under it", read.body.markdown);

  await rememberLocale(ids.owner, "tr");
  const turkish = await api("POST", "/voice-notes", W, recording("Süt al.", { workspace_id: wsA }));
  const turkishBody = (await api("GET", `/pages/${turkish.body.id}`, R)).body.markdown;
  check(turkish.status === 201 && turkishBody.includes("Döküm"), "the toggle is titled in the language the person uses the app in", turkishBody);

  // ------------------------------------------------------------------ a database row
  const row = await api("POST", "/voice-notes", W, recording("Milk and bread for home.", { workspace_id: wsA, database_id: database.id }));
  check(row.status === 201 && row.body.database_id === database.id, "with database_id the note is a row of the database", row.body);
  check(JSON.stringify(row.body.properties) === JSON.stringify({ Tags: ["Home"] }), "…its Tags picked from the options (not new ones)", row.body.properties);
  const [rowPage] = await db.select().from(page).where(eq(page.id, row.body.id));
  check(rowPage.parentId === database.id && rowPage.title === "Groceries", "…saved under the database");
  const rowRead = await api("GET", `/rows/${row.body.id}`, R);
  check(JSON.stringify(rowRead.body.properties?.Tags) === JSON.stringify(["Home"]), "…with the value stored", rowRead.body.properties);
  const byDatabase = await api("POST", "/voice-notes", W, recording("Another one.", { database_id: database.id }));
  check(byDatabase.status === 201 && byDatabase.body.workspace_id === wsA, "database_id alone is enough");

  // ------------------------------------------------------------------ the AI falling back
  const fallback = await api("POST", "/voice-notes", W, recording("Remember to please fail the model this time around today", { workspace_id: wsA }));
  check(fallback.status === 201 && fallback.body.rewritten === false, "when the AI fails the note is still saved, not rewritten", fallback.body);
  check(fallback.body.title === "Remember to please fail the model this time…", "…titled with the transcript's first words", fallback.body.title);

  // ------------------------------------------------------------------ workspaces and tokens
  const outside = await api("POST", "/voice-notes", boundB, recording("x", { workspace_id: wsA }));
  check(outside.status === 404 && errorCode(outside) === "not_found", "a token bound to another workspace: 404", outside.body);
  const outsideDb = await api("POST", "/voice-notes", boundB, recording("x", { database_id: database.id }));
  check(outsideDb.status === 404, "…also for a database outside it");
  const bound = await api("POST", "/voice-notes", boundB, recording("Bound note."));
  check(bound.status === 201 && bound.body.workspace_id === wsB, "a bound token's workspace is the default", bound.body);
  const nowhere = await api("POST", "/voice-notes", W, recording("x"));
  check(nowhere.status === 400 && errorCode(nowhere) === "validation_error" && nowhere.body.error.details[0].path === "workspace_id", "without a workspace: 400 naming workspace_id", nowhere.body);
  const mismatch = await api("POST", "/voice-notes", W, recording("x", { workspace_id: wsB, database_id: database.id }));
  check(mismatch.status === 404, "a database of another workspace than workspace_id: 404", mismatch.body);
  const readOnly = await api("POST", "/voice-notes", R, recording("x", { workspace_id: wsA }));
  check(readOnly.status === 403 && errorCode(readOnly) === "insufficient_scope", "a read token can't make voice notes");

  // ------------------------------------------------------------------ what isn't a recording
  const text = await api("POST", "/voice-notes", W, recording("x", { workspace_id: wsA }, new File(["x"], "notes.txt", { type: "text/plain" })));
  check(text.status === 415 && errorCode(text) === "unsupported_media_type", "a file that isn't audio: 415", text.body);
  const json = await api("POST", "/voice-notes", W, JSON.stringify({ workspace_id: wsA }));
  check(json.status === 415 && errorCode(json) === "unsupported_media_type", "JSON instead of form data: 415");
  const noAudio = new FormData();
  noAudio.set("workspace_id", wsA);
  const missing = await api("POST", "/voice-notes", W, noAudio);
  check(missing.status === 400 && missing.body.error.details[0].path === "audio", "no audio: 400 naming the field", missing.body);
  const silent = await api("POST", "/voice-notes", W, recording("   ", { workspace_id: wsA }));
  check(silent.status === 400 && errorCode(silent) === "invalid_request", "nothing heard: 400 invalid_request", silent.body);

  // ------------------------------------------------------------------ workspace switches
  await updateWorkspaceSettings(ids.owner, wsA, { ai: false });
  const aiOff = await api("POST", "/voice-notes", W, recording("x", { workspace_id: wsA }));
  check(aiOff.status === 409 && errorCode(aiOff) === "voice_notes_unavailable", "a workspace with AI off: 409 voice_notes_unavailable", aiOff.body);
  await updateWorkspaceSettings(ids.owner, wsA, { ai: true, connectedApps: "read" });
  const before = (await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, wsA))).length;
  const readApps = await api("POST", "/voice-notes", W, recording("x", { workspace_id: wsA }));
  const after = (await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, wsA))).length;
  check(readApps.status === 403 && errorCode(readApps) === "forbidden" && after === before, "a workspace letting apps only read: 403, nothing saved", readApps.body);

  // ------------------------------------------------------------------ databases the quick note offers
  const shared = await createPage({ userId: ids.owner }, { workspaceId: wsA, kind: "database", title: `${RUN} Shared`, teamspaceId: null });
  const trashed = await createPage({ userId: ids.owner }, { workspaceId: wsA, kind: "database", title: `${RUN} Old`, teamspaceId: null });
  await archivePage(ids.owner, trashed.id);
  const offered = (await voiceNoteDatabases(ids.owner, wsA)).map((d) => d.id);
  check(offered.includes(database.id) && offered.includes(shared.id), "the quick note offers the databases the person may edit", offered);
  check(!offered.includes(trashed.id), "…not ones in the trash");
  const forMember = (await voiceNoteDatabases(ids.member, wsA)).map((d) => d.id);
  check(!forMember.includes(database.id) && !forMember.includes(shared.id), "…nor someone else's private ones", forMember);

  // ------------------------------------------------------------------ the reference
  const doc = openApiDocument() as any;
  check(doc.paths["/voice-notes"]?.post?.requestBody?.content?.["multipart/form-data"], "the OpenAPI document describes the endpoint as form data");

  console.log(`\n${passed} checks passed`);
} finally {
  disableAi();
  await db.delete(workspace).where(inArray(workspace.id, [wsA, wsB]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
