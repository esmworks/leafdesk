/**
 * End-to-end check of the REST API (/api/v1) against a running app (`pnpm dev`): personal access
 * tokens (scopes, workspace binding, expiry, revocation, last use), every endpoint, pagination,
 * pages the user can't see, writes refused to read-only tokens, rate limiting, CORS being off,
 * errors, and the OpenAPI document and docs page. Creates its own users and workspaces in the
 * database and deletes them afterwards.
 *
 *   pnpm tsx scripts/api-e2e.ts
 *
 * Env: APP_URL (default http://localhost:3000) and DATABASE_URL, read from .env when present. The
 * server must use the default rate limit (API_RATE_LIMIT unset) and share the database.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { apiToken, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { createApiToken, revokeApiToken, listApiTokens } = await import("@/server/api/tokens");
const { API_ROUTES } = await import("@/server/api/routes");
const { today } = await import("@/lib/journal");

const BASE = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const API = `${BASE}/api/v1`;
const RUN = `api-e2e-${Date.now().toString(36)}`;

// Pages made here (the database, the hidden page) skip the app's live documents; the server's own
// writes go through its collab service as usual.
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
  async disconnectLostAccess() {},
} as unknown as Parameters<typeof registerCollab>[0]);

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

type Res = { status: number; body: any; headers: Headers };
async function api(method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body: parsed, headers: res.headers };
}
const errorCode = (res: Res) => res.body?.error?.code;

const ids = { alice: `${RUN}-alice`, bob: `${RUN}-bob` };
const userIds = Object.values(ids);
const wsA = `${RUN}-ws-a`;
const wsB = `${RUN}-ws-b`;
const wsBob = `${RUN}-ws-bob`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: wsA, name: `${RUN} A` },
    { id: wsB, name: `${RUN} B` },
    { id: wsBob, name: `${RUN} Bob's` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: wsA, userId: ids.alice, role: "owner" },
    { workspaceId: wsA, userId: ids.bob, role: "member" },
    { workspaceId: wsB, userId: ids.alice, role: "owner" },
    { workspaceId: wsBob, userId: ids.bob, role: "owner" },
  ]);

  // ------------------------------------------------------------------ tokens
  const write = await createApiToken(ids.alice, { name: "e2e write", scopes: ["pages:write"], expiresInDays: 30 });
  const read = await createApiToken(ids.alice, { name: "e2e read", scopes: ["pages:read"] });
  const boundA = await createApiToken(ids.alice, { name: "e2e bound", scopes: ["pages:write"], workspaceId: wsA });
  check(/^esi_[A-Za-z0-9]{40}$/.test(write.secret), "a token is esi_ plus 40 letters and digits");
  check(write.token.scopes.join() === "pages:read,pages:write", "a write token also reads");
  check(write.token.tokenHash !== write.secret && !write.token.tokenHash.includes(write.secret.slice(4)), "only a hash of the secret is stored");
  check(Math.abs(write.token.expiresAt!.getTime() - Date.now() - 30 * 86_400_000) < 60_000, "expiry is set 30 days out");
  const listed = await listApiTokens(ids.alice);
  check(listed.length === 3 && listed.every((t) => t.prefix.startsWith("esi_") && t.prefix.length === 8), "tokens are listed with a short prefix");
  check(listed.find((t) => t.id === boundA.token.id)?.workspaceName === `${RUN} A`, "the list names a bound token's workspace");
  let refused = await createApiToken(ids.alice, { name: "x", scopes: ["pages:read"], workspaceId: wsBob }).catch((e) => e);
  check(refused?.code === "workspace", "a token can't be bound to someone else's workspace");
  refused = await createApiToken(ids.alice, { name: "x", scopes: ["admin"] }).catch((e) => e);
  check(refused?.code === "scopes", "unknown scopes are refused");
  const W = write.secret;
  const R = read.secret;
  const B = boundA.secret;

  // ------------------------------------------------------------------ authentication
  check(errorCode(await api("GET", "/me")) === "unauthorized", "no token: 401 unauthorized");
  const bogus = await api("GET", "/me", `esi_${"x".repeat(40)}`);
  check(bogus.status === 401 && errorCode(bogus) === "invalid_token", "unknown token: 401 invalid_token");
  check(bogus.headers.get("www-authenticate")?.includes('error="invalid_token"'), "401s carry a WWW-Authenticate challenge");
  const me = await api("GET", "/me", W);
  check(me.status === 200 && me.body.user.id === ids.alice && me.body.token.scopes.includes("pages:write"), "GET /me names the user and scopes", me.body);
  const touched = await db.select({ lastUsedAt: apiToken.lastUsedAt }).from(apiToken).where(eq(apiToken.id, write.token.id));
  check(touched[0].lastUsedAt && Date.now() - touched[0].lastUsedAt.getTime() < 60_000, "using a token records when it was last used");
  check(me.headers.get("x-ratelimit-limit") === "180", "responses show the rate limit");
  check(me.headers.get("access-control-allow-origin") === null, "no CORS headers by default");
  const withCookie = await api("GET", "/me", null, undefined, { cookie: "better-auth.session_token=whatever" });
  check(withCookie.status === 401, "a session cookie is not accepted instead of a token");

  // ------------------------------------------------------------------ workspaces and pages
  const workspaces = await api("GET", "/workspaces", R);
  check(
    workspaces.status === 200 && [wsA, wsB].every((id) => workspaces.body.workspaces.some((w: any) => w.id === id)),
    "GET /workspaces lists the user's workspaces",
  );
  check(!workspaces.body.workspaces.some((w: any) => w.id === wsBob), "…and not others'");

  const readOnlyCreate = await api("POST", "/pages", R, { workspace_id: wsA, title: "Should not exist" });
  check(readOnlyCreate.status === 403 && errorCode(readOnlyCreate) === "insufficient_scope", "a read token can't create pages");
  const created = await api("POST", "/pages", W, {
    workspace_id: wsA,
    title: `${RUN} Notes`,
    icon: "📝",
    markdown: "# Plan\n\nFirst paragraph about apricots.\n\n- one\n- two",
  });
  check(created.status === 201 && created.body.id && created.body.url.includes(created.body.id), "POST /pages creates a page (201)", created.body);
  const pageId = created.body.id as string;
  const got = await api("GET", `/pages/${pageId}`, R);
  check(got.status === 200 && got.body.title === `${RUN} Notes` && got.body.icon === "📝", "GET /pages/{id} reads title and icon", got.body);
  check(got.body.markdown.includes("apricots") && /^[*-] two$/m.test(got.body.markdown),"…and the whole body as Markdown", got.body.markdown);
  check(!("note" in got.body), "…without the hints meant for AI assistants");

  const longBody = `${"Long line of text. ".repeat(2500)}END`;
  const updated = await api("PATCH", `/pages/${pageId}`, W, { title: `${RUN} Notes v2`, markdown: longBody, icon: null });
  check(updated.status === 200 && updated.body.changed.includes("title") && updated.body.changed.includes("icon"), "PATCH /pages/{id} changes title, body and icon", updated.body);
  const long = await api("GET", `/pages/${pageId}`, R);
  check(long.body.markdown.length > 30_000 && long.body.markdown.endsWith("END") && !long.body.markdown_truncated, "long bodies come back whole");
  check(long.body.icon === null && long.body.title === `${RUN} Notes v2`, "the icon was removed and the title changed");
  await api("PATCH", `/pages/${pageId}`, W, { markdown: "First paragraph about apricots." });
  const appended = await api("PATCH", `/pages/${pageId}`, W, { markdown: "Appended line.", mode: "append" });
  check(appended.body.changed.includes("body (appended)"), "PATCH with mode append adds to the body");
  const afterAppend = await api("GET", `/pages/${pageId}`, R);
  check(afterAppend.body.markdown.includes("apricots") && afterAppend.body.markdown.includes("Appended line."), "…keeping what was there");
  const empty = await api("PATCH", `/pages/${pageId}`, W, {});
  check(empty.status === 400 && errorCode(empty) === "invalid_request", "PATCH without changes is a 400 invalid_request");
  const badTitle = await api("PATCH", `/pages/${pageId}`, W, { title: "" });
  check(badTitle.status === 400 && errorCode(badTitle) === "validation_error" && badTitle.body.error.details[0].path === "title", "invalid fields are listed in details");
  const badJson = await api("PATCH", `/pages/${pageId}`, W, "{not json");
  check(badJson.status === 400 && errorCode(badJson) === "invalid_json", "malformed JSON is a 400 invalid_json");

  // Children and pagination
  const parent = (await api("POST", "/pages", W, { workspace_id: wsA, title: `${RUN} Parent` })).body.id as string;
  for (const n of [1, 2, 3]) await api("POST", "/pages", W, { parent_id: parent, title: `${RUN} Child ${n}` });
  const page1 = await api("GET", `/pages/${parent}/children?limit=2`, R);
  check(page1.status === 200 && page1.body.pages.length === 2 && page1.body.has_more && page1.body.next_cursor, "GET /pages/{id}/children pages by 2", page1.body);
  const page2 = await api("GET", `/pages/${parent}/children?limit=2&cursor=${page1.body.next_cursor}`, R);
  check(page2.body.pages.length === 1 && page2.body.pages[0].title === `${RUN} Child 3` && page2.body.next_cursor === null, "…and the cursor reads the rest in order");
  const viaWorkspace = await api("GET", `/workspaces/${wsA}/pages?parent_id=${parent}&limit=10`, R);
  check(viaWorkspace.body.pages.length === 3, "GET /workspaces/{id}/pages?parent_id lists the same pages");
  const top = await api("GET", `/workspaces/${wsA}/pages`, R);
  check(top.body.pages.some((p: any) => p.id === pageId) && !top.body.pages.some((p: any) => p.title.includes("Child")), "top-level listing has only top-level pages");
  const badCursor = await api("GET", `/pages/${parent}/children?cursor=garbage`, R);
  check(badCursor.status === 400 && errorCode(badCursor) === "invalid_cursor", "a malformed cursor is a 400 invalid_cursor");
  const badLimit = await api("GET", `/pages/${parent}/children?limit=0`, R);
  check(badLimit.status === 400 && errorCode(badLimit) === "validation_error", "an out-of-range limit is a 400 validation_error");

  // Search
  const search = await api("GET", `/search?query=${encodeURIComponent(`${RUN} Child`)}&limit=2`, R);
  check(search.status === 200 && search.body.results.length === 2 && search.body.has_more, "GET /search finds pages and pages through them", search.body);
  const search2 = await api("GET", `/search?query=${encodeURIComponent(`${RUN} Child`)}&limit=2&cursor=${search.body.next_cursor}`, R);
  check(search2.body.results.length === 1 && !search2.body.has_more, "…the cursor gives the remaining match");
  check(errorCode(await api("GET", "/search", R)) === "validation_error", "search needs a query");

  // Move, archive, restore
  const moved = await api("POST", `/pages/${pageId}/move`, W, { parent_id: parent });
  check(moved.status === 200 && moved.body.parent_id === parent, "POST /pages/{id}/move nests a page");
  const back = await api("POST", `/pages/${pageId}/move`, W, { parent_id: null });
  check(back.body.parent_id === null, "…and moves it back to the top level");
  const archived = await api("POST", `/pages/${parent}/archive`, W);
  check(archived.status === 200 && archived.body.in_trash === true, "POST /pages/{id}/archive trashes a page");
  check((await api("GET", `/pages/${parent}`, R)).body.in_trash === true, "…which then reads as in the trash");
  const restored = await api("POST", `/pages/${parent}/restore`, W);
  check(restored.status === 200 && restored.body.in_trash === false, "POST /pages/{id}/restore brings it back");
  check(errorCode(await api("POST", `/pages/${parent}/archive`, R)) === "insufficient_scope", "a read token can't trash pages");

  // Comments
  const thread = await api("POST", `/pages/${pageId}/comments`, W, { text: "Which apricots?", quote: "apricots" });
  check(thread.status === 201 && thread.body.thread_id && thread.body.comment_id, "POST /pages/{id}/comments starts a thread on quoted text", thread.body);
  const reply = await api("POST", `/pages/${pageId}/comments`, W, { text: "The dried ones.", thread_id: thread.body.thread_id });
  check(reply.status === 201 && reply.body.thread_id === thread.body.thread_id, "…and replies in it");
  const comments = await api("GET", `/pages/${pageId}/comments`, R);
  check(
    comments.status === 200 && comments.body.threads.length === 1 && comments.body.threads[0].comments.length === 2,
    "GET /pages/{id}/comments lists the thread with both comments",
    comments.body,
  );
  const noQuote = await api("POST", `/pages/${pageId}/comments`, W, { text: "Hm", quote: "not in the page at all" });
  check(noQuote.status === 400, "quoting text the page doesn't have is a 400");

  // ------------------------------------------------------------------ daily notes
  check(errorCode(await api("POST", `/workspaces/${wsA}/daily-notes`, R, { date: "2026-10-17" })) === "insufficient_scope", "a read token can't make a daily note");
  const note = await api("POST", `/workspaces/${wsA}/daily-notes`, W, { date: "2026-10-17" });
  check(note.status === 200 && note.body.created === true && note.body.date === "2026-10-17" && note.body.title === "October 17, 2026", "POST /workspaces/{id}/daily-notes makes the day's note", note.body);
  const noteAgain = await api("POST", `/workspaces/${wsA}/daily-notes`, W, { date: "2026-10-17" });
  check(noteAgain.body.id === note.body.id && noteAgain.body.created === false, "…and opens the same note again");
  const todayNote = await api("POST", `/workspaces/${wsA}/daily-notes`, W, { time_zone: "Pacific/Kiritimati" });
  check(todayNote.status === 200 && todayNote.body.date === today("Pacific/Kiritimati"), "…for today in the given time zone without a date", todayNote.body);
  check(errorCode(await api("POST", `/workspaces/${wsA}/daily-notes`, W, { time_zone: "Nowhere/Else" })) === "invalid_request", "…refusing an unknown time zone");
  check(errorCode(await api("POST", `/workspaces/${wsA}/daily-notes`, W, { date: "2026-02-30" })) === "invalid_request", "…and a day that doesn't exist");
  const notes = await api("GET", `/workspaces/${wsA}/daily-notes?from=2026-10-01&limit=5`, R);
  check(notes.status === 200 && notes.body.notes.some((n: any) => n.id === note.body.id), "GET /workspaces/{id}/daily-notes lists the user's notes", notes.body);
  check(errorCode(await api("GET", `/workspaces/${wsBob}/daily-notes`, R)) === "not_found", "…not in a workspace they aren't in");

  // ------------------------------------------------------------------ databases and rows
  const database = await createPage({ userId: ids.alice }, { workspaceId: wsA, kind: "database", title: `${RUN} Tasks` });
  const schema = await api("GET", `/databases/${database.id}`, R);
  check(
    schema.status === 200 && schema.body.properties.some((p: any) => p.name === "Status" && p.type === "status"),
    "GET /databases/{id} returns the schema",
    schema.body,
  );
  const readOnlyRow = await api("POST", `/databases/${database.id}/rows`, R, { title: "No" });
  check(errorCode(readOnlyRow) === "insufficient_scope", "a read token can't add rows");
  const row = await api("POST", `/databases/${database.id}/rows`, W, { title: "Alpha", properties: { Status: "In progress" }, markdown: "Row body." });
  check(row.status === 201 && row.body.properties.Status === "In progress", "POST /databases/{id}/rows adds a row with properties", row.body);
  const bulk = await api("POST", `/databases/${database.id}/rows/bulk`, W, {
    rows: [
      { title: "Bravo", properties: { Status: "Done" } },
      { title: "Charlie", properties: { Status: "In progress" } },
      { title: "Delta", properties: { Status: "In progress" } },
    ],
  });
  check(bulk.status === 201 && bulk.body.created === 3, "POST /databases/{id}/rows/bulk adds several rows", bulk.body);
  const badValue = await api("POST", `/databases/${database.id}/rows`, W, { title: "Echo", properties: { Status: "Bogus" } });
  check(badValue.status === 400 && errorCode(badValue) === "invalid_property_value", "an unknown option is a 400 invalid_property_value", badValue.body);
  const badBulk = await api("POST", `/databases/${database.id}/rows/bulk`, W, { rows: [{ title: "ok" }, { title: "bad", properties: { Status: "Bogus" } }] });
  check(badBulk.status === 400, "a bulk insert with one bad row is refused", badBulk.body);
  const afterBad = await api("POST", `/databases/${database.id}/query`, R, { limit: 50 });
  check(afterBad.body.total === 4, "…and adds nothing", afterBad.body.total);

  const q1 = await api("POST", `/databases/${database.id}/query`, R, {
    filters: [{ property: "Status", op: "equals", value: "In progress" }],
    sorts: [{ property: "title", direction: "desc" }],
    limit: 2,
  });
  check(q1.status === 200 && q1.body.total === 3 && q1.body.rows.map((r: any) => r.title).join() === "Delta,Charlie", "POST /databases/{id}/query filters and sorts", q1.body);
  check(q1.body.has_more && q1.body.next_cursor, "…and pages", q1.body);
  const q2 = await api("POST", `/databases/${database.id}/query`, R, {
    filters: [{ property: "Status", op: "equals", value: "In progress" }],
    sorts: [{ property: "title", direction: "desc" }],
    limit: 2,
    cursor: q1.body.next_cursor,
  });
  check(q2.body.rows.map((r: any) => r.title).join() === "Alpha" && q2.body.next_cursor === null && q2.body.returned === 1, "…the cursor gives the last row");
  const badOp = await api("POST", `/databases/${database.id}/query`, R, { filters: [{ property: "Status", op: "sounds_like", value: "x" }] });
  check(badOp.status === 400 && errorCode(badOp) === "validation_error", "an unknown filter op is a validation_error");

  const alpha = row.body.id as string;
  const patched = await api("PATCH", `/rows/${alpha}`, W, { title: "Alpha 2", properties: { Status: "Done" } });
  check(patched.status === 200 && patched.body.title === "Alpha 2" && patched.body.properties.Status === "Done", "PATCH /rows/{id} changes title and properties", patched.body);
  const gotRow = await api("GET", `/rows/${alpha}`, R);
  check(gotRow.status === 200 && gotRow.body.properties.Status === "Done" && gotRow.body.database_id === database.id, "GET /rows/{id} reads a row");
  check(errorCode(await api("GET", `/rows/${pageId}`, R)) === "invalid_request", "GET /rows/{id} on a regular page is a 400");
  const activity = await api("GET", `/rows/${alpha}/activity`, R);
  const statusChange = activity.body.entries?.find((e: any) => e.property === "Status");
  check(
    activity.status === 200 && statusChange?.to === "Done" && statusChange.actor === "user" && activity.body.entries.at(-1).change === "created",
    "GET /rows/{id}/activity lists who changed what",
    activity.body,
  );
  const firstActivity = await api("GET", `/rows/${alpha}/activity?limit=1`, R);
  const nextActivity = await api("GET", `/rows/${alpha}/activity?limit=1&cursor=${firstActivity.body.next_cursor}`, R);
  check(
    firstActivity.body.entries.length === 1 && firstActivity.body.has_more && nextActivity.body.entries.length === 1 && nextActivity.body.entries[0].at <= firstActivity.body.entries[0].at,
    "…a page at a time",
    { firstActivity: firstActivity.body, nextActivity: nextActivity.body },
  );
  const rowIds = bulk.body.rows.map((r: any) => r.id);
  const bulkPatch = await api("PATCH", `/databases/${database.id}/rows`, W, { row_ids: rowIds, properties: { Status: "Not started" } });
  check(bulkPatch.status === 200 && bulkPatch.body.updated === 3, "PATCH /databases/{id}/rows updates many rows", bulkPatch.body);
  const notStarted = await api("POST", `/databases/${database.id}/query`, R, { filters: [{ property: "Status", op: "equals", value: "Not started" }] });
  check(notStarted.body.total === 3, "…and the change shows up in queries");
  check(errorCode(await api("PATCH", `/rows/${alpha}`, R, { title: "no" })) === "insufficient_scope", "a read token can't change rows");

  // ------------------------------------------------------------------ what the user can't see
  const secret = await createPage({ userId: ids.bob }, { workspaceId: wsA, title: `${RUN} Bob's secret` });
  await setPagePermission(ids.bob, secret.id, ids.bob, "full");
  await setPagePermission(ids.bob, secret.id, null, "none");
  const bobsOwn = await createPage({ userId: ids.bob }, { workspaceId: wsBob, title: `${RUN} In Bob's workspace` });
  for (const [label, res] of [
    ["GET /pages/{id}", await api("GET", `/pages/${secret.id}`, W)],
    ["PATCH /pages/{id}", await api("PATCH", `/pages/${secret.id}`, W, { title: "mine now" })],
    ["GET /pages/{id}/comments", await api("GET", `/pages/${secret.id}/comments`, W)],
    ["POST /pages/{id}/archive", await api("POST", `/pages/${secret.id}/archive`, W)],
    ["GET /pages/{id} in another workspace", await api("GET", `/pages/${bobsOwn.id}`, W)],
    ["GET /workspaces/{id}/pages of another workspace", await api("GET", `/workspaces/${wsBob}/pages`, W)],
    ["POST /pages into another workspace", await api("POST", "/pages", W, { workspace_id: wsBob, title: "sneaky" })],
    ["GET /databases/{id} with a page id nobody has", await api("GET", `/databases/${RUN}-nothing`, W)],
  ] as const) {
    check(res.status === 404 && errorCode(res) === "not_found", `a page the user can't see: ${label} is 404 not_found`, res.body);
  }
  const hiddenSearch = await api("GET", `/search?query=${encodeURIComponent(`${RUN} Bob`)}`, W);
  // With an embeddings model on the server, pages that merely look alike (the run's prefix) may
  // come back by meaning; they're pages the user can see.
  const hiddenIds = hiddenSearch.body.results.map((r: { id: string }) => r.id);
  check(
    !hiddenIds.includes(secret.id) && !hiddenIds.includes(bobsOwn.id) && hiddenSearch.body.results.every((r: { match: string }) => r.match === "semantic"),
    "search leaves out pages the user can't see",
    hiddenSearch.body,
  );
  check((await api("GET", `/pages/${secret.id}`, (await createApiToken(ids.bob, { name: "bob", scopes: ["pages:read"] })).secret)).status === 200, "…while their owner reads them");

  // ------------------------------------------------------------------ workspace-bound tokens
  const pageInB = (await api("POST", "/pages", W, { workspace_id: wsB, title: `${RUN} In B` })).body.id as string;
  const boundWorkspaces = await api("GET", "/workspaces", B);
  check(boundWorkspaces.body.workspaces.map((w: any) => w.id).join() === wsA, "a bound token lists only its workspace");
  check(errorCode(await api("GET", `/pages/${pageInB}`, B)) === "not_found", "…can't read pages of the user's other workspaces");
  check(errorCode(await api("GET", `/search?query=x&workspace_id=${wsB}`, B)) === "not_found", "…can't search them");
  const boundSearch = await api("GET", `/search?query=${encodeURIComponent(RUN)}&limit=50`, B);
  check(boundSearch.body.results.length > 0 && boundSearch.body.results.every((r: any) => r.workspace_id === wsA), "…and its searches stay in its workspace");
  check(errorCode(await api("POST", "/pages", B, { workspace_id: wsB, title: "no" })) === "not_found", "…can't create pages elsewhere");
  check(errorCode(await api("POST", "/pages", B, { parent_id: pageInB, title: "no" })) === "not_found", "…not even under a page elsewhere");
  const boundCreate = await api("POST", "/pages", B, { title: `${RUN} Defaulted` });
  check(boundCreate.status === 201 && boundCreate.body.workspace_id === wsA, "…and creates top-level pages in its own workspace by default");
  check(errorCode(await api("POST", `/pages/${pageId}/move`, B, { parent_id: pageInB })) === "not_found", "…can't move pages into another workspace");
  check((await api("GET", `/pages/${pageId}`, B)).status === 200, "…but works inside its workspace");

  // ------------------------------------------------------------------ expiry and revocation
  await db.update(apiToken).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiToken.id, read.token.id));
  const expired = await api("GET", "/me", R);
  check(expired.status === 401 && errorCode(expired) === "token_expired", "an expired token gets 401 token_expired");
  check(await revokeApiToken(ids.alice, boundA.token.id), "revoking a token deletes it");
  const revoked = await api("GET", "/me", B);
  check(revoked.status === 401 && errorCode(revoked) === "invalid_token", "a revoked token gets 401 invalid_token");
  check(!(await revokeApiToken(ids.bob, write.token.id)), "nobody can revoke someone else's token");
  check((await api("GET", "/me", W)).status === 200, "…which keeps working");

  // ------------------------------------------------------------------ errors and limits
  const unknown = await api("GET", "/nothing-here", W);
  check(unknown.status === 404 && errorCode(unknown) === "not_found", "an unknown endpoint is a JSON 404");
  const wrongMethod = await api("DELETE", `/pages/${pageId}`, W);
  check(wrongMethod.status === 405 && wrongMethod.headers.get("allow") === "GET, PATCH", "a wrong method is a 405 with Allow", wrongMethod.headers.get("allow"));
  const huge = await api("POST", "/pages", W, { workspace_id: wsA, title: "big", markdown: "x".repeat(6 * 1024 * 1024) });
  check(huge.status === 413 && errorCode(huge) === "payload_too_large", "bodies over 5 MB are a 413");

  const limited = await createApiToken(ids.alice, { name: "e2e rate", scopes: ["pages:read"] });
  const statuses: number[] = [];
  let retryAfter: string | null = null;
  for (let batch = 0; batch < 10 && !statuses.includes(429); batch++) {
    const results = await Promise.all(Array.from({ length: 20 }, () => api("GET", "/me", limited.secret)));
    for (const res of results) {
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get("retry-after");
    }
  }
  check(statuses.filter((s) => s === 200).length === 180 && statuses.includes(429), "the 181st request in a minute is rate limited", statuses.length);
  check(Number(retryAfter) > 0, "…with Retry-After");
  check((await api("GET", "/me", W)).status === 200, "…while other tokens keep their own allowance");

  // ------------------------------------------------------------------ OpenAPI and docs
  const openapi = await api("GET", "/openapi.json");
  check(openapi.status === 200 && openapi.body.openapi === "3.1.0", "GET /openapi.json serves OpenAPI 3.1 without a token");
  check(openapi.body.servers[0].url === API, "…pointing at this server's /api/v1");
  const documented = Object.entries(openapi.body.paths).flatMap(([path, methods]) => Object.keys(methods as object).map((m) => `${m.toUpperCase()} ${path}`));
  check(
    documented.length === API_ROUTES.length && API_ROUTES.every((r) => documented.includes(`${r.method} ${r.path}`)),
    "…describing every endpoint",
    documented,
  );
  const refsOk = JSON.stringify(openapi.body)
    .match(/"\$ref":"([^"]+)"/g)!
    .map((m) => m.slice(8, -1))
    .every((ref) => ref.slice(2).split("/").reduce((node: any, key) => node?.[key], openapi.body) !== undefined);
  check(refsOk, "…whose references all resolve");
  const docs = await fetch(`${BASE}/docs/api`);
  const html = await docs.text();
  check(docs.status === 200 && html.includes("Leafdesk REST API") && html.includes("/databases/{database_id}/query"), "GET /docs/api renders the reference");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [wsA, wsB, wsBob]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
