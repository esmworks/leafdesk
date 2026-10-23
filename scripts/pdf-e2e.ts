/**
 * End-to-end check of PDF files made on the server (server/pdf.ts) and the AI chat's create_pdf:
 * a row's body printed with its table, Turkish text and an uploaded image, its values only when
 * asked for; the chat making the PDF and attaching it to a row's files property or to the end of a
 * page, after the person agrees (and not when they decline); and the refusals: someone who may only
 * view the page, a locked page, a database, and a workspace whose owners turned export off. The
 * PDFs' text is read back with unpdf. A fake OpenAI-compatible server plays the model.
 * Creates its own users and workspace, stores files in a temporary directory, and deletes all of
 * it afterwards.
 *
 *   pnpm tsx scripts/pdf-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { Readable } = await import("node:stream");

const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-pdf-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, file, page, teamspace, user, workspace, workspaceMember } = await import("@/db/schema");
const { asFiles } = await import("@/lib/files");
const { registerCollab, getCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage, setPageLocked } = await import("@/server/pages");
const databases = await import("@/server/databases");
const files = await import("@/server/files");
const ops = await import("@/server/operations");
const { setPagePermission } = await import("@/server/permissions");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { pagePdf } = await import("@/server/pdf");
const { ExportError } = await import("@/server/export");
const { resetAi, setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
const { startChat } = await import("@/server/ai-chat");
const { decideChange } = await import("@/server/ai-chat-approvals");
const { extractText, getDocumentProxy } = await import("unpdf");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
type ChatEvent = import("@/lib/ai-chat").ChatEvent;
type ChatInput = import("@/server/ai-chat").ChatInput;

const RUN = `pdf-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
setAiEnv({
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
});

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

async function textOfPdf(bytes: Uint8Array) {
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
  return text;
}

/** A model that calls create_pdf with `args`, then answers with the last tool result. */
function pdfMaker(args: Record<string, unknown>) {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (made === 0) return { toolCalls: [{ name: "create_pdf", arguments: args }] };
    const result = request.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content)).at(-1) ?? "";
    return { text: `Done. ${result}` };
  };
}

async function ask(userId: string, input: ChatInput, decide?: "approve" | "decline") {
  const events: ChatEvent[] = [];
  let text = "";
  for await (const event of await startChat(userId, input)) {
    events.push(event);
    if (event.type === "text") text += event.text;
    if (event.type === "reset") text = "";
    if (event.type === "approval" && decide) decideChange(userId, event.id, decide);
  }
  const writes = events.flatMap((e) => (e.type === "step" && e.step.kind === "write" ? [e.step] : []));
  const approvals = events.flatMap((e) => (e.type === "approval" ? [e] : []));
  return { text, writes, approvals, done: events.at(-1)?.type === "done" };
}

/** The last tool result the model got in the latest request. */
const lastToolResult = () =>
  fake.chats
    .at(-1)
    ?.messages.filter((m) => m.role === "tool")
    .map((m) => textOf(m.content))
    .at(-1) ?? "";

