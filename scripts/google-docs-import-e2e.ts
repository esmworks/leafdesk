/**
 * End-to-end check of importing Google documents through a Google Drive connection, with a fake
 * Drive MCP server (started here, `search_files` and `download_file_content` as Google's answer
 * them) behind a real connection row, so the calls go through the connection client: which
 * connections owners, members and guests may import through (members only what an owner allowed
 * the AI chat), searching by title, importing documents as pages (titled by their first heading or
 * their name, all or nothing), the audit log (the import and each call), and refusals: a document
 * the connection can't read, one that isn't a Word export, too many, another workspace's
 * connection or page, a connection signed out or out of reach.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/google-docs-import-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { createServer } = await import("node:http");
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-gdocs-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;

// The fake Drive server, on a port of its own; a second port nothing listens on.
const FAKE_PORT = 30_000 + Math.floor(Math.random() * 20_000);
const DEAD_PORT = FAKE_PORT + 1;
process.env.CONNECTOR_ALLOWED_HOSTS = `localhost:${FAKE_PORT},localhost:${DEAD_PORT}`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, desc, eq, inArray, isNull } = await import("drizzle-orm");
const z = await import("zod");
const { McpServer, createMcpHandler } = await import("@modelcontextprotocol/server");
const { db } = await import("@/db");
const { auditEvent, connection, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { DOCX_MIME, GOOGLE_DOC_MIME } = await import("@/lib/import/google-docs");
const { ImportError } = await import("@/lib/import/result");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { AccessError } = await import("@/server/access");
const { dropClient } = await import("@/server/connections/client");
const { GoogleDocsError, googleDocsSources, importGoogleDocs, searchGoogleDocs } = await import("@/server/import/google-docs");
const { docx, paragraph } = await import("@/server/import/docx-fixtures");

const RUN = `gdocs-e2e-${Date.now().toString(36)}`;
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
    if (error instanceof AccessError) return "access";
    if (error instanceof ImportError || error instanceof GoogleDocsError) return error.code;
    throw error;
  }
}

// The documents the fake Drive has: Word exports by id; one that answers with something else.
const id = (n: number) => `${RUN.replace(/[^A-Za-z0-9]/g, "")}doc${n}`.padEnd(30, "x");
const DOCS = new Map([
  [id(1), { title: "Quarterly plan", data: docx({ body: paragraph("Plan for the quarter", { style: "Heading1" }) + paragraph("Ship the importer.") }) }],
  [id(2), { title: "Meeting notes", data: docx({ body: paragraph("Just notes from Monday.") }) }],
]);
const NOT_WORD = id(3);
const MISSING = id(4);
const seen: { tool: string; args: Record<string, unknown> }[] = [];

const fake = createMcpHandler(() => {
  const server = new McpServer({ name: "fake-drive", version: "1.0.0" });
  server.registerTool(
    "search_files",
    {
      description: "Search for Drive files.",
      inputSchema: z.object({ query: z.string(), pageSize: z.number().optional(), pageToken: z.string().optional(), excludeContentSnippets: z.boolean().optional() }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      seen.push({ tool: "search_files", args });
      const words = [...args.query.matchAll(/title contains '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].toLowerCase());
      const files = [...DOCS].filter(([, d]) => words.every((w) => d.title.toLowerCase().includes(w)));
      // Drive answers an empty search with an empty object.
      const answer = files.length
        ? {
            files: [
              ...files.map(([fileId, d]) => ({ id: fileId, title: d.title, mimeType: GOOGLE_DOC_MIME, modifiedTime: "2026-10-02T08:04:12.433Z", owner: "drive@example.test" })),
              { id: id(9), title: "A sheet", mimeType: "application/vnd.google-apps.spreadsheet" },
            ],
            ...(args.pageToken ? {} : { nextPageToken: "page-2" }),
          }
        : {};
      return { content: [{ type: "text" as const, text: JSON.stringify(answer) }] };
    },
  );
  server.registerTool(
    "download_file_content",
    {
      description: "Download a file's content.",
      inputSchema: z.object({ fileId: z.string(), exportMimeType: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      seen.push({ tool: "download_file_content", args });
      if (args.fileId === NOT_WORD) return { content: [{ type: "text" as const, text: JSON.stringify({ id: NOT_WORD, title: "Odd", content: Buffer.from("plain text").toString("base64") }) }] };
      const doc = DOCS.get(args.fileId);
      if (!doc || args.exportMimeType !== DOCX_MIME) return { isError: true, content: [{ type: "text" as const, text: "File not found." }] };
      // As structured content here, as text in the search: the import reads both.
      return {
        content: [{ type: "text" as const, text: "(see structured content)" }],
        structuredContent: { id: args.fileId, title: doc.title, mimeType: DOCX_MIME, content: Buffer.from(doc.data).toString("base64") },
      };
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

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;
const TOOLS = ["search_files", "download_file_content"].map((name) => ({ name, title: null, description: name, inputSchema: { type: "object" }, hinted: "read" as const, kind: "read" as const }));
const connectionRow = (values: { id: string; workspaceId: string; url: string; status?: "ready" | "needsAuth"; chatTools?: string[]; tools?: typeof TOOLS }) => ({
  name: `Drive ${values.id}`,
  slug: values.id.slice(-20).replace(/[^a-z0-9]/gi, "").toLowerCase(),
  authType: "none" as const,
  status: "ready" as const,
  tools: TOOLS,
  chatTools: [],
  eventSecret: "unused",
  ...values,
});

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
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
    { workspaceId: otherWorkspace, userId: ids.owner, role: "owner" },
  ]);
  const drive = `${RUN}-drive`;
  const signedOut = `${RUN}-signedout`;
  const docsOnly = `${RUN}-docsonly`;
  const dead = `${RUN}-dead`;
  const elsewhere = `${RUN}-elsewhere`;
  await db.insert(connection).values([
    connectionRow({ id: drive, workspaceId, url: `http://localhost:${FAKE_PORT}/mcp` }),
    connectionRow({ id: signedOut, workspaceId, url: `http://localhost:${FAKE_PORT}/mcp`, status: "needsAuth" }),
    connectionRow({ id: docsOnly, workspaceId, url: `http://localhost:${FAKE_PORT}/mcp`, tools: [{ ...TOOLS[0], name: "read_doc" }] }),
    connectionRow({ id: dead, workspaceId, url: `http://localhost:${DEAD_PORT}/mcp` }),
    connectionRow({ id: elsewhere, workspaceId: otherWorkspace, url: `http://localhost:${FAKE_PORT}/mcp` }),
  ]);
  const owner = { userId: ids.owner };
  const home = await createPage(owner, { workspaceId, title: "Home" });
  const away = await createPage(owner, { workspaceId: otherWorkspace, title: "Away" });

  // Which connections each person may import through
  const ownerSources = await googleDocsSources(ids.owner, workspaceId);
  check(
    ownerSources.map((s) => s.id).sort().join() === [drive, dead].sort().join() && ownerSources.every((s) => s.search),
    "owners may import through ready connections with Drive's tools (not one signed out, not a Docs-only one)",
    ownerSources,
  );
  check((await googleDocsSources(ids.member, workspaceId)).length === 0, "members may not while an owner hasn't allowed the chat the download");
  check((await googleDocsSources(ids.guest, workspaceId)).length === 0, "guests never may");
  check((await failure(() => googleDocsSources(ids.outsider, workspaceId))) === "access", "people outside the workspace are refused");
  await db.update(connection).set({ chatTools: ["download_file_content"] }).where(eq(connection.id, drive));
  const memberSources = await googleDocsSources(ids.member, workspaceId);
  check(
    memberSources.length === 1 && memberSources[0].id === drive && !memberSources[0].search,
    "with the download allowed in chat members may import through it, without searching",
    memberSources,
  );
  check(
    (await failure(() => searchGoogleDocs(ids.member, { connectionId: drive, words: "plan" }))) === "noConnection",
    "a member's search is refused while the chat may not search",
  );
  check(
    (await googleDocsSources(ids.guest, workspaceId)).length === 0 &&
      (await failure(() => importGoogleDocs({ userId: ids.guest }, { connectionId: drive, workspaceId, parentId: home.id, ids: [id(1)] }))) === "noConnection",
    "guests still may not, even with the chat allowed",
  );

  // Searching
  const found = await searchGoogleDocs(ids.owner, { connectionId: drive, words: "quarterly PLAN" });
  const searchCall = seen.findLast((c) => c.tool === "search_files");
  check(
    found.docs.length === 1 && found.docs[0].id === id(1) && found.docs[0].title === "Quarterly plan" && found.next === "page-2",
    "a search lists the Google documents whose title has the words (not other files), with the next page",
    found,
  );
  check(
    searchCall?.args.query === `mimeType = '${GOOGLE_DOC_MIME}' and title contains 'quarterly' and title contains 'PLAN'` && searchCall.args.excludeContentSnippets === true,
    "…asking Drive for documents by title, without their content",
    searchCall,
  );
  const latest = await searchGoogleDocs(ids.owner, { connectionId: drive, words: "", pageToken: "page-2" });
  check(latest.docs.length === 2 && latest.next === null && seen.findLast((c) => c.tool === "search_files")?.args.pageToken === "page-2", "no words lists the latest documents; the next page is asked for by its token", latest);
  check((await searchGoogleDocs(ids.owner, { connectionId: drive, words: "nothing like it" })).docs.length === 0, "a search with no match finds nothing");

  // Importing
  const before = await db.select({ id: auditEvent.id }).from(auditEvent).where(eq(auditEvent.workspaceId, workspaceId));
  const result = await importGoogleDocs(owner, { connectionId: drive, workspaceId, parentId: home.id, ids: [id(1), id(2), id(1)] });
  const pages = await db.select({ id: page.id, title: page.title }).from(page).where(and(eq(page.parentId, home.id), isNull(page.archivedAt))).orderBy(page.position);
  check(
    result.pages.map((p) => p.title).join("|") === "Plan for the quarter|Meeting notes" && pages.length === 2 && result.created.pages === 2,
    "each document becomes a page, once, titled by its first heading or else its name",
    { result, pages },
  );
  const firstBody = (await getCollab().readPage(pages[0].id)).markdown;
  const secondBody = (await getCollab().readPage(pages[1].id)).markdown;
  check(firstBody.includes("Ship the importer.") && !firstBody.includes("Plan for the quarter") && secondBody.includes("Just notes from Monday."), "…with the document's content", { firstBody, secondBody });
  check(
    seen.filter((c) => c.tool === "download_file_content").every((c) => c.args.exportMimeType === DOCX_MIME),
    "documents are exported as Word documents",
  );
  const audit = await db
    .select({ action: auditEvent.action, actorId: auditEvent.actorUserId, details: auditEvent.details, targetId: auditEvent.targetId })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId)))
    .orderBy(desc(auditEvent.createdAt));
  const fresh = audit.slice(0, audit.length - before.length);
  const imported = fresh.find((e) => e.action === "page.imported");
  const calls = fresh.filter((e) => e.action === "connection.tool_called" && (e.details as { tool?: string }).tool === "download_file_content");
  check(
    (imported?.details as { format?: string; count?: number })?.format === "google-docs" && (imported?.details as { count?: number }).count === 2,
    "the audit log records the import as from Google Docs",
    imported,
  );
  check(
    calls.length === 2 && calls.every((c) => c.actorId === ids.owner && c.targetId === drive && (c.details as { via?: string; outcome?: string }).via === "import" && (c.details as { outcome?: string }).outcome === "done"),
    "…and each download, as the person through the connection",
    calls,
  );

  const memberResult = await importGoogleDocs({ userId: ids.member }, { connectionId: drive, workspaceId, parentId: null, ids: [id(2)] });
  const memberPage = await db.select({ parentId: page.parentId, workspaceId: page.workspaceId }).from(page).where(eq(page.id, memberResult.pages[0].id));
  check(memberResult.pages[0].title === "Meeting notes" && memberPage[0]?.parentId === null && memberPage[0].workspaceId === workspaceId, "a member allowed the download imports at the top level", memberResult);

  // Refusals: nothing is created
  const count = async () => (await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId))).length;
  const pagesBefore = await count();
  check((await failure(() => importGoogleDocs(owner, { connectionId: drive, workspaceId, parentId: home.id, ids: [id(1), MISSING] }))) === "notFound", "a document the connection can't read stops the import");
  check((await failure(() => importGoogleDocs(owner, { connectionId: drive, workspaceId, parentId: home.id, ids: [id(1), NOT_WORD] }))) === "notADocument", "…so does an answer that isn't a Word document");
  check((await failure(() => importGoogleDocs(owner, { connectionId: drive, workspaceId, parentId: home.id, ids: ["not an id"] }))) === "notADocument", "…and something that isn't a document id");
  check(
    (await failure(() => importGoogleDocs(owner, { connectionId: drive, workspaceId, parentId: home.id, ids: Array.from({ length: 21 }, (_, i) => id(100 + i)) }))) === "tooManyFiles",
    "at most 20 documents at a time",
  );
  check((await failure(() => importGoogleDocs(owner, { connectionId: drive, workspaceId, parentId: home.id, ids: [] }))) === "nothingToImport", "…and at least one");
  check((await count()) === pagesBefore, "nothing is created when an import is refused");
  check(
    (await failure(() => importGoogleDocs(owner, { connectionId: drive, workspaceId: otherWorkspace, parentId: away.id, ids: [id(1)] }))) === "noConnection",
    "a connection's documents stay in its workspace (not under another workspace's page)",
  );
  check(
    (await failure(() => importGoogleDocs({ userId: ids.outsider }, { connectionId: drive, workspaceId, parentId: null, ids: [id(1)] }))) === "noConnection" &&
      (await failure(() => searchGoogleDocs(ids.member, { connectionId: elsewhere, words: "" }))) === "noConnection",
    "another workspace's connection can't be used",
  );
  check((await failure(() => importGoogleDocs(owner, { connectionId: signedOut, workspaceId, parentId: home.id, ids: [id(1)] }))) === "noConnection", "nor one that is signed out");
  check((await failure(() => importGoogleDocs(owner, { connectionId: docsOnly, workspaceId, parentId: home.id, ids: [id(1)] }))) === "noConnection", "nor one without Drive's download");
  check((await failure(() => searchGoogleDocs(ids.owner, { connectionId: dead, words: "" }))) === "unreachable", "a connection out of reach says so");
  await db.update(connection).set({ chatTools: [] }).where(eq(connection.id, drive));
  check(
    (await failure(() => importGoogleDocs({ userId: ids.member }, { connectionId: drive, workspaceId, parentId: null, ids: [id(1)] }))) === "noConnection",
    "once an owner takes the chat's download away, members can't import through it",
  );
  const failedCall = await db
    .select({ details: auditEvent.details })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "connection.tool_called"), eq(auditEvent.targetId, dead)));
  check(failedCall.length === 1 && (failedCall[0].details as { outcome?: string }).outcome === "failed", "a call that failed is recorded as failed", failedCall);

  console.log(`\n${passed} checks passed`);
} finally {
  for (const c of await db.select({ id: connection.id }).from(connection).where(inArray(connection.workspaceId, [workspaceId, otherWorkspace]))) dropClient(c.id);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  await rm(uploadDir, { recursive: true, force: true });
  http.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
