/**
 * End-to-end check of the editor's server side: downloading a file a page shows from another site
 * (GET /api/files/external: signed in, page access, public https addresses only, saved as an
 * attachment) and what readers see of comment threads mentioned or previewed in a page
 * (server/comment-refs: the thread for those who may open its page, "none" for everyone else).
 * Creates its own users, workspaces and pages and deletes them afterwards.
 *
 *   pnpm tsx scripts/editor-extras-e2e.ts
 *
 * Needs a running server (`pnpm start` or `pnpm dev`) on APP_URL (default http://localhost:3000)
 * sharing DATABASE_URL, both read from .env when present. The external download of a real file
 * needs the internet; without it that one check is skipped and says so.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createPage } = await import("@/server/pages");
const { resolveCommentRefs } = await import("@/server/comment-refs");
const { downloadUrl } = await import("@/lib/downloads");

const BASE = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const RUN = `editor-extras-e2e-${Date.now().toString(36)}`;

// The threads of the pages made here, as the collaboration document would hold them.
const threads = new Map<string, unknown[]>();
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
  async readThreads(pageId: string) {
    return threads.get(pageId) ?? [];
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

const ids = { alice: `${RUN}-alice`, carol: `${RUN}-carol` };
const wsA = `${RUN}-ws-a`;
const wsC = `${RUN}-ws-c`;
const email = `${RUN}@example.test`;
let signedUp: string | null = null;

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id === ids.alice ? "Alice Example" : "Carol", email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: wsA, name: `${RUN} A` },
    { id: wsC, name: `${RUN} C` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: wsA, userId: ids.alice, role: "owner" },
    { workspaceId: wsC, userId: ids.carol, role: "owner" },
  ]);

  // ------------------------------------------------------------------ comment references
  const page = await createPage({ userId: ids.alice }, { workspaceId: wsA, title: `${RUN} Plans` });
  const at = new Date().toISOString();
  const comment = (id: string, text: string, deleted = false) => ({
    id,
    userId: ids.alice,
    createdAt: at,
    updatedAt: at,
    deletedAt: deleted ? at : null,
    body: deleted ? null : [{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }],
    reactions: [],
  });
  threads.set(page.id, [
    { id: "t-open", createdAt: at, updatedAt: at, resolved: false, resolvedBy: null, comments: [comment("c1", "Ship  it\non Friday"), comment("c2", "Agreed")] },
    { id: "t-gone", createdAt: at, updatedAt: at, resolved: true, resolvedBy: ids.alice, comments: [comment("c3", "", true)] },
  ]);

  const [open, gone, missing] = await resolveCommentRefs(ids.alice, [
    { pageId: page.id, threadId: "t-open" },
    { pageId: page.id, threadId: "t-gone" },
    { pageId: page.id, threadId: "t-none" },
  ]);
  check(open.status === "ok", "the author sees a thread of a page they can open", open);
  if (open.status === "ok") {
    check(open.authorName === "Alice Example" && open.text === "Ship it on Friday", "with its author and its first comment's text on one line", open);
    check(open.replies === 1 && !open.resolved && open.workspaceId === wsA && open.pageTitle === `${RUN} Plans`, "its replies, state and page", open);
  }
  check(gone.status === "none" && missing.status === "none", "a thread whose comments are deleted, or that doesn't exist, reads as none");
  const [outsider] = await resolveCommentRefs(ids.carol, [{ pageId: page.id, threadId: "t-open" }]);
  check(outsider.status === "none" && !("text" in outsider) && !("authorName" in outsider), "someone who can't open the page gets none, and nothing of the thread", outsider);
  const [unknownPage] = await resolveCommentRefs(ids.alice, [{ pageId: `${RUN}-nope`, threadId: "t-open" }]);
  check(unknownPage.status === "none", "a page that doesn't exist reads the same");
  check((await resolveCommentRefs(ids.alice, [{ pageId: "../x", threadId: "t" }] as never)).length === 0, "malformed ids are dropped");

  // ------------------------------------------------------------------ external downloads
  const health = await fetch(`${BASE}/api/auth/ok`).catch(() => null);
  check(health?.ok, `the server answers on ${BASE}`);
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: `pw-${RUN}-secret`, name: "Downloader" }),
  });
  check(signUp.ok, "a test account signs up", await signUp.clone().text());
  const cookie = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const [me] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  signedUp = me.id;
  await db.insert(workspaceMember).values({ workspaceId: wsA, userId: me.id, role: "member" });
  const shared = await createPage({ userId: me.id }, { workspaceId: wsA, title: `${RUN} Files` });

  const get = (url: string, pageId: string, withCookie = true) =>
    fetch(`${BASE}${downloadUrl(url, { pageId, name: "report.pdf" })}`, { headers: withCookie ? { cookie } : {}, redirect: "manual" });

  check((await get("https://example.com/", shared.id, false)).status === 401, "signed out: 401");
  const elsewhere = await createPage({ userId: ids.carol }, { workspaceId: wsC, title: `${RUN} Carol's` });
  const hidden = await get("https://example.com/", elsewhere.id);
  check(hidden.status === 404, "a page the downloader can't open: 404", hidden.status);
  for (const address of ["https://127.0.0.1/x", "https://localhost/x", "https://10.0.0.1/x", "https://[::1]/x", "https://169.254.169.254/latest", "http://example.com/a.pdf"]) {
    const res = await get(address, shared.id);
    check(res.status === 400, `refused: ${address}`, res.status);
  }
  const real = await get("https://example.com/", shared.id);
  if (real.status === 502) {
    console.log("skip  a public file downloads (no internet here)");
  } else {
    check(real.status === 200, "a public https file downloads", real.status);
    check(/^attachment; filename="report\.pdf"/.test(real.headers.get("content-disposition") ?? ""), "as an attachment under the name given", real.headers.get("content-disposition"));
    check(real.headers.get("content-type") === "application/octet-stream" && real.headers.get("x-content-type-options") === "nosniff", "saved, never shown");
    check((await real.text()).length > 0, "with its bytes");
  }

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [wsA, wsC]));
  await db.delete(user).where(inArray(user.id, [...Object.values(ids), ...(signedUp ? [signedUp] : [])]));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