const ids = { owner: `${RUN}-owner`, alice: `${RUN}-alice`, bob: `${RUN}-bob` };
const userIds = Object.values(ids);
const { owner, alice, bob } = ids;
const workspaceId = `${RUN}-ws`;
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const OFFER = `**Sayın:** ESM Soğutma — İstanbul

| # | Ürün | Adet | Tutar |
|---|------|---:|---:|
| 1 | GNA 2.500-1 N evaporatör | 1 | 244,13 $ |
| 2 | GBOX 15-C2-140 N kondenser | 1 | 220,97 $ |

- **Ödeme:** 90 gün vadeli çek
- **Geçerlilik:** 15 gün`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: bob, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const ctx = { userId: owner, actor: { userId: owner } };

  const offers = await createPage(ctx.actor, { workspaceId, teamspaceId: general.id, kind: "database", title: "Offers" });
  const pdfs = await databases.addProperty(owner, offers.id, { name: "Offer PDF", type: "files" });
  await databases.addProperty(owner, offers.id, { name: "List price", type: "number" });
  const notes = await databases.addProperty(owner, offers.id, { name: "Notes", type: "text" });
  const row = await ops.createDatabaseRow(ctx, {
    database_id: offers.id,
    title: "3E-20261023-ESM",
    properties: { "List price": 548, Notes: "INTERNAL-NOTE" },
    markdown: OFFER,
  });
  const logo = await files.uploadFile(owner, row.id, { name: "logo.png", contentType: "image/png", body: Readable.from([PNG]), declaredSize: PNG.length });
  await ops.placeFile(ctx, row.id, logo);
  // A private page of the owner's: Alice may edit it, Bob only view it.
  const letter = await createPage(ctx.actor, { workspaceId, teamspaceId: null, title: "Cover letter", markdown: "Dear customer, here is our offer." });
  await setPagePermission(owner, letter.id, alice, "edit");
  await setPagePermission(owner, letter.id, bob, "view");

  // ── The PDF itself ─────────────────────────────────────────────────────────────────────────
  const plain = await pagePdf(alice, row.id);
  check(plain.bytes.subarray(0, 5).toString() === "%PDF-" && plain.title === "3E-20261023-ESM", "a row is made into a PDF named after its title", plain.title);
  const plainText = await textOfPdf(plain.bytes);
  check(
    ["3E-20261023-ESM", "Sayın: ESM Soğutma — İstanbul", "GNA 2.500-1 N evaporatör", "244,13 $", "Ödeme: 90 gün vadeli çek"].every((t) => plainText.includes(t)),
    "…with its title, text and table, Turkish letters intact",
    plainText,
  );
  check(!plainText.includes("INTERNAL-NOTE") && !plainText.includes("548"), "…and without the row's values unless asked for", plainText);
  check(plain.bytes.includes("/Subtype /Image"), "…and the image its body shows embedded");
  const withValues = await textOfPdf((await pagePdf(alice, row.id, { properties: true })).bytes);
  check(withValues.includes("INTERNAL-NOTE") && withValues.includes("548") && withValues.includes("Notes"), "a row's values are listed when asked for", withValues);
  const audits = await db
    .select({ details: auditEvent.details })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "export.page")));
  check(audits.length === 2 && audits.every((a) => (a.details as { format?: string }).format === "pdf"), "each PDF is recorded as an export", audits);

  // ── The chat makes one into a files property ──────────────────────────────────────────────
  fake.setChat(pdfMaker({ page_id: row.id, property: "offer pdf", file_name: "Teklif ESM" }));
  const intoProperty = await ask(alice, { workspaceId, message: "Make the PDF of the offer", mode: "ask" }, "approve");
  check(intoProperty.approvals.length === 1, "the chat asks before making a PDF", intoProperty.approvals);
  const asked = intoProperty.approvals[0].action;
  check(
    asked.action === "createPdf" && asked.title === "Teklif ESM.pdf" && asked.target?.pageId === row.id && asked.changes[0]?.property === "Offer PDF",
    "…saying which file, of which page, into which property",
    asked,
  );
  check(intoProperty.writes.at(-1)?.action === "createPdf" && intoProperty.writes.at(-1)?.outcome === "done", "the step says the PDF was made", intoProperty.writes);
  const [stored] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, row.id));
  const value = asFiles((stored.properties as Record<string, unknown>)[pdfs.id]);
  check(value.length === 1 && value[0].name === "Teklif ESM.pdf" && value[0].type === "application/pdf", "the file is in the row's files property", value);
  const result = lastToolResult();
  check(result.includes(`${value[0].url}`) && result.includes("Offer PDF"), "the model gets the file's link to give the person", result);
  check(intoProperty.text.includes(value[0].url), "…and the answer can pass it on", intoProperty.text);
  const fileId = value[0].url.split("/").pop()!;
  const [pdfFile] = await db.select().from(file).where(eq(file.id, fileId));
  const bytes = await files.readStored(pdfFile);
  check(bytes && (await textOfPdf(bytes)).includes("GBOX 15-C2-140 N kondenser"), "the stored file is the row's PDF");
  check(await files.fileForViewer(bob, fileId), "anyone who can see the row can open the file");

  // ── …or to the end of a page, once allowed ────────────────────────────────────────────────
  fake.setChat(pdfMaker({ page_id: letter.id }));
  const declined = await ask(alice, { workspaceId, message: "PDF of the letter", mode: "ask" }, "decline");
  check(declined.writes.at(-1)?.outcome === "declined", "a declined PDF isn't made", declined.writes);
  const before = (await getCollab().readBlocks(letter.id)).blocks as { type: string }[];
  check(!before.some((b) => b.type === "file"), "…and nothing is attached");
  const auto = await ask(alice, { workspaceId, message: "PDF of the letter", mode: "auto" });
  check(auto.approvals.length === 0 && auto.writes.at(-1)?.outcome === "done", "in Auto the PDF is made without asking", auto.writes);
  const after = (await getCollab().readBlocks(letter.id)).blocks as { type: string; props: { name?: string; url?: string } }[];
  const last = after.at(-1);
  check(last?.type === "file" && last.props.name === "Cover letter.pdf", "the file goes at the end of the page, named after it", after);

  // ── Refusals ──────────────────────────────────────────────────────────────────────────────
  fake.setChat(pdfMaker({ page_id: letter.id }));
  const viewer = await ask(bob, { workspaceId, message: "PDF of the letter", mode: "auto" });
  check(lastToolResult().includes("may only read") && !viewer.writes.length, "someone who may only view the page can't attach a PDF to it", lastToolResult());

  await setPageLocked(owner, letter.id, true);
  await ask(alice, { workspaceId, message: "PDF of the letter", mode: "auto" });
  check(/locked/i.test(lastToolResult()), "a locked page takes no PDF in its text", lastToolResult());
  await setPageLocked(owner, letter.id, false);

  fake.setChat(pdfMaker({ page_id: offers.id }));
  await ask(alice, { workspaceId, message: "PDF of the offers", mode: "auto" });
  check(lastToolResult().includes("is a database"), "a database is refused: its rows or a page are made into PDFs", lastToolResult());

  fake.setChat(pdfMaker({ page_id: row.id, property: "Notes" }));
  await ask(alice, { workspaceId, message: "PDF into notes", mode: "auto" });
  check(lastToolResult().includes("not a files property"), "only a files property takes the file", lastToolResult());
  void notes;

  await updateWorkspaceSettings(owner, workspaceId, { export: false });
  fake.setChat(pdfMaker({ page_id: letter.id }));
  await ask(alice, { workspaceId, message: "PDF of the letter", mode: "auto" });
  check(lastToolResult().includes("turned export off"), "no PDF is made while the workspace's export is off", lastToolResult());
  let refused: unknown = null;
  await pagePdf(alice, letter.id).catch((error) => (refused = error));
  check(refused instanceof ExportError && refused.code === "disabled", "…not even directly", String(refused));

  console.log(`\n${passed} checks passed`);
} finally {
  resetAi();
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  await fake.close();
  hocuspocus.closeConnections();
  await rm(uploadDir, { recursive: true, force: true });
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
