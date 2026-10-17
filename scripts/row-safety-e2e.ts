/**
 * End-to-end check of the row tools agents rely on, against the database: query_database reads
 * every matching row a page at a time with next_cursor (rows added or removed between pages
 * neither repeat nor go missing) and returns only the properties asked for; create_database_row(s)
 * with match_by update the row a value names instead of adding a duplicate, and refuse ambiguous
 * input before writing anything; update_database_rows with expect writes nothing when the count
 * is off, and dry_run reports without writing. Creates its own users and workspace and deletes
 * them afterwards.
 *
 *   pnpm tsx scripts/row-safety-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const databases = await import("@/server/databases");
const { archiveRows, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const ops = await import("@/server/operations");

const RUN = `rowsafety-e2e-${Date.now().toString(36)}`;

// Titles and bodies live in the live document inside the app server; here they go straight to
// the database (titles) or are recorded (bodies).
const bodies = new Map<string, string>();
registerCollab({
  broadcast: () => {},
  async disconnectLostAccess() {},
  async setTitle(pageId: string, title: string) {
    await db.update(page).set({ title }).where(eq(page.id, pageId));
  },
  async replaceContent(pageId: string, markdown: string) {
    bodies.set(pageId, markdown);
  },
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

async function fails(call: Promise<unknown>, pattern: RegExp) {
  return call.then(
    () => "no error",
    (error: unknown) => (error instanceof Error && pattern.test(error.message) ? true : String(error)),
  );
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const owner = { userId: ids.owner, actor: { userId: ids.owner } };
const member = { userId: ids.member, actor: { userId: ids.member } };

type QueryArgs = Omit<Parameters<typeof ops.queryDatabase>[1], "limit"> & { limit?: number };
/** Every page of a query, in order, with the cursors that led to them. */
async function readAll(ctx: typeof owner, args: QueryArgs, between?: (page: number) => Promise<void>) {
  const pages: { ids: string[]; total: number }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const out = await ops.queryDatabase(ctx, { limit: 50, ...args, cursor });
    pages.push({ ids: out.rows.map((r) => r.id), total: out.total });
    if (!out.next_cursor) {
      check(!out.has_more, `page ${i + 1} is the last one`, out);
      break;
    }
    cursor = out.next_cursor;
    await between?.(i + 1);
  }
  return pages;
}

