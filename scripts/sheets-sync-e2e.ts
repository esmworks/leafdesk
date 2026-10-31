/**
 * End-to-end check of Google Sheets syncs, with a fake Google Sheets MCP server (started here,
 * `get_spreadsheet` answering as Google's does: the spreadsheet's sheets, then typed cells of a
 * range) behind a real connection row, so the calls go through the connection client: who may sync
 * through a connection (owners; members only once an owner allowed the AI chat the tool; guests
 * never), setting one up from a link (the sheet by its gid, the header below two summary rows,
 * columns without a header left out, numbers, dates, times, checkboxes and mixed columns as text),
 * a run writing the sheet's changes over, adding rows and keeping rows that left it, a renamed
 * sheet found by its id, the audit log of each call, and runs that can't happen: a connection
 * signed out, a member no longer allowed, a key column whose header changed, a sheet too big. Then
 * writing back (`update_values` and `insert_dimension` writing into the fake sheet): who may turn it
 * on, a change written to its cell, a cell changed in the sheet too keeping the sheet's value, a
 * formula column never written, a new row added below the last with its key, a change made while
 * a run writes kept for the next run, and a refused write leaving the change waiting. Then sheets
 * without a column of different values: a key column repeating a value refused, a sync by place
 * (rows by their sheet row number, repeats and all, a row whose place empties going to the trash
 * and a row at that place later coming in anew, writing back refused), and a keyed sync whose key
 * started repeating turned into one by place.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/sheets-sync-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { createServer } = await import("node:http");

// The fake Sheets server, on a port of its own.
const FAKE_PORT = 30_000 + Math.floor(Math.random() * 20_000);
process.env.CONNECTOR_ALLOWED_HOSTS = `localhost:${FAKE_PORT}`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const z = await import("zod");
const { McpServer, createMcpHandler } = await import("@modelcontextprotocol/server");
const { db } = await import("@/db");
const { auditEvent, connection, databaseSync, databaseView, page, sheetsWrite, user, workspace, workspaceMember } = await import("@/db/schema");
const { MAX_SHEET_CELLS } = await import("@/lib/sheets-sync");
type SheetCell = import("@/lib/sheets-sync").SheetCell;
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { changePropertyType, getProperties, updateRowProperties } = await import("@/server/databases");
const { archivePage, createPage } = await import("@/server/pages");
const { dropClient } = await import("@/server/connections/client");
const { JiraError } = await import("@/server/jira-sync/client");
const { createSheetsSync, getSheetsSync, SheetsSetupError, sheetsSources, stopSheetsSync, syncSheetsByPlace, syncSheetsNow, updateSheetsSync } = await import(
  "@/server/sheets-sync/manage"
);
const { syncWriteStatus } = await import("@/server/sync-write-status");

const RUN = `sheets-e2e-${Date.now().toString(36)}`;
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

async function failure(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof JiraError || error instanceof SheetsSetupError) return error.code;
    if (error instanceof Error && error.constructor.name === "AccessError") return "access";
    throw error;
  }
}

// The fake spreadsheet: a stock list, its header under two rows of totals, as a shop keeps one.
const text = (value: string): SheetCell => ({ effectiveValue: { stringValue: value }, formattedValue: value });
const num = (value: number, shown = String(value).replace(".", ","), type?: string): SheetCell => ({
  effectiveValue: { numberValue: value },
  formattedValue: shown,
  ...(type ? { effectiveFormat: { numberFormat: { type } } } : {}),
});
const bool = (value: boolean): SheetCell => ({ effectiveValue: { boolValue: value }, formattedValue: value ? "TRUE" : "FALSE" });
const SPREADSHEET = `${RUN.replace(/[^A-Za-z0-9]/g, "")}sheet`.padEnd(30, "x");
const STOCK_ID = 878363657;
type FakeSheet = { sheetId: number; title: string; frozen: number; rows: SheetCell[][]; gridRows?: number };
const sheets: FakeSheet[] = [
  { sheetId: 0, title: "Özet", frozen: 0, rows: [[text("Toplam")]] },
  {
    sheetId: STOCK_ID,
    title: "BATARYA STOK",
    frozen: 3,
    rows: [
      [text(""), text("PARİTE"), text(""), text("Dolar KUR"), num(50.34)],
      [text(""), num(1.115), text(""), text("Euro KUR"), num(56.13)],
      [text("ÜRÜN"), text("LİSTE FİYATI"), text("DURUM"), text("SON SAYIM"), text("GELDİ"), text(""), text("GÜNCELLENDİ"), text("NOT")],
      [text("GNA 1.500-1 N"), num(432), num(-1, "-1", "NUMBER"), num(46322, "27.10.2026", "DATE"), bool(true), text("x"), num(46322.5, "27.10.2026 12:00", "DATE_TIME"), text("acil")],
      [text("GNA 2.000-1 N"), num(206.44915500000002, "206,4", "NUMBER"), text("EKSİK YOK"), num(46300, "05.10.2026", "DATE"), bool(false)],
      [],
      [text(""), num(5)],
      [text("GNA 2.500-1 N"), num(548), num(-11, "-11"), {}, bool(false)],
    ],
  },
];
const seen: { args: Record<string, unknown> }[] = [];
// Writing into the fake sheet: refused while `refuseWrites`; `duringWrite` runs as a write comes in.
const written: { tool: string; range: string; values: unknown[][] }[] = [];
let refuseWrites = false;
let duringWrite: (() => Promise<void>) | null = null;
const letters = (col: string) => [...col].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const typed = (value: unknown, was: SheetCell | undefined): SheetCell =>
  value === ""
    ? {}
    : typeof value === "boolean"
      ? bool(value)
      : typeof value === "number"
        ? { effectiveValue: { numberValue: value }, formattedValue: String(value), ...(was?.effectiveFormat ? { effectiveFormat: was.effectiveFormat } : {}) }
        : text(String(value));

const fake = createMcpHandler(() => {
  const server = new McpServer({ name: "fake-sheets", version: "1.0.0" });
  server.registerTool(
    "get_spreadsheet",
    {
      description: "Returns the spreadsheet content.",
      inputSchema: z.object({
        spreadsheetId: z.string(),
        includeGridData: z.boolean().optional(),
        ranges: z.array(z.string()).optional(),
        fields: z.array(z.string()).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      seen.push({ args });
      if (args.spreadsheetId !== SPREADSHEET) return { isError: true, content: [{ type: "text" as const, text: "Requested entity was not found." }] };
      const answer = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
      if (!args.includeGridData) {
        return answer({
          properties: { title: "İzmir Canlı Stok", timeZone: "Europe/Istanbul" },
          sheets: sheets.map((s) => ({
            properties: {
              // Google leaves the first sheet's id (0) out.
              ...(s.sheetId ? { sheetId: s.sheetId } : {}),
              title: s.title,
              gridProperties: { rowCount: s.gridRows ?? Math.max(s.rows.length, 10), columnCount: 27, ...(s.frozen ? { frozenRowCount: s.frozen } : {}) },
            },
          })),
        });
      }
      const range = /^'((?:[^']|'')*)'!A(\d+):[A-Z]+(\d+)$/.exec(args.ranges?.[0] ?? "");
      const sheet = range && sheets.find((s) => s.title === range[1].replace(/''/g, "'"));
      if (!range || !sheet) return { isError: true, content: [{ type: "text" as const, text: `Unable to parse range: ${args.ranges?.[0]}` }] };
      const rows = sheet.rows.slice(Number(range[2]) - 1, Number(range[3]));
      return answer({ sheets: [{ data: [{ startRow: Number(range[2]) - 1, rowData: rows.map((values) => (values.length ? { values } : {})) }] }] });
    },
  );
  server.registerTool(
    "update_values",
    { description: "update_values", inputSchema: z.object({ spreadsheetId: z.string(), range: z.string(), values: z.array(z.array(z.unknown())) }) },
    async (args) => {
      written.push({ tool: "update_values", range: args.range, values: args.values });
      await duringWrite?.();
      if (refuseWrites) return { isError: true, content: [{ type: "text" as const, text: "The caller does not have permission" }] };
      const range = /^'((?:[^']|'')*)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(args.range);
      const sheet = range && sheets.find((s) => s.title === range[1].replace(/''/g, "'"));
      if (!range || !sheet) return { isError: true, content: [{ type: "text" as const, text: `Unable to parse range: ${args.range}` }] };
      // Google refuses cells past the sheet's last row.
      if (sheet.gridRows !== undefined && Number(range[5]) > sheet.gridRows) return { isError: true, content: [{ type: "text" as const, text: "Range exceeds grid limits" }] };
      const first = Number(range[3]) - 1;
      args.values.forEach((values, i) => {
        const cells = (sheet.rows[first + i] ??= []);
        values.forEach((value, j) => {
          const col = letters(range[2]) + j;
          if (value === null) return;
          while (cells.length <= col) cells.push({});
          cells[col] = typed(value, cells[col]);
        });
      });
      for (let i = 0; i < sheet.rows.length; i++) sheet.rows[i] ??= [];
      return { content: [{ type: "text" as const, text: JSON.stringify({ updatedRange: args.range }) }] };
    },
  );
  server.registerTool(
    "insert_dimension",
    {
      description: "insert_dimension",
      inputSchema: z.object({ spreadsheetId: z.string(), sheetId: z.number(), dimension: z.string(), startIndex: z.number(), endIndex: z.number(), inheritFromBefore: z.boolean().optional() }),
    },
    async (args) => {
      written.push({ tool: "insert_dimension", range: `${args.dimension} ${args.startIndex}:${args.endIndex}`, values: [] });
      const sheet = sheets.find((s) => (s.sheetId ?? 0) === args.sheetId);
      const rowCount = sheet ? (sheet.gridRows ?? Math.max(sheet.rows.length, 10)) : 0;
      if (!sheet || args.dimension !== "ROWS" || args.startIndex > rowCount || args.endIndex <= args.startIndex) {
        return { isError: true, content: [{ type: "text" as const, text: "Invalid insert" }] };
      }
      if (sheet.gridRows !== undefined) sheet.gridRows += args.endIndex - args.startIndex;
      return { content: [{ type: "text" as const, text: "{}" }] };
    },
  );
  return server;
});

const http = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = new Request(`http://localhost:${FAKE_PORT}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  const response = await fake.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>((resolve) => http.listen(FAKE_PORT, "::", resolve));

// owner2 sets up the syncs by place: each person may set up only so many syncs a minute.
const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest`, owner2: `${RUN}-owner2` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;
const TOOLS = ["get_spreadsheet", "get_values"].map((name) => ({ name, title: null, description: name, inputSchema: { type: "object" }, hinted: "read" as const, kind: "read" as const }));
const connectionRow = (values: { id: string; workspaceId: string; chatTools?: string[] }) => ({
  name: `Sheets ${values.id.slice(-6)}`,
  slug: values.id.slice(-20).replace(/[^a-z0-9]/gi, "").toLowerCase(),
  url: `http://localhost:${FAKE_PORT}/mcp`,
  authType: "none" as const,
  status: "ready" as const,
  tools: TOOLS,
  chatTools: [],
  eventSecret: "unused",
  ...values,
});
const link = `https://docs.google.com/spreadsheets/d/${SPREADSHEET}/edit?pli=1&gid=${STOCK_ID}#gid=${STOCK_ID}`;

try {
  await db.insert(user).values(userIds.map((u) => ({ id: u, name: u, email: `${u}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId, userId: ids.owner2, role: "owner" },
    { workspaceId: otherWorkspace, userId: ids.owner, role: "owner" },
  ]);
  const sheetsConn = `${RUN}-sheets`;
  const second = `${RUN}-second`;
  const elsewhere = `${RUN}-elsewhere`;
  await db.insert(connection).values([
    connectionRow({ id: sheetsConn, workspaceId }),
    connectionRow({ id: second, workspaceId }),
    connectionRow({ id: elsewhere, workspaceId: otherWorkspace }),
  ]);
  const owner = { userId: ids.owner };
  const home = await createPage(owner, { workspaceId, title: "Home" });

  // Who may sync through a connection
  check((await sheetsSources(ids.owner, workspaceId)).map((s) => s.id).sort().join() === [sheetsConn, second].sort().join(), "owners may sync through the workspace's Sheets connections");
  check((await sheetsSources(ids.member, workspaceId)).length === 0, "members may not while an owner hasn't allowed the chat get_spreadsheet");
  await db.update(connection).set({ chatTools: ["get_spreadsheet"] }).where(eq(connection.id, sheetsConn));
  check((await sheetsSources(ids.member, workspaceId)).map((s) => s.id).join() === sheetsConn, "…and may once it has");
  check((await sheetsSources(ids.guest, workspaceId)).length === 0, "guests never may");

  // Refusals before anything is made
  const setup = { workspaceId, parentId: home.id, connectionId: sheetsConn, link, intervalMinutes: 0, keyColumn: "ÜRÜN" };
  check((await failure(() => createSheetsSync(owner, { ...setup, link: "https://example.test/sheet" }))) === "invalidInput", "a link that isn't a spreadsheet's is refused");
  check((await failure(() => createSheetsSync(owner, { ...setup, connectionId: elsewhere }))) === "forbidden", "another workspace's connection can't be used");
  check((await failure(() => createSheetsSync({ userId: ids.guest }, { ...setup, parentId: null }))) !== null, "a guest can't set one up");
  check((await failure(() => createSheetsSync(owner, { ...setup, link: link.replaceAll(String(STOCK_ID), "42") }))) === "notFound", "a sheet the spreadsheet doesn't have is refused");
  check((await failure(() => createSheetsSync(owner, { ...setup, keyColumn: "SKU" }))) === "invalidInput", "…so is a key column the header doesn't have");
  check((await failure(() => createSheetsSync(owner, { ...setup, keyColumn: "GELDİ" }))) === "repeatedKey", "…and one repeating a value, whose rows couldn't be told apart");
  check(
    (await failure(() => createSheetsSync(owner, { ...setup, keyColumn: "", direction: "both", intervalMinutes: 15 }))) === "bothNeedsKey",
    "…and writing back without a key column",
  );

  // Setting one up
  const result = await createSheetsSync(owner, { ...setup, title: "Stok" });
  const databaseId = result.pages[0].id;
  const props = await getProperties(databaseId);
  const prop = (name: string) => props.find((p) => p.name === name);
  check(
    props.map((p) => `${p.name}:${p.type}`).join("|") === "ÜRÜN:text|LİSTE FİYATI:number|DURUM:text|SON SAYIM:date|GELDİ:checkbox|GÜNCELLENDİ:date|NOT:text",
    "each named column becomes a property of its kind (the header under the frozen rows, a column without a header left out)",
    props.map((p) => `${p.name}:${p.type}`),
  );
  const rows = async () =>
    (await db.select({ title: page.title, properties: page.properties }).from(page).where(eq(page.parentId, databaseId))).sort((a, b) => a.title.localeCompare(b.title));
  const first = await rows();
  check(result.created.rows === 3 && first.map((r) => r.title).join("|") === "GNA 1.500-1 N|GNA 2.000-1 N|GNA 2.500-1 N", "each line with a key becomes a row, titled by the key column", first);
  const row1 = first[0].properties;
  check(
    row1[prop("LİSTE FİYATI")!.id] === 432 &&
      row1[prop("DURUM")!.id] === "-1" &&
      row1[prop("SON SAYIM")!.id] === "2026-10-27" &&
      row1[prop("GELDİ")!.id] === true &&
      row1[prop("GÜNCELLENDİ")!.id] === "2026-10-27T09:00:00.000Z" &&
      row1[prop("NOT")!.id] === "acil",
    "values come typed: numbers, days, times in the spreadsheet's zone, checkboxes, and a mixed column's text as shown",
    row1,
  );
  check(first[1].properties[prop("LİSTE FİYATI")!.id] === 206.449155 && first[1].properties[prop("DURUM")!.id] === "EKSİK YOK", "numbers lose the arithmetic's noise", first[1].properties);
  const views = await db.select({ config: databaseView.config }).from(databaseView).where(eq(databaseView.databaseId, databaseId));
  check(views.length > 0 && views.every((v) => v.config.hidden?.includes(prop("ÜRÜN")!.id)), "the key column that also names rows shows once, as the title", views);
  const [stored] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  check(
    stored.source === "sheets" && stored.siteUrl.endsWith(`#gid=${STOCK_ID}`) && (stored.query as { headerRow: number }).headerRow === 3 && stored.intervalMinutes === 0,
    "the sync is kept: its sheet by id, the header row it found",
    stored,
  );
  const view = await getSheetsSync(ids.owner, databaseId);
  check(view?.sheetTitle === "BATARYA STOK" && view.connection === `Sheets ${sheetsConn.slice(-6)}` && view.canManage && view.choices.length === 2, "its dialog shows the sheet and the connection", view);

  // A run
  const stock = sheets[1];
  stock.rows[3][1] = num(450);
  stock.rows[4][4] = bool(true);
  stock.rows.splice(7, 1);
  stock.rows.push([text("GNA 3.000-1 N"), num(700), text("YOK")]);
  stock.title = "BATARYA STOK 2026";
  const ran = await syncSheetsNow(ids.owner, databaseId);
  const second_ = await rows();
  check(ran.outcome.error === null && ran.outcome.count === 3 && ran.sheetTitle === "BATARYA STOK 2026", "a run reads the renamed sheet by its id", ran);
  check(
    second_.length === 4 &&
      second_[0].properties[prop("LİSTE FİYATI")!.id] === 450 &&
      second_[1].properties[prop("GELDİ")!.id] === true &&
      second_.some((r) => r.title === "GNA 3.000-1 N") &&
      second_.some((r) => r.title === "GNA 2.500-1 N"),
    "…writes the changes over, adds new rows and keeps rows that left the sheet",
    second_,
  );
  const calls = await db
    .select({ details: auditEvent.details, actorId: auditEvent.actorUserId })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "connection.tool_called")));
  check(
    calls.length >= 4 && calls.every((c) => (c.details as { via?: string }).via === "sync" && c.actorId === ids.owner),
    "each call to the connection is in the audit log, as the person the sync runs as",
    calls.length,
  );
  check(seen.at(-1)?.args.ranges?.toString() === "'BATARYA STOK 2026'!A3:AA10", "the cells are asked for from the header row down", seen.at(-1));

  // Runs that can't happen
  await db.update(connection).set({ status: "needsAuth" }).where(eq(connection.id, sheetsConn));
  const signedOut = await syncSheetsNow(ids.owner, databaseId);
  check(signedOut.outcome.error === "unauthorized" && !signedOut.enabled, "a connection signed out pauses the sync", signedOut);
  await db.update(connection).set({ status: "ready" }).where(eq(connection.id, sheetsConn));
  const db2 = await createSheetsSync({ userId: ids.member }, { ...setup, parentId: null });
  await db.update(connection).set({ chatTools: [] }).where(eq(connection.id, sheetsConn));
  const notAllowed = await syncSheetsNow(ids.member, db2.pages[0].id);
  check(notAllowed.outcome.error === "forbidden", "a member whose chat lost the tool can no longer sync through it", notAllowed.outcome);
  stock.rows[2][0] = text("STOK KODU");
  const keyGone = await syncSheetsNow(ids.owner, databaseId);
  check(keyGone.outcome.error === "keyGone", "a key column whose header changed pauses the sync", keyGone.outcome);
  stock.rows[2][0] = text("ÜRÜN");
  stock.gridRows = Math.ceil(MAX_SHEET_CELLS / 27) + 3;
  const tooBig = await syncSheetsNow(ids.owner, databaseId);
  check(tooBig.outcome.error === "tooManyIssues", "a sheet with too many cells isn't read", tooBig.outcome);
  stock.gridRows = undefined;

  // Writing back
  const outbox = () => db.select().from(sheetsWrite).where(eq(sheetsWrite.syncId, stored.id));
  const rowOf = async (title: string) => (await db.select().from(page).where(and(eq(page.parentId, databaseId), eq(page.title, title))))[0];
  const value = async (title: string, name: string) => (await rowOf(title)).properties[prop(name)!.id];
  const cell = (key: string, column: number) => stock.rows.find((r) => r[0]?.formattedValue === key)?.[column];
  check((await failure(() => updateSheetsSync(ids.owner, databaseId, { direction: "both" }))) === "invalidInput", "writing back needs a schedule");
  check(
    (await failure(() => updateSheetsSync(ids.owner, databaseId, { direction: "both", intervalMinutes: 15 }))) === "forbidden",
    "…and a connection with the write tools",
  );
  const WRITE_TOOLS = ["update_values", "insert_dimension"].map((name) => ({ name, title: null, description: name, inputSchema: { type: "object" }, hinted: "write" as const, kind: "write" as const }));
  await db.update(connection).set({ tools: [...TOOLS, ...WRITE_TOOLS] }).where(eq(connection.id, sheetsConn));
  const both = await updateSheetsSync(ids.owner, databaseId, { direction: "both", intervalMinutes: 15 });
  check(both.direction === "both" && both.canWrite && both.intervalMinutes === 15 && both.enabled, "an owner turns writing back on", both);
  await db.update(connection).set({ chatTools: ["get_spreadsheet"] }).where(eq(connection.id, sheetsConn));
  check((await sheetsSources(ids.member, workspaceId))[0]?.canWrite === false, "a member may not write through it while the chat may only read");

  const price = prop("LİSTE FİYATI")!.id;
  const runNow = () => syncSheetsNow(ids.owner, databaseId);
  // Stands in for the server's syncs (jira-sync/run startDatabaseSyncs), which the change asks to run soon.
  const soon: number[] = [];
  (globalThis as { __leafdeskSyncsSoon?: (ms: number) => void }).__leafdeskSyncsSoon = (ms) => void soon.push(ms);
  await updateRowProperties(ids.owner, (await rowOf("GNA 2.000-1 N")).id, { [price]: 210 });
  const [queued] = await outbox();
  const [timing] = await db.select({ nextRunAt: databaseSync.nextRunAt }).from(databaseSync).where(eq(databaseSync.id, stored.id));
  check(
    queued?.before[price] === 206.449155 && !queued.created && timing.nextRunAt!.getTime() < Date.now() + 10_000 && soon.length === 1 && soon[0] <= 10_000,
    "a change waits with the value from before it, and asks for a run within seconds",
    { queued, timing, soon },
  );
  delete (globalThis as { __leafdeskSyncsSoon?: unknown }).__leafdeskSyncsSoon;
  const ownerSees = await syncWriteStatus(ids.owner, databaseId);
  const memberSees = await syncWriteStatus(ids.member, databaseId);
  check(
    ownerSees?.pending === 1 && !ownerSees.failed && ownerSees.canWriteNow && memberSees?.pending === 1 && !memberSees.canWriteNow,
    "the database shows the row waiting, with Write now for those who may run the sync",
    { ownerSees, memberSees },
  );
  const wroteOne = await runNow();
  check(wroteOne.outcome.error === null && cell("GNA 2.000-1 N", 1)?.effectiveValue?.numberValue === 210, "a run writes it to its cell", written.at(-1));
  check(written.at(-1)?.range === "'BATARYA STOK 2026'!B5:B5", "…only that cell", written.at(-1));
  check((await outbox()).length === 0 && (await value("GNA 2.000-1 N", "LİSTE FİYATI")) === 210, "…and nothing waits after it, the row keeps its value");
  const writeCalls = await db
    .select({ details: auditEvent.details, actorId: auditEvent.actorUserId })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "connection.tool_called")));
  check(
    writeCalls.some((c) => (c.details as { tool?: string; kind?: string; editors?: string[] }).tool === "update_values" && (c.details as { kind?: string }).kind === "write" && (c.details as { editors?: string[] }).editors?.[0] === ids.owner),
    "the write is in the audit log, with whose change it was",
  );

  // Both changed: the sheet's value stays.
  const note = prop("NOT")!.id;
  await updateRowProperties(ids.owner, (await rowOf("GNA 1.500-1 N")).id, { [note]: "çok acil" });
  stock.rows[3][7] = text("bitti");
  const writes = written.length;
  await runNow();
  check(written.length === writes && (await value("GNA 1.500-1 N", "NOT")) === "bitti", "a cell changed in the sheet too keeps the sheet's value, and the row takes it");
  check((await outbox()).length === 0, "the run's own writes to the rows wait for nothing");

  // A column of formulas is never written.
  stock.rows[3][2] = { ...num(-1, "-1", "NUMBER"), userEnteredValue: { formulaValue: "=B4-451" } };
  stock.rows[4][2] = { ...text("EKSİK YOK"), userEnteredValue: { formulaValue: "=IF(B5>0;\"EKSİK YOK\";\"\")" } };
  await updateRowProperties(ids.owner, (await rowOf("GNA 2.000-1 N")).id, { [prop("DURUM")!.id]: "TAMAM" });
  const formulas = await runNow();
  check(
    written.length === writes && cell("GNA 2.000-1 N", 2)?.formattedValue === "EKSİK YOK" && (await value("GNA 2.000-1 N", "DURUM")) === "EKSİK YOK",
    "a formula column isn't written, and its value comes back",
  );
  check(formulas.formulaColumns.join() === "DURUM", "the dialog lists it", formulas.formulaColumns);

  // A row made here is added below the sheet's last row, with its key.
  const before = (await rows()).length;
  await createPage(owner, { workspaceId, parentId: databaseId, title: "GNA 4.000-1 N", properties: { [price]: 900, [prop("GELDİ")!.id]: true } });
  await runNow();
  const added = stock.rows.find((r) => r[0]?.formattedValue === "GNA 4.000-1 N");
  check(
    added?.[1]?.effectiveValue?.numberValue === 900 && added[4]?.effectiveValue?.boolValue === true && written.at(-1)?.range === "'BATARYA STOK 2026'!A9:H9",
    "a new row is written below the last one",
    written.at(-1),
  );
  check((await value("GNA 4.000-1 N", "ÜRÜN")) === "GNA 4.000-1 N" && (await rows()).length === before + 1, "…takes its key from its title, and stays one row");
  // A sheet without room left grows: rows are added at its end, then written.
  stock.gridRows = stock.rows.length;
  await createPage(owner, { workspaceId, parentId: databaseId, title: "GNA 5.000-1 N", properties: { [price]: 1000 } });
  await runNow();
  const grown = stock.gridRows;
  stock.gridRows = undefined;
  check(
    written.at(-2)?.tool === "insert_dimension" &&
      written.at(-2)?.range === `ROWS ${grown - 1}:${grown}` &&
      written.at(-1)?.range === `'BATARYA STOK 2026'!A${grown}:H${grown}` &&
      stock.rows.at(-1)?.[0]?.formattedValue === "GNA 5.000-1 N",
    "…in rows added at its end when the sheet has no room left",
    written.slice(-2),
  );
  // A new row named like another row's key stays in Leafdesk alone: two rows never share a key.
  const writesBefore = written.length;
  const twin = await createPage(owner, { workspaceId, parentId: databaseId, title: "GNA 1.500-1 N", properties: { [price]: 1 } });
  await runNow();
  const [twinRow] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, twin.id));
  check(written.length === writesBefore && !twinRow.properties[prop("ÜRÜN")!.id] && (await outbox()).length === 0, "a new row named like another's key isn't written, nor given the key");
  await archivePage(ids.owner, twin.id);

  // A change made while a run writes waits for the next.
  const firstRow = (await rowOf("GNA 1.500-1 N")).id;
  await updateRowProperties(ids.owner, firstRow, { [price]: 460 });
  duringWrite = async () => {
    duringWrite = null;
    await updateRowProperties(ids.owner, firstRow, { [price]: 465 });
  };
  await runNow();
  const [again] = await outbox();
  check(
    cell("GNA 1.500-1 N", 1)?.effectiveValue?.numberValue === 460 && (await value("GNA 1.500-1 N", "LİSTE FİYATI")) === 465 && again?.before[price] === 460,
    "a change made while the run wrote stays, waiting, with what the sheet now holds as its value before",
    again,
  );
  await runNow();
  check(cell("GNA 1.500-1 N", 1)?.effectiveValue?.numberValue === 465 && (await outbox()).length === 0, "…and the next run writes it");

  // A refused write leaves the change waiting, and reading goes on.
  refuseWrites = true;
  await updateRowProperties(ids.owner, (await rowOf("GNA 3.000-1 N")).id, { [price]: 710 });
  const refused = await runNow();
  check(
    refused.outcome.error === null && refused.writeError === "forbidden" && refused.pendingWrites === 1 && refused.enabled,
    "a refused write is shown, without pausing the sync",
    refused,
  );
  check((await value("GNA 3.000-1 N", "LİSTE FİYATI")) === 710 && cell("GNA 3.000-1 N", 1)?.effectiveValue?.numberValue === 700, "…and the row keeps its change while it waits");
  check((await syncWriteStatus(ids.owner, databaseId))?.failed === true, "…and the database shows it wasn't written");
  refuseWrites = false;
  const retried = await runNow();
  check(retried.writeError === null && retried.pendingWrites === 0 && cell("GNA 3.000-1 N", 1)?.effectiveValue?.numberValue === 710, "it is written once the sheet takes it");

  // Back to reading only: what waits is dropped.
  await updateRowProperties(ids.owner, (await rowOf("GNA 3.000-1 N")).id, { [price]: 720 });
  const readOnly = await updateSheetsSync(ids.owner, databaseId, { direction: "read" });
  check(readOnly.direction === "read" && readOnly.pendingWrites === 0, "reading only again drops the changes waiting", readOnly);

  // Changing and stopping
  const moved = await updateSheetsSync(ids.owner, databaseId, { connectionId: second });
  check(moved.connectionId === second && moved.lastError === null && moved.enabled, "switching to another connection reads through it at once", moved);
  check((await failure(() => updateSheetsSync(ids.guest, databaseId, { intervalMinutes: 15 }))) === "access", "only people with full access change a sync");
  const kept = (await rows()).length;
  await stopSheetsSync(ids.owner, databaseId);
  check((await getSheetsSync(ids.owner, databaseId)) === null && (await rows()).length === kept, "stopping keeps the rows");

  // A sheet without a column of different values: synced by place
  const day = (serial: number) => num(serial, "", "DATE");
  const PAY_ID = 4242;
  const pay: FakeSheet = {
    sheetId: PAY_ID,
    title: "ÖDEME",
    frozen: 1,
    rows: [
      [text("Tarih"), text("Firma"), text("Tutar"), text("Durum")],
      [day(46330), text("Frigoduman"), num(2390), text("Bekliyor")],
      [day(46330), text("Frigoduman"), num(2390), text("Bekliyor")],
      [day(46331), text("Maaş"), num(41667), text("Ödendi")],
      [],
      [day(46332), text("Kira"), num(61500), text("Bekliyor")],
    ],
  };
  sheets.push(pay);
  const owner2 = { userId: ids.owner2 };
  const linkTo = (gid: number) => `https://docs.google.com/spreadsheets/d/${SPREADSHEET}/edit#gid=${gid}`;
  const placed = await createSheetsSync(owner2, { workspaceId, parentId: home.id, connectionId: sheetsConn, link: linkTo(PAY_ID), intervalMinutes: 0, rowName: "Satır" });
  const payId = placed.pages[0].id;
  const payProps = await getProperties(payId);
  const payProp = (name: string) => payProps.find((p) => p.name === name)!.id;
  check(
    payProps.map((p) => `${p.name}:${p.type}`).join("|") === "Satır:number|Tarih:date|Firma:text|Tutar:number|Durum:text",
    "without a key column every named column is a property, and the sheet row number one of its own",
    payProps.map((p) => `${p.name}:${p.type}`),
  );
  const payRows = async () =>
    (await db.select({ title: page.title, properties: page.properties, archivedAt: page.archivedAt }).from(page).where(eq(page.parentId, payId))).sort(
      (a, b) => Number(a.properties[payProp("Satır")] ?? 0) - Number(b.properties[payProp("Satır")] ?? 0),
    );
  const live = async () => (await payRows()).filter((r) => !r.archivedAt);
  const placedRows = await live();
  check(
    placed.created.rows === 4 &&
      placedRows.map((r) => `${r.properties[payProp("Satır")]}:${r.properties[payProp("Firma")]}`).join("|") === "2:Frigoduman|3:Frigoduman|4:Maaş|6:Kira" &&
      placedRows[0].properties[payProp("Tarih")] === "2026-11-04",
    "each row with anything in it comes in, the same values twice included, by its sheet row",
    placedRows,
  );
  const payViews = await db.select({ config: databaseView.config }).from(databaseView).where(eq(databaseView.databaseId, payId));
  check(
    payViews.length > 0 && payViews.every((v) => v.config.hidden?.includes(payProp("Satır")) && v.config.hidden?.includes(payProp("Tarih"))),
    "the row number and the column naming rows are hidden",
    payViews,
  );
  check((await getSheetsSync(ids.owner2, payId))?.keyColumn === "", "its dialog knows it finds rows by place");
  check((await failure(() => updateSheetsSync(ids.owner2, payId, { direction: "both", intervalMinutes: 15 }))) === "bothNeedsKey", "a sync by place doesn't write back");

  pay.rows[2][3] = text("Ödendi");
  pay.rows.splice(3, 1);
  const shrunk = await syncSheetsNow(ids.owner2, payId);
  const afterShrink = await payRows();
  check(
    shrunk.outcome.error === null &&
      afterShrink
        .filter((r) => !r.archivedAt)
        .map((r) => `${r.properties[payProp("Satır")]}:${r.properties[payProp("Firma")]}:${r.properties[payProp("Durum")]}`)
        .join("|") === "2:Frigoduman:Bekliyor|3:Frigoduman:Ödendi|5:Kira:Bekliyor",
    "a run follows the sheet by place: a changed value, a row moved up",
    afterShrink,
  );
  check(
    afterShrink.filter((r) => r.archivedAt).length === 2 && afterShrink.filter((r) => r.archivedAt).every((r) => r.properties[payProp("Satır")] === undefined),
    "…and the rows whose place emptied go to the trash without their number",
    afterShrink,
  );
  pay.rows.push([day(46333), text("Aidat"), num(3300), text("Bekliyor")]);
  await syncSheetsNow(ids.owner2, payId);
  check(
    (await live()).map((r) => `${r.properties[payProp("Satır")]}:${r.properties[payProp("Firma")]}`).join("|") === "2:Frigoduman|3:Frigoduman|5:Kira|6:Aidat",
    "a row coming to an emptied place comes in, never held back by the one in the trash",
    await payRows(),
  );

  // A keyed sync whose key started repeating and was retyped, turned into one by place
  const CASH_ID = 4343;
  const cash: FakeSheet = {
    sheetId: CASH_ID,
    title: "KASA",
    frozen: 1,
    rows: [
      [text("Tarih"), text("Firma"), text("Tutar")],
      [num(46327, "01.11.2026", "DATE"), text("A"), num(10)],
      [num(46328, "02.11.2026", "DATE"), text("B"), num(20)],
    ],
  };
  sheets.push(cash);
  const keyed = await createSheetsSync(owner2, { workspaceId, parentId: home.id, connectionId: sheetsConn, link: linkTo(CASH_ID), intervalMinutes: 0, keyColumn: "Tarih" });
  const cashId = keyed.pages[0].id;
  const keyProp = (await getProperties(cashId)).find((p) => p.name === "Tarih")!.id;
  cash.rows.push([num(46328, "02.11.2026", "DATE"), text("C"), num(30)]);
  const repeating = await syncSheetsNow(ids.owner2, cashId);
  check(repeating.outcome.error === null && repeating.repeatedKeys === 1, "a run counts the rows it leaves out for repeating a key", repeating);
  // As people do to sort by it: the key property made a date, which pauses the sync.
  await changePropertyType(ids.owner2, keyProp, { type: "date", yes: "Yes" });
  const retyped = await syncSheetsNow(ids.owner2, cashId);
  check(retyped.outcome.error === "keyGone" && !retyped.enabled, "a key property made a date pauses the sync", retyped.outcome);
  check((await failure(() => syncSheetsByPlace(ids.guest, cashId, "Satır"))) === "access", "only people with full access change how rows are found");
  const turned = await syncSheetsByPlace(ids.owner2, cashId, "Satır");
  const cashProps = await getProperties(cashId);
  const cashProp = (name: string) => cashProps.find((p) => p.name === name)!.id;
  const cashRows = await db.select({ properties: page.properties, archivedAt: page.archivedAt }).from(page).where(eq(page.parentId, cashId));
  check(
    turned.keyColumn === "" && turned.outcome.error === null && turned.enabled && turned.repeatedKeys === 0 && cashRows.filter((r) => r.archivedAt).length === 2,
    "turning to place puts the rows in the trash and reads them again",
    turned,
  );
  check(
    cashRows
      .filter((r) => !r.archivedAt)
      .map((r) => `${r.properties[cashProp("Satır")]}:${r.properties[keyProp]}:${r.properties[cashProp("Firma")]}`)
      .sort()
      .join("|") === "2:2026-11-01:A|3:2026-11-02:B|4:2026-11-02:C" && cashProps.filter((p) => p.name === "Tarih").length === 1,
    "…every row of the sheet, the old key property kept as the date it was made",
    cashRows,
  );

  console.log(`\n${passed} checks passed`);
} finally {
  for (const c of await db.select({ id: connection.id }).from(connection).where(inArray(connection.workspaceId, [workspaceId, otherWorkspace]))) dropClient(c.id);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  http.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
