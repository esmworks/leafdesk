/**
 * End-to-end check of Google Sheets syncs, with a fake Google Sheets MCP server (started here,
 * `get_spreadsheet` answering as Google's does: the spreadsheet's sheets, then typed cells of a
 * range) behind a real connection row, so the calls go through the connection client: who may sync
 * through a connection (owners; members only once an owner allowed the AI chat the tool; guests
 * never), setting one up from a link (the sheet by its gid, the header below two summary rows,
 * columns without a header left out, numbers, dates, times, checkboxes and mixed columns as text),
 * a run writing the sheet's changes over, adding rows and keeping rows that left it, a renamed
 * sheet found by its id, the audit log of each call, and runs that can't happen: a connection
 * signed out, a member no longer allowed, a key column whose header changed, a sheet too big.
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
const { auditEvent, connection, databaseSync, databaseView, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { MAX_SHEET_CELLS } = await import("@/lib/sheets-sync");
type SheetCell = import("@/lib/sheets-sync").SheetCell;
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { getProperties } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { dropClient } = await import("@/server/connections/client");
const { JiraError } = await import("@/server/jira-sync/client");
const { createSheetsSync, getSheetsSync, sheetsSources, stopSheetsSync, syncSheetsNow, updateSheetsSync } = await import("@/server/sheets-sync/manage");

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
    if (error instanceof JiraError) return error.code;
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

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest` };
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
  const setup = { workspaceId, parentId: home.id, connectionId: sheetsConn, link, intervalMinutes: 0 };
  check((await failure(() => createSheetsSync(owner, { ...setup, link: "https://example.test/sheet" }))) === "invalidInput", "a link that isn't a spreadsheet's is refused");
  check((await failure(() => createSheetsSync(owner, { ...setup, connectionId: elsewhere }))) === "forbidden", "another workspace's connection can't be used");
  check((await failure(() => createSheetsSync({ userId: ids.guest }, { ...setup, parentId: null }))) !== null, "a guest can't set one up");
  check((await failure(() => createSheetsSync(owner, { ...setup, link: link.replaceAll(String(STOCK_ID), "42") }))) === "notFound", "a sheet the spreadsheet doesn't have is refused");
  check((await failure(() => createSheetsSync(owner, { ...setup, keyColumn: "SKU" }))) === "invalidInput", "…so is a key column the header doesn't have");

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

  // Changing and stopping
  const moved = await updateSheetsSync(ids.owner, databaseId, { connectionId: second });
  check(moved.connectionId === second && moved.lastError === null && moved.enabled, "switching to another connection reads through it at once", moved);
  check((await failure(() => updateSheetsSync(ids.guest, databaseId, { intervalMinutes: 15 }))) === "access", "only people with full access change a sync");
  await stopSheetsSync(ids.owner, databaseId);
  check((await getSheetsSync(ids.owner, databaseId)) === null && (await rows()).length === 4, "stopping keeps the rows");

  console.log(`\n${passed} checks passed`);
} finally {
  for (const c of await db.select({ id: connection.id }).from(connection).where(inArray(connection.workspaceId, [workspaceId, otherWorkspace]))) dropClient(c.id);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  http.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
