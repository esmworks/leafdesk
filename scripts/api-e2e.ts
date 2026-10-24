/**
 * End-to-end check of the REST API (/api/v1) against a running app (`pnpm dev`): personal access
 * tokens (scopes per resource, tokens from before them, changing a token's scopes, workspace
 * binding, expiry, revocation, last use), every endpoint, pagination, pages the user can't see,
 * writes refused to read-only tokens, idempotency keys, rate limiting and its headers, CORS being
 * off, errors (with `param`), and the OpenAPI document and docs page. Creates its own users and
 * workspaces in the database and deletes them afterwards.
 *
 *   pnpm tsx scripts/api-e2e.ts
 *
 * Env: APP_URL (default http://localhost:3000) and DATABASE_URL, read from .env when present. The
 * server must use the default rate limit (API_RATE_LIMIT unset) and share the database.
 */
import { API_TOKEN_SCOPES as ALL_SCOPES, READ_SCOPES } from "@/lib/api-scopes";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { apiIdempotencyKey, apiToken, mailbox, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { addProperty } = await import("@/server/databases");
const { setMailDatabases } = await import("@/server/row-mail/settings");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { createSequence } = await import("@/server/sequences/manage");
const { createApiToken, revokeApiToken, listApiTokens, updateApiTokenScopes, verifyApiToken } = await import("@/server/api/tokens");
const { pruneIdempotencyKeys } = await import("@/server/api/idempotency");
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

/** Whether a query on the database waits for a lock within a few seconds. */
async function waitingForLock() {
  for (let i = 0; i < 100; i++) {
    const [row] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
    );
    if (row.n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const ids = { alice: `${RUN}-alice`, bob: `${RUN}-bob` };
const userIds = Object.values(ids);
const wsA = `${RUN}-ws-a`;
const wsB = `${RUN}-ws-b`;
const wsBob = `${RUN}-ws-bob`;
/** Fails page inserts with one title, for a server failure to retry after (dropped at the end). */
const BOOM = `api_e2e_boom_${RUN.replace(/\W/g, "_")}`;

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
  const write = await createApiToken(ids.alice, { name: "e2e write", scopes: ALL_SCOPES, expiresInDays: 30 });
  const read = await createApiToken(ids.alice, { name: "e2e read", scopes: READ_SCOPES });
  const boundA = await createApiToken(ids.alice, { name: "e2e bound", scopes: ALL_SCOPES, workspaceId: wsA });
  check(/^esi_[A-Za-z0-9]{40}$/.test(write.secret), "a token is esi_ plus 40 letters and digits");
  check(write.token.scopes.length === ALL_SCOPES.length && !write.token.legacyScopes, "a new token gets the scopes asked for, not legacy ones");
  check(write.token.tokenHash !== write.secret && !write.token.tokenHash.includes(write.secret.slice(4)), "only a hash of the secret is stored");
  check(Math.abs(write.token.expiresAt!.getTime() - Date.now() - 30 * 86_400_000) < 60_000, "expiry is set 30 days out");
  const listed = await listApiTokens(ids.alice);
  check(listed.length === 3 && listed.every((t) => t.prefix.startsWith("esi_") && t.prefix.length === 8), "tokens are listed with a short prefix");
  check(listed.find((t) => t.id === boundA.token.id)?.workspaceName === `${RUN} A`, "the list names a bound token's workspace");
  let refused = await createApiToken(ids.alice, { name: "x", scopes: READ_SCOPES, workspaceId: wsBob }).catch((e) => e);
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
  check(
    readOnlyCreate.status === 403 && errorCode(readOnlyCreate) === "insufficient_scope" && readOnlyCreate.body.error.details.scope === "pages:write",
    "a read token can't create pages, and is told the scope it lacks",
    readOnlyCreate.body,
  );
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
  check(badTitle.body.error.param === "title", "…and param names the field", badTitle.body);
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
  check(errorCode(await api("GET", "/search", R)) === "validation_error", "search needs a query or a filter");
  const mine = await api("GET", `/search?created_by=me&edited_after=${new Date(Date.now() - 3_600_000).toISOString()}&limit=50`, R);
  check(
    mine.status === 200 && mine.body.results.some((r: any) => r.title.includes(`${RUN} Child`)),
    "GET /search lists the pages a filter matches without a query (created by me, edited in the last hour)",
    mine.body,
  );
  const nobody = await api("GET", `/search?query=${encodeURIComponent(`${RUN} Child`)}&created_by=nobody`, R);
  check(nobody.status === 200 && nobody.body.results.length === 0, "…and narrows a query (created by someone who made none)");
  const later = await api("GET", `/search?query=${encodeURIComponent(`${RUN} Child`)}&created_after=2999-01-01`, R);
  check(later.status === 200 && later.body.results.length === 0, "…a day alone counts from its start");
  check(errorCode(await api("GET", "/search?edited_after=yesterday", R)) === "validation_error", "…and a time it can't read is a 400");
  const phrase = await api("GET", `/search?query=${encodeURIComponent(`"Child ${RUN}"`)}`, R);
  check(phrase.status === 200 && phrase.body.results.length === 0, "a quoted phrase needs its words in that order", phrase.body);

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
  check(badValue.body.error.param === "properties.Status", "…whose param names the property", badValue.body);
  const unknownProperty = await api("POST", `/databases/${database.id}/rows`, W, { title: "Echo", properties: { Colour: "red" } });
  check(unknownProperty.body.error?.param === "properties.Colour", "…as it does an unknown property", unknownProperty.body);
  const badBulk = await api("POST", `/databases/${database.id}/rows/bulk`, W, { rows: [{ title: "ok" }, { title: "bad", properties: { Status: "Bogus" } }] });
  check(badBulk.status === 400, "a bulk insert with one bad row is refused", badBulk.body);
  check(badBulk.body.error.param === "rows.1.properties.Status", "…naming the row and property in param", badBulk.body);
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
  const badPatchValue = await api("PATCH", `/rows/${alpha}`, W, { properties: { Status: "Bogus" } });
  check(badPatchValue.body.error?.param === "properties.Status", "a bad value in PATCH /rows/{id} names the property in param", badPatchValue.body);

  // ------------------------------------------------------------------ follow-ups
  // A mailbox stored as connecting one would (never reached: the sequence's first step is days away).
  const leads = await createPage({ userId: ids.alice }, { workspaceId: wsA, kind: "database", title: `${RUN} Leads` });
  const leadEmail = await addProperty(ids.alice, leads.id, { name: "Email", type: "email" });
  await updateWorkspaceSettings(ids.alice, wsA, { email: true });
  await setMailDatabases(ids.alice, wsA, [{ databaseId: leads.id, propertyIds: [leadEmail.id] }]);
  await db.insert(mailbox).values({
    workspaceId: wsA,
    userId: ids.alice,
    address: `alice.${RUN}@example.test`,
    imapHost: "127.0.0.1",
    imapPort: 1,
    imapSecure: false,
    smtpHost: "127.0.0.1",
    smtpPort: 1,
    smtpSecure: false,
    username: "alice",
    secret: "unused",
    consentedAt: new Date(),
  });
  const sequence = await createSequence(ids.alice, leads.id, { name: "Nudge", steps: [{ days: 30, subject: "Hello", text: "Hi {{Name | there}}, any news?", mode: "auto" }] });
  const lead = await createPage({ userId: ids.alice }, { workspaceId: wsA, parentId: leads.id, title: "Lead", properties: { [leadEmail.id]: `lead.${RUN}@example.test` } });
  const noAddress = await createPage({ userId: ids.alice }, { workspaceId: wsA, parentId: leads.id, title: "No address" });
  const sequences = await api("GET", `/databases/${leads.id}/sequences`, R);
  check(sequences.status === 200 && sequences.body.sequences?.[0]?.name === "Nudge" && sequences.body.sequences[0].steps[0].mode === "send", "GET /databases/{id}/sequences lists its follow-ups", sequences.body);
  check(errorCode(await api("POST", `/sequences/${sequence.id}/enrollments`, R, { row_ids: [lead.id] })) === "insufficient_scope", "a read token can't start one");
  const started = await api("POST", `/sequences/${sequence.id}/enrollments`, W, { row_ids: [lead.id, noAddress.id] });
  check(
    started.status === 200 && started.body.started === 1 && started.body.rows[1].skipped === "noAddress",
    "POST /sequences/{id}/enrollments starts it on rows, skipping one without an address",
    started.body,
  );
  const again = await api("POST", `/sequences/${sequence.id}/enrollments`, W, { row_ids: [lead.id] });
  check(again.body.started === 0 && again.body.rows[0].skipped === "alreadyEnrolled", "…and a row already in it", again.body);
  const enrollment = started.body.rows[0].enrollment;
  check(enrollment.status === "active" && enrollment.source === "api" && enrollment.steps === 1, "…saying where it stands", enrollment);
  const going = await api("GET", `/enrollments?row_id=${lead.id}`, R);
  check(going.status === 200 && going.body.enrollments?.length === 1 && going.body.enrollments[0].id === enrollment.id, "GET /enrollments lists a row's", going.body);
  check(errorCode(await api("GET", "/enrollments", R)) === "invalid_request", "…and needs something to narrow them by");
  const stopped = await api("POST", `/enrollments/${enrollment.id}/stop`, W);
  check(stopped.status === 200 && stopped.body.status === "stopped" && stopped.body.reason === "manual", "POST /enrollments/{id}/stop stops it", stopped.body);
  const stoppedAgain = await api("POST", `/enrollments/${enrollment.id}/stop`, W);
  check(stoppedAgain.status === 409 && errorCode(stoppedAgain) === "follow_up_ended", "…once", stoppedAgain.body);
  check((await api("POST", `/enrollments/${enrollment.id}/resume`, W)).status === 409, "a stopped one can't be resumed");
  check((await api("GET", `/enrollments?row_id=${lead.id}&status=all`, R)).body.enrollments?.length === 1, "…but is still listed with status=all");
  check((await api("POST", `/sequences/${RUN}-nope/enrollments`, W, { row_ids: [lead.id] })).status === 404, "an unknown sequence is a 404");

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
  check((await api("GET", `/pages/${secret.id}`, (await createApiToken(ids.bob, { name: "bob", scopes: READ_SCOPES })).secret)).status === 200, "…while their owner reads them");

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

  // ------------------------------------------------------------------ scopes per resource
  const scoped = async (name: string, scopes: string[]) => (await createApiToken(ids.alice, { name: `${RUN} ${name}`, scopes })).secret;
  const pagesOnly = await scoped("pages only", ["pages:read"]);
  const rowsWriter = await scoped("rows writer", ["rows:write"]);
  const commentsReader = await scoped("comments reader", ["comments:read"]);
  const agentsReader = await scoped("agents reader", ["agents:read", "workspaces:read"]);
  const denied = async (method: string, path: string, token: string, scope: string, body?: unknown) => {
    const res = await api(method, path, token, body);
    check(
      res.status === 403 && errorCode(res) === "insufficient_scope" && res.body.error.details?.scope === scope &&
        res.headers.get("www-authenticate")?.includes(`scope="${scope}"`),
      `${method} ${path.replace(RUN, "…")} needs ${scope}`,
      { status: res.status, body: res.body },
    );
  };
  check((await api("GET", `/pages/${pageId}`, pagesOnly)).status === 200, "pages:read reads pages");
  check((await api("GET", `/pages/${parent}/children`, pagesOnly)).status === 200, "…and their sub-pages");
  await denied("GET", "/workspaces", pagesOnly, "workspaces:read");
  await denied("GET", `/search?query=${RUN}`, pagesOnly, "search:read");
  await denied("GET", `/databases/${database.id}`, pagesOnly, "databases:read");
  await denied("POST", `/databases/${database.id}/query`, pagesOnly, "rows:read", {});
  await denied("GET", `/pages/${pageId}/comments`, pagesOnly, "comments:read");
  await denied("PATCH", `/pages/${pageId}`, pagesOnly, "pages:write", { title: "no" });
  const scopedRow = await api("POST", `/databases/${database.id}/rows`, rowsWriter, { title: "Foxtrot" });
  check(scopedRow.status === 201, "rows:write adds rows", scopedRow.body);
  check((await api("GET", `/rows/${scopedRow.body.id}`, rowsWriter)).status === 200, "…and reads them, write bringing read");
  check((await api("PATCH", `/rows/${scopedRow.body.id}`, rowsWriter, { title: "Foxtrot 2" })).status === 200, "…and changes them");
  await denied("PATCH", `/pages/${scopedRow.body.id}`, rowsWriter, "pages:write", { markdown: "no" });
  await denied("GET", `/databases/${database.id}`, rowsWriter, "databases:read");
  check((await api("GET", `/pages/${pageId}/comments`, commentsReader)).status === 200, "comments:read reads comments");
  await denied("POST", `/pages/${pageId}/comments`, commentsReader, "comments:write", { text: "no", thread_id: thread.body.thread_id });
  check((await api("GET", `/workspaces/${wsA}/agents`, agentsReader)).status === 200, "agents:read lists agents");
  await denied("GET", `/workspaces/${wsA}/teamspaces`, commentsReader, "workspaces:read");
  const anyMe = await api("GET", "/me", commentsReader);
  check(anyMe.status === 200 && anyMe.body.token.scopes.join() === "comments:read" && anyMe.body.token.legacy_scopes === false, "GET /me takes any token", anyMe.body);

  // ------------------------------------------------------------------ tokens from before scopes per resource
  const legacyToken = async (name: string, scopes: string[]) => {
    const made = await createApiToken(ids.alice, { name: `${RUN} ${name}`, scopes: READ_SCOPES });
    // As migration 0107 left the tokens there were: their scopes as stored, marked legacy.
    await db.update(apiToken).set({ scopes, legacyScopes: true }).where(eq(apiToken.id, made.token.id));
    return made;
  };
  const oldRead = await legacyToken("old read", ["pages:read"]);
  const oldWrite = await legacyToken("old write", ["pages:read", "pages:write"]);
  const oldMe = await api("GET", "/me", oldRead.secret);
  check(
    oldMe.body.token.legacy_scopes === true && oldMe.body.token.scopes.join() === READ_SCOPES.join() && !oldMe.body.token.scopes.includes("pages:write"),
    "a legacy pages:read token reads as every read scope",
    oldMe.body,
  );
  for (const [label, method, path, body] of [
    ["lists workspaces", "GET", "/workspaces"],
    ["searches", "GET", `/search?query=${encodeURIComponent(RUN)}`],
    ["reads a database", "GET", `/databases/${database.id}`],
    ["queries rows", "POST", `/databases/${database.id}/query`, {}],
    ["reads a row's activity", "GET", `/rows/${alpha}/activity`],
    ["reads comments", "GET", `/pages/${pageId}/comments`],
    ["lists agents", "GET", `/workspaces/${wsA}/agents`],
    ["lists teamspaces", "GET", `/workspaces/${wsA}/teamspaces`],
  ] as const) {
    const res = await api(method, path, oldRead.secret, body);
    check(res.status === 200, `…and still ${label}`, res.body);
  }
  await denied("POST", "/pages", oldRead.secret, "pages:write", { workspace_id: wsA, title: "no" });
  await denied("POST", `/databases/${database.id}/rows`, oldRead.secret, "rows:write", { title: "no" });
  const oldWriteMe = await api("GET", "/me", oldWrite.secret);
  check(oldWriteMe.body.token.scopes.length === ALL_SCOPES.length, "a legacy pages:write token reads as every scope", oldWriteMe.body);
  for (const [label, method, path, body, status] of [
    ["creates pages", "POST", "/pages", { workspace_id: wsA, title: `${RUN} Old token page` }, 201],
    ["adds rows", "POST", `/databases/${database.id}/rows`, { title: "Golf" }, 201],
    ["changes rows", "PATCH", `/rows/${alpha}`, { title: "Alpha 3" }, 200],
    ["comments", "POST", `/pages/${pageId}/comments`, { text: "Still here.", thread_id: thread.body.thread_id }, 201],
    ["reads", "GET", `/databases/${database.id}`, undefined, 200],
  ] as const) {
    const res = await api(method, path, oldWrite.secret, body);
    check(res.status === status, `…and still ${label}`, res.body);
  }
  const listedOld = (await listApiTokens(ids.alice)).find((t) => t.id === oldWrite.token.id);
  check(listedOld?.legacyScopes === true && listedOld.scopes.length === ALL_SCOPES.length, "settings list a legacy token with what it stands for");

  // Changing what a token may do keeps its secret and ends its legacy reading.
  await updateApiTokenScopes(ids.alice, oldWrite.token.id, ["rows:read"]);
  const narrowed = await api("GET", "/me", oldWrite.secret);
  check(narrowed.status === 200 && narrowed.body.token.scopes.join() === "rows:read" && narrowed.body.token.legacy_scopes === false, "a token's scopes change without a new secret", narrowed.body);
  await denied("POST", "/pages", oldWrite.secret, "pages:write", { workspace_id: wsA, title: "no" });
  check((await api("GET", `/rows/${alpha}`, oldWrite.secret)).status === 200, "…and it does what it may now");
  await updateApiTokenScopes(ids.alice, oldWrite.token.id, ["pages:write", "rows:write"]);
  check((await api("GET", "/me", oldWrite.secret)).body.token.scopes.join() === "pages:read,pages:write,rows:read,rows:write", "…and can be widened again");
  refused = await updateApiTokenScopes(ids.alice, oldWrite.token.id, ["files:write"]).catch((e) => e);
  check(refused?.code === "scopes", "unknown scopes can't be set");
  refused = await updateApiTokenScopes(ids.bob, oldWrite.token.id, ["pages:read"]).catch((e) => e);
  check(refused?.code === "notFound", "nobody changes someone else's token");

  // ------------------------------------------------------------------ idempotency keys
  const idem = (await createApiToken(ids.alice, { name: `${RUN} idempotency`, scopes: ALL_SCOPES, workspaceId: wsA })).secret;
  const keyed = (method: string, path: string, key: string, body?: unknown, token = idem) => api(method, path, token, body, { "idempotency-key": key });
  const keyRow = async (key: string) =>
    (await db.select().from(apiIdempotencyKey).where(eq(apiIdempotencyKey.key, key)))[0] as typeof apiIdempotencyKey.$inferSelect | undefined;
  const pagesTitled = async (title: string) => (await db.execute<{ n: number }>(sql`select count(*)::int as n from page where title = ${title}`))[0].n;

  const k1 = `${RUN}-k1`;
  const once = await keyed("POST", "/pages", k1, { workspace_id: wsA, title: `${RUN} Once` });
  check(once.status === 201 && once.headers.get("idempotent-replayed") === null, "a write with an Idempotency-Key runs", once.body);
  const replay = await keyed("POST", "/pages", k1, { workspace_id: wsA, title: `${RUN} Once` });
  check(
    replay.status === 201 && replay.headers.get("idempotent-replayed") === "true" && JSON.stringify(replay.body) === JSON.stringify(once.body),
    "the same request with the same key answers the first answer again, marked replayed",
    { replay: replay.body, headers: Object.fromEntries(replay.headers) },
  );
  check(replay.headers.get("x-ratelimit-remaining") !== null, "…with the rate limit headers of now");
  check((await pagesTitled(`${RUN} Once`)) === 1, "…without making the page twice");
  const reordered = await api("POST", "/pages", idem, `{"title": "${RUN} Once",   "workspace_id": "${wsA}"}`, { "idempotency-key": k1, "content-type": "application/json" });
  check(reordered.headers.get("idempotent-replayed") === "true", "…however the same JSON is written");
  const reused = await keyed("POST", "/pages", k1, { workspace_id: wsA, title: `${RUN} Twice` });
  check(reused.status === 422 && errorCode(reused) === "idempotency_key_reused", "the same key with another body is a 422 idempotency_key_reused", reused.body);
  check((await pagesTitled(`${RUN} Twice`)) === 0, "…and changes nothing");
  const archiveKey = `${RUN}-archive`;
  check((await keyed("POST", `/pages/${once.body.id}/archive`, archiveKey)).status === 200, "a key on a path with an id runs");
  const otherPath = await keyed("POST", `/pages/${pageId}/archive`, archiveKey);
  check(otherPath.status === 422 && errorCode(otherPath) === "idempotency_key_reused", "…and the key on another page of the same endpoint is another request", otherPath.body);
  check((await api("GET", `/pages/${pageId}`, R)).body.in_trash === false, "…which isn't trashed");
  const otherToken = await keyed("POST", "/pages", k1, { workspace_id: wsA, title: `${RUN} Other token` }, W);
  check(otherToken.status === 201 && otherToken.headers.get("idempotent-replayed") === null, "another token's key of the same name is its own");
  const queryKey = `${RUN}-query`;
  const firstQuery = await keyed("POST", `/databases/${database.id}/query`, queryKey, {});
  const secondQuery = await keyed("POST", `/databases/${database.id}/query`, queryKey, { limit: 1 });
  check(firstQuery.status === 200 && secondQuery.status === 200 && secondQuery.headers.get("idempotent-replayed") === null && !(await keyRow(queryKey)), "a query (which changes nothing) ignores the key");
  const longKey = await keyed("POST", "/pages", "k".repeat(256), { workspace_id: wsA, title: "long" });
  check(longKey.status === 400 && errorCode(longKey) === "invalid_idempotency_key", "a key over 255 characters is a 400 invalid_idempotency_key", longKey.body);
  check((await keyed("POST", "/pages", `${RUN}-${"k".repeat(200)}`, { workspace_id: wsA, title: `${RUN} Long key` })).status === 201, "…while 255 are fine");
  const invalidKey = `${RUN}-invalid`;
  const invalid = await keyed("POST", "/pages", invalidKey, { workspace_id: wsA, title: 5 });
  check(invalid.status === 400 && !(await keyRow(invalidKey)), "an invalid request keeps nothing under its key");
  check((await keyed("POST", "/pages", invalidKey, { workspace_id: wsA, title: `${RUN} Fixed` })).status === 201, "…so the corrected request runs with it");
  const missingKey = `${RUN}-missing`;
  check(errorCode(await keyed("POST", `/databases/${database.id}/rows`, missingKey, { title: "no" }, pagesOnly)) === "insufficient_scope" && !(await keyRow(missingKey)), "a missing scope keeps nothing either");
  const notFoundKey = `${RUN}-not-found`;
  const gone = await keyed("PATCH", `/rows/${RUN}-nothing`, notFoundKey, { title: "x" });
  const goneAgain = await keyed("PATCH", `/rows/${RUN}-nothing`, notFoundKey, { title: "x" });
  check(gone.status === 404 && goneAgain.status === 404 && goneAgain.headers.get("idempotent-replayed") === "true", "a 4xx answer is kept like any other");

  // While the first request still runs: hold the page's row so its PATCH waits.
  const heldKey = `${RUN}-held`;
  let locked!: () => void;
  let unlock!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const unlocking = new Promise<void>((resolve) => (unlock = resolve));
  const holding = db.transaction(async (tx) => {
    await tx.execute(sql`select id from page where id = ${pageId} for update`);
    locked();
    await unlocking;
  });
  await isLocked;
  const slow = keyed("PATCH", `/pages/${pageId}`, heldKey, { title: `${RUN} Notes held` });
  const waited = await waitingForLock();
  const meanwhile = await keyed("PATCH", `/pages/${pageId}`, heldKey, { title: `${RUN} Notes held` });
  unlock();
  await holding;
  const slowDone = await slow;
  check(waited && meanwhile.status === 409 && errorCode(meanwhile) === "idempotency_conflict" && meanwhile.headers.get("retry-after") === "1", "a retry while the first request runs is a 409 idempotency_conflict", { waited, body: meanwhile.body });
  check(slowDone.status === 200, "…and the first request finishes", slowDone.body);
  check((await keyed("PATCH", `/pages/${pageId}`, heldKey, { title: `${RUN} Notes held` })).headers.get("idempotent-replayed") === "true", "…after which the key replays its answer");
  const burstKey = `${RUN}-burst`;
  const burst = await Promise.all(Array.from({ length: 6 }, () => keyed("POST", "/pages", burstKey, { workspace_id: wsA, title: `${RUN} Burst` })));
  const ran = burst.filter((r) => r.status === 201 && r.headers.get("idempotent-replayed") === null);
  check(
    ran.length === 1 && burst.every((r) => r.status === 201 || errorCode(r) === "idempotency_conflict") && (await pagesTitled(`${RUN} Burst`)) === 1,
    "of requests racing with one key, exactly one runs",
    burst.map((r) => [r.status, r.headers.get("idempotent-replayed")]),
  );

  // A server failure isn't kept: the retry runs again.
  await db.execute(
    sql.raw(`create function ${BOOM}() returns trigger language plpgsql as $$ begin if new.title = '${RUN} Boom' then raise exception 'boom'; end if; return new; end $$`),
  );
  await db.execute(sql.raw(`create trigger ${BOOM} before insert on page for each row execute function ${BOOM}()`));
  const boomKey = `${RUN}-boom`;
  const failed = await keyed("POST", "/pages", boomKey, { workspace_id: wsA, title: `${RUN} Boom` });
  check(failed.status === 500 && errorCode(failed) === "internal_error" && !(await keyRow(boomKey)), "a 5xx answer keeps nothing under its key", failed.body);
  await db.execute(sql.raw(`drop trigger ${BOOM} on page`));
  const retried = await keyed("POST", "/pages", boomKey, { workspace_id: wsA, title: `${RUN} Boom` });
  check(retried.status === 201 && retried.headers.get("idempotent-replayed") === null && (await keyRow(boomKey))?.status === 201, "…so its retry runs and is kept", retried.body);

  // Keys last 24 hours.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000 - 60_000);
  await db.update(apiIdempotencyKey).set({ createdAt: dayAgo }).where(eq(apiIdempotencyKey.key, k1));
  const afterExpiry = await keyed("POST", "/pages", k1, { workspace_id: wsA, title: `${RUN} After a day` });
  check(afterExpiry.status === 201 && afterExpiry.headers.get("idempotent-replayed") === null, "a key older than 24 hours is free again, whatever it was used for", afterExpiry.body);
  await db.update(apiIdempotencyKey).set({ createdAt: dayAgo }).where(inArray(apiIdempotencyKey.key, [k1, archiveKey]));
  const unbound = (await verifyApiToken(W)) as { ok: true; principal: { tokenId: string } };
  await db.update(apiIdempotencyKey).set({ createdAt: dayAgo }).where(eq(apiIdempotencyKey.tokenId, unbound.principal.tokenId));
  const prunedHere = await pruneIdempotencyKeys({ workspaceIds: [wsA] });
  const kept = await db.select({ key: apiIdempotencyKey.key, tokenId: apiIdempotencyKey.tokenId }).from(apiIdempotencyKey).where(inArray(apiIdempotencyKey.key, [k1, archiveKey, boomKey]));
  check(
    prunedHere >= 2 && kept.every((k) => k.key === boomKey || k.tokenId === unbound.principal.tokenId) && kept.some((k) => k.key === boomKey),
    "the retention run deletes keys older than 24 hours (narrowed to tokens of the run's workspaces) and keeps newer ones",
    { prunedHere, kept },
  );
  const prunedAll = await pruneIdempotencyKeys();
  const leftOfW = await db.select({ key: apiIdempotencyKey.key }).from(apiIdempotencyKey).where(eq(apiIdempotencyKey.tokenId, unbound.principal.tokenId));
  check(prunedAll >= 1 && leftOfW.length === 0, "…and, unnarrowed, every token's", { prunedAll, leftOfW });

  // ------------------------------------------------------------------ expiry and revocation
  await db.update(apiToken).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiToken.id, read.token.id));
  const expired = await api("GET", "/me", R);
  check(expired.status === 401 && errorCode(expired) === "token_expired", "an expired token gets 401 token_expired");
  check(await revokeApiToken(ids.alice, boundA.token.id), "revoking a token deletes it");
  const revoked = await api("GET", "/me", B);
  check(revoked.status === 401 && errorCode(revoked) === "invalid_token", "a revoked token gets 401 invalid_token");
  check(!(await revokeApiToken(ids.bob, write.token.id)), "nobody can revoke someone else's token");
  check((await api("GET", "/me", W)).status === 200, "…which keeps working");
  // Deleted while a request with it waits to record when it was used: the deletion commits first.
  const raced = await createApiToken(ids.alice, { name: `${RUN} raced`, scopes: READ_SCOPES });
  let deleted!: () => void;
  let commit!: () => void;
  const isDeleted = new Promise<void>((resolve) => (deleted = resolve));
  const committing = new Promise<void>((resolve) => (commit = resolve));
  const deletion = db.transaction(async (tx) => {
    await tx.delete(apiToken).where(eq(apiToken.id, raced.token.id));
    deleted();
    await committing;
  });
  await isDeleted;
  const racing = Promise.allSettled([verifyApiToken(raced.secret)]);
  const waits = await waitingForLock();
  commit();
  await deletion;
  const [raceResult] = await racing;
  check(
    waits && raceResult.status === "fulfilled" && !raceResult.value.ok && raceResult.value.reason === "invalid",
    "a token deleted while a request waits to record its use is refused",
    { waits, raceResult },
  );

  // ------------------------------------------------------------------ errors and limits
  const unknown = await api("GET", "/nothing-here", W);
  check(unknown.status === 404 && errorCode(unknown) === "not_found", "an unknown endpoint is a JSON 404");
  const wrongMethod = await api("DELETE", `/pages/${pageId}`, W);
  check(wrongMethod.status === 405 && wrongMethod.headers.get("allow") === "GET, PATCH", "a wrong method is a 405 with Allow", wrongMethod.headers.get("allow"));
  const huge = await api("POST", "/pages", W, { workspace_id: wsA, title: "big", markdown: "x".repeat(6 * 1024 * 1024) });
  check(huge.status === 413 && errorCode(huge) === "payload_too_large", "bodies over 5 MB are a 413");

  const limited = await createApiToken(ids.alice, { name: "e2e rate", scopes: READ_SCOPES });
  const startedAt = Math.floor(Date.now() / 1000);
  const firstLimited = await api("GET", "/me", limited.secret);
  const firstReset = Number(firstLimited.headers.get("x-ratelimit-reset"));
  check(
    firstLimited.headers.get("x-ratelimit-limit") === "180" && firstLimited.headers.get("x-ratelimit-remaining") === "179" && firstReset >= startedAt + 59 && firstReset <= startedAt + 62,
    "every answer says the limit, what is left and when one more request is allowed again (Unix seconds)",
    Object.fromEntries(firstLimited.headers),
  );
  const notFoundLimited = await api("GET", `/pages/${RUN}-nothing`, limited.secret);
  check(notFoundLimited.status === 404 && notFoundLimited.headers.get("x-ratelimit-remaining") === "178" && Number(notFoundLimited.headers.get("x-ratelimit-reset")) === firstReset, "…errors too");
  const deniedLimited = await api("POST", "/pages", limited.secret, { title: "no" });
  check(deniedLimited.status === 403 && deniedLimited.headers.get("x-ratelimit-reset") !== null, "…a missing scope too");
  const statuses: number[] = [200, 404, 403];
  let retryAfter: string | null = null;
  let tooMany: Res | null = null;
  for (let batch = 0; batch < 10 && !statuses.includes(429); batch++) {
    const results = await Promise.all(Array.from({ length: 20 }, () => api("GET", "/me", limited.secret)));
    for (const res of results) {
      statuses.push(res.status);
      if (res.status === 429) {
        retryAfter = res.headers.get("retry-after");
        tooMany = res;
      }
    }
  }
  check(statuses.filter((s) => s !== 429).length === 180 && statuses.includes(429), "the 181st request in a minute is rate limited", statuses.length);
  check(Number(retryAfter) > 0 && Number(retryAfter) <= 60, "…with Retry-After in seconds", retryAfter);
  check(
    tooMany?.headers.get("x-ratelimit-remaining") === "0" && Math.abs(Number(tooMany.headers.get("x-ratelimit-reset")) - (Math.floor(Date.now() / 1000) + Number(retryAfter))) <= 2,
    "…and X-RateLimit-Reset when it ends",
    tooMany && Object.fromEntries(tooMany.headers),
  );
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
  check(html.includes("comments:write") && html.includes("Idempotency-Key"), "…with the scopes and idempotency keys");
  check(openapi.body.paths["/pages"].post["x-scope"] === "pages:write" && openapi.body.paths["/pages"].post.parameters.some((p: any) => p.name === "Idempotency-Key"), "…as the document says per endpoint");

  console.log(`\n${passed} checks passed`);
} finally {
  // Takes the trigger with it, if a failed check left it there.
  await db.execute(sql.raw(`drop function if exists ${BOOM}() cascade`));
  await db.delete(workspace).where(inArray(workspace.id, [wsA, wsB, wsBob]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