async function liveRows(databaseId: string) {
  return db
    .select({ id: page.id, title: page.title, properties: page.properties })
    .from(page)
    .where(and(eq(page.parentId, databaseId), isNull(page.archivedAt), eq(page.isTemplate, false)));
}

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const leads = await createPage(owner.actor, { workspaceId, kind: "database", title: "Leads" });
  const email = await databases.addProperty(ids.owner, leads.id, { name: "Email", type: "email" });
  const score = await databases.addProperty(ids.owner, leads.id, { name: "Score", type: "number" });
  await databases.addProperty(ids.owner, leads.id, { name: "Stage", type: "select", options: ["New", "Won"] });
  await databases.addProperty(ids.owner, leads.id, { name: "Note", type: "text" });
  await databases.addProperty(ids.owner, leads.id, { name: "Starred", type: "checkbox" });

  // 250 rows; scores repeat, so a sort by score has long runs of ties.
  const seed = Array.from({ length: 250 }, (_, i) => ({
    title: `Lead ${i + 1}`,
    properties: { Email: `lead${i + 1}@example.test`, Score: i % 7, Stage: "New", Note: `note ${i + 1}` },
  }));
  for (let i = 0; i < seed.length; i += 100) await databases.createRows(ids.owner, leads.id, seed.slice(i, i + 100));

  // ------------------------------------------------------------------ paging
  const full = await ops.queryDatabase(owner, { database_id: leads.id, limit: 200 });
  check(full.total === 250 && full.returned === 200 && full.has_more && full.next_cursor, "the first page says more rows follow", {
    total: full.total,
    returned: full.returned,
  });
  check(full.note?.includes("50 more matching rows"), "…and the note tells an agent how to read on", full.note);
  const rest = await ops.queryDatabase(owner, { database_id: leads.id, limit: 200, cursor: full.next_cursor! });
  const both = [...full.rows, ...rest.rows].map((r) => r.id);
  check(rest.returned === 50 && !rest.has_more && rest.next_cursor === null, "the second page is the last", rest.returned);
  check(new Set(both).size === 250, "two pages of 200 read all 250 rows, each once", both.length);
  check(
    both.join() === (await readAll(owner, { database_id: leads.id, limit: 250 }))[0].ids.join(),
    "…in the order of a single read",
  );

  const byScore = { database_id: leads.id, sorts: [{ property: "Score", direction: "desc" as const }], limit: 37 };
  const sortedPages = await readAll(owner, byScore);
  const sortedIds = sortedPages.flatMap((p) => p.ids);
  check(sortedPages.length === 7 && new Set(sortedIds).size === 250, "pages over a sort with many ties hold every row once", sortedPages.length);
  const scoreOf = new Map((await liveRows(leads.id)).map((r) => [r.id, Number(r.properties[score.id] ?? -1)]));
  check(
    sortedIds.every((id, i) => i === 0 || scoreOf.get(sortedIds[i - 1])! >= scoreOf.get(id)!),
    "…in the sort's order across page boundaries",
  );

  // Rows change between pages: the row a page ended on and one before it go to the trash, one is
  // added at the end. Every row that stays is read once, the new one too.
  const before = sortedIds;
  const removed: string[] = [];
  let added = "";
  const changing = await readAll(owner, byScore, async (n) => {
    if (n !== 1) return;
    const first = before.slice(0, 37);
    removed.push(first[36], first[3]);
    await archiveRows(ids.owner, leads.id, removed);
    [{ id: added }] = await databases.createRows(ids.owner, leads.id, [{ title: "Late lead", properties: { Email: "late@example.test", Score: 0 } }]);
  });
  const read = changing.flatMap((p) => p.ids);
  const stayed = before.filter((id) => !removed.includes(id));
  check(new Set(read).size === read.length, "rows changing between pages repeat no row", read.length);
  check(
    stayed.every((id) => read.includes(id)) && read.includes(added),
    "…and miss none, even when the row a page ended on is gone",
    { missing: stayed.filter((id) => !read.includes(id)), added: read.includes(added) },
  );

  const sortedCursor = (await ops.queryDatabase(owner, byScore)).next_cursor!;
  const anotherQuery = await fails(ops.queryDatabase(owner, { ...byScore, sorts: [], cursor: sortedCursor }), /belongs to another query/);
  check(anotherQuery === true, "a cursor only reads on the query it came from", anotherQuery);
  const legacy = await ops.queryDatabase(owner, {
    database_id: leads.id,
    limit: 10,
    cursor: Buffer.from(JSON.stringify({ o: 240 })).toString("base64url"),
  });
  check(legacy.returned === 9 && legacy.next_cursor === null, "an offset cursor from before still reads on from its position", legacy.returned);

  const narrow = await ops.queryDatabase(owner, { database_id: leads.id, limit: 3, properties: ["email", "Score"] });
  check(
    narrow.rows.every((r) => Object.keys(r.properties).sort().join() === "Email,Score" && r.title && r.url),
    "properties narrows each row to the values asked for",
    narrow.rows[0],
  );
  const bare = await ops.queryDatabase(owner, { database_id: leads.id, limit: 3, properties: [] });
  check(bare.rows.every((r) => !Object.keys(r.properties).length && r.id), "an empty list returns just ids, titles and links", bare.rows[0]);

  // ------------------------------------------------------------------ upsert
  const count = async () => (await liveRows(leads.id)).length;
  const start = await count();
  const batch: { title: string; properties: Record<string, string | number>; markdown?: string }[] = [
    { title: "Lead 1 (renamed)", properties: { Email: "LEAD1@example.test", Score: 99 }, markdown: "Called twice" },
    { title: "Lead 2", properties: { Email: "lead2@example.test", Stage: "Won" } },
    { title: "Brand new", properties: { Email: "new@example.test", Score: 1 } },
  ];
  const upsert = await ops.createDatabaseRows(owner, { database_id: leads.id, rows: batch, match_by: "Email" });
  check(upsert.created === 1 && upsert.updated === 2, "match_by updates the rows a value names and adds the rest", upsert);
  check(
    upsert.rows.map((r) => r.action).join() === "updated,updated,created" && upsert.rows[0].title === "Lead 1 (renamed)",
    "…and each output row says which happened, in the given order",
    upsert.rows,
  );
  const lead1 = (await liveRows(leads.id)).find((r) => r.id === upsert.rows[0].id);
  check(lead1?.title === "Lead 1 (renamed)" && lead1.properties[score.id] === 99, "emails match ignoring case; title and values are set", lead1);
  check(bodies.get(lead1!.id) === "Called twice", "…and the given markdown replaces the body", [...bodies]);
  check((await count()) === start + 1, "only the unmatched row is added", await count());
  const retry = await ops.createDatabaseRows(owner, { database_id: leads.id, rows: batch, match_by: "email" });
  check(retry.created === 0 && retry.updated === 3 && (await count()) === start + 1, "running the same upsert again adds nothing", retry);

  const byTitle = await ops.createDatabaseRows(owner, {
    database_id: leads.id,
    rows: [{ title: "  Lead 3 ", properties: { Score: 50 } }],
    match_by: "title",
  });
  check(byTitle.updated === 1 && byTitle.created === 0, "match_by title matches trimmed titles", byTitle);

  const single = await ops.createDatabaseRow(owner, { database_id: leads.id, title: "Solo", properties: { Email: "solo@example.test" }, match_by: "Email" });
  const singleAgain = await ops.createDatabaseRow(owner, {
    database_id: leads.id,
    title: "Solo again",
    properties: { Email: "solo@example.test", Score: 5 },
    match_by: "Email",
  });
  check(
    "action" in single &&
      single.action === "created" &&
      "action" in singleAgain &&
      singleAgain.action === "updated" && singleAgain.id === single.id && singleAgain.properties.Score === 5,
    "create_database_row with match_by adds once, then updates that row",
    [single, singleAgain],
  );

  const settled = await count();
  const refusals: [string, () => Promise<unknown>, RegExp][] = [
    [
      "two given rows with one value",
      () =>
        ops.createDatabaseRows(owner, {
        database_id: leads.id,
        rows: [
          { title: "Fresh", properties: { Email: "fresh@example.test" } },
          { title: "A", properties: { Email: "dup@example.test" } },
          { title: "B", properties: { Email: "DUP@example.test" } },
        ],
        match_by: "Email",
      }),
      /Rows 2 and 3 have the same "Email"/,
    ],
    [
      "a value more than one existing row holds",
      () =>
        ops.createDatabaseRows(owner, {
        database_id: leads.id,
        rows: [
          { title: "Fresh", properties: { Score: 7777 } },
          { title: "Ties", properties: { Score: 3 } },
        ],
        match_by: "Score",
      }),
      /Row 2 \("Ties"\): \d+ rows already have this "Score"/,
    ],
    [
      "a row without a value to match",
      () =>
        ops.createDatabaseRows(owner, { database_id: leads.id, rows: [{ title: "No email" }], match_by: "Email" }),
      /has no value for "Email"/,
    ],
    [
      "a property that can't identify a row",
      () =>
        ops.createDatabaseRows(owner, { database_id: leads.id, rows: [{ title: "x", properties: { Starred: true } }], match_by: "Starred" }),
      /match_by must name the title or a text, number/,
    ],
    [
      "a bad value in a matched row",
      () =>
        ops.createDatabaseRows(owner, {
        database_id: leads.id,
        rows: [
          { title: "Fresh", properties: { Email: "fresh@example.test" } },
          { title: "Lead 5", properties: { Email: "lead5@example.test", Stage: "Lost" } },
        ],
        match_by: "Email",
      }),
      /Row "Lead 5": "Lost" is not an option of "Stage"/,
    ],
  ];
  for (const [what, call, pattern] of refusals) {
    const result = await fails(call(), pattern);
    check(result === true, `match_by refuses ${what}`, result);
  }
  check((await count()) === settled, "…and writes nothing when it does, not even the batch's new rows", await count());

  // A row the member may only view can't be updated through match_by either.
  const lead6 = (await liveRows(leads.id)).find((r) => r.properties[email.id] === "lead6@example.test")!;
  await setPagePermission(ids.owner, lead6.id, ids.owner, "full");
  await setPagePermission(ids.owner, lead6.id, null, "view");
  const viewOnly = await fails(
    ops.createDatabaseRows(member, {
      database_id: leads.id,
      rows: [
        { title: "Fresh", properties: { Email: "fresh@example.test" } },
        { title: "Lead 6", properties: { Email: "lead6@example.test", Score: 1 } },
      ],
      match_by: "Email",
    }),
    /match_by found rows you can't edit/,
  );
  check(viewOnly === true && (await count()) === settled, "match_by refuses rows the user may only view, writing nothing", viewOnly);

  // ------------------------------------------------------------------ expect and dry_run
  const targets = (await liveRows(leads.id)).filter((r) => r.properties[score.id] === 2).slice(0, 4);
  const targetIds = targets.map((r) => r.id);
  const stageOf = async () => (await liveRows(leads.id)).filter((r) => targetIds.includes(r.id)).map((r) => r.properties);
  const untouched = JSON.stringify(await stageOf());
  const dry = await ops.updateDatabaseRows(member, {
    database_id: leads.id,
    row_ids: [...targetIds, lead6.id, "nope"],
    properties: { Stage: "Won" },
    dry_run: true,
  });
  check(
    "dry_run" in dry && dry.would_update === 4 && dry.row_ids?.join() === targetIds.join() && dry.skipped_row_ids?.join() === `${lead6.id},nope`,
    "dry_run reports the rows that would change and the ones that would be skipped",
    dry,
  );
  check(JSON.stringify(await stageOf()) === untouched, "…without writing", await stageOf());
  const off = await fails(
    ops.updateDatabaseRows(member, {
      database_id: leads.id,
      row_ids: [...targetIds, lead6.id],
      properties: { Stage: "Won" },
      expect: 5,
      dry_run: false,
    }),
    /Expected 5 rows to change, but 4 would \(skipped: .+\)\. Nothing was written\./,
  );
  check(off === true && JSON.stringify(await stageOf()) === untouched, "expect refuses a count that is off, writing nothing", off);
  const on = await ops.updateDatabaseRows(member, {
    database_id: leads.id,
    row_ids: [...targetIds, targetIds[0]],
    properties: { Stage: "Won" },
    expect: 4,
    dry_run: false,
  });
  check("updated" in on && on.updated === 4, "expect lets the call through when the count holds (repeated ids count once)", on);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
