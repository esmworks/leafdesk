/**
 * End-to-end check of "Export as PDF", the print view (`/print/<pageId>`): what it holds for the
 * person printing (headings, tables, code, images, diagrams, a database), pages the body links to
 * printed as their titles (and "No access" for pages hidden from them), subpages in sidebar order
 * without the hidden ones, database rows as text, links shown as mentions as links with their title
 * and cropped images as their part. With PRINT_E2E_URL pointing at a running
 * server, also over HTTP: sign-in needed, 404 for people who can't view the page, the page's
 * content in the HTML, its title as the document title, uploaded images loading with the same
 * session, and the workspace's two-step policy.
 * Creates its own users, workspace and files, and deletes all of it afterwards.
 *
 *   pnpm tsx scripts/print-e2e.ts
 *   PRINT_E2E_URL=http://localhost:4400 pnpm tsx scripts/print-e2e.ts    # with the HTTP checks
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be
 * applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { Readable } = await import("node:stream");
const { randomBytes } = await import("node:crypto");

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { file, page, session, user, workspace, workspaceMember } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");
const files = await import("@/server/files");
const { instanceStorage } = await import("@/server/storage");
const { printDocument } = await import("@/server/print");

const RUN = `print-e2e-${Date.now().toString(36)}`;

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

async function eventually(fn: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;
const link = (pageId: string, text = "x") => `[${text}](/w/${workspaceId}/p/${pageId})`;
const htmlOf = (blocks: { kind: string; html?: string }[]) => blocks.map((b) => (b.kind === "html" ? b.html : "")).join("");

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: `${RUN}` },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);
  const owner = { userId: ids.owner };

  // Report
  //   Child            linked from Report's body
  //     Grandchild
  //   Secret           only the owner can see it
  //   Tasks (database) rows "Ship" and "Write docs"
  const report = await createPage(owner, { workspaceId, title: "Quarterly report" });
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f1d1f30000000049454e44ae426082", "hex"),
  ]);
  const photo = await files.uploadFile(ids.owner, report.id, { name: "chart.png", contentType: "image/png", body: Readable.from([png]), declaredSize: png.length });
  const child = await createPage(owner, { workspaceId, parentId: report.id, title: "Child page", markdown: "Child body text" });
  await createPage(owner, { workspaceId, parentId: child.id, title: "Grandchild page", markdown: "## Deep heading" });
  const secret = await createPage(owner, { workspaceId, parentId: report.id, title: "Secret plans", markdown: "Top secret body" });
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");
  const tasks = await createPage(owner, { workspaceId, parentId: report.id, title: "Tasks", kind: "database" });
  await createPage(owner, { workspaceId, parentId: tasks.id, title: "Ship" });
  await createPage(owner, { workspaceId, parentId: tasks.id, title: "Write docs" });
  const longLine = `const value = "${"wrap-me-".repeat(30)}";`;
  await service.replaceContent(
    report.id,
    [
      "## Overview",
      "",
      `See ${link(child.id)} and ${link(secret.id)}.`,
      "",
      "| Region | Revenue |",
      "| --- | --- |",
      "| North | 1200 |",
      "",
      "```ts",
      longLine,
      "```",
      "",
      `![chart](/api/files/${photo.id})`,
      "",
      "```mermaid",
      "graph TD; Start-->Finish",
      "```",
      "",
      "<!-- leafdesk:columns -->",
      "",
      "<!-- leafdesk:column -->",
      "",
      "Left column text",
      "",
      "<!-- leafdesk:column width=1.5 -->",
      "",
      "Right column text",
      "",
      "<!-- leafdesk:/columns -->",
    ].join("\n"),
    owner,
  );
  // A link shown as a mention, and a cropped image (lib/image-crop).
  await service.appendBlocks(
    report.id,
    [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Docs: ", styles: {} },
          { type: "mention", props: { kind: "link", url: "https://example.com/guide", title: "The guide", favicon: "https://example.com/i.ico", siteName: "Example" } },
        ],
      },
      { type: "image", props: { url: `/api/files/${photo.id}`, name: "crop.png", previewWidth: 300, crop: JSON.stringify({ x: 0.5, y: 0, w: 0.5, h: 0.5, ar: 2 }) } },
    ],
    owner,
  );
  // The HTTP server reads the stored document; wait for the store hook to write it.
  await eventually(async () => {
    const [row] = await db.select({ md: page.contentMarkdown }).from(page).where(eq(page.id, report.id));
    return Boolean(row?.md.includes("Right column text"));
  }, "the report's body");

  // What the owner prints
  const own = await printDocument(ids.owner, report.id);
  check(own.sections.length === 1 && own.sections[0].title === "Quarterly report" && own.workspaceId === workspaceId, "a page prints alone by default");
  const ownHtml = htmlOf(own.sections[0].body);
  check(/<h2 id="heading-1"[^>]*>(?:<span id="block-[\w-]+" class="block-anchor"><\/span>)?Overview<\/h2>/.test(ownHtml), "headings keep their anchors", ownHtml);
  check(/<span id="block-[\w-]+" class="block-anchor"><\/span>Overview/.test(ownHtml), "…and blocks have anchors for links to a block", ownHtml);
  check(ownHtml.includes("<table") && ownHtml.includes("North") && ownHtml.includes("1200"), "tables print", ownHtml);
  check(ownHtml.includes("<pre") && ownHtml.includes("wrap-me-wrap-me"), "code blocks print", ownHtml);
  check(ownHtml.includes(`/api/files/${photo.id}`), "uploaded images point at the file route", ownHtml);
  check(/<a href="https:\/\/example\.com\/guide"[^>]*>The guide<\/a>/.test(ownHtml) && !ownHtml.includes("i.ico"), "a link shown as a mention prints as a link with its title", ownHtml);
  check(
    /<div data-image-crop="" style="position:relative;overflow:hidden;aspect-ratio:2;[^"]*width:300px;max-width:100%"[^>]*><img[^>]*style="position:absolute;max-width:none;width:200%;height:200%;left:-100%;top:0%"/.test(ownHtml),
    "a cropped image prints as its part",
    ownHtml,
  );
  check(own.sections[0].body.some((b) => b.kind === "mermaid" && b.source.includes("Start-->Finish")), "Mermaid diagrams come as their source, drawn in the browser");
  check(ownHtml.includes("Child page") && ownHtml.includes("Secret plans"), "linked pages print as their titles", ownHtml);
  const columns = own.sections[0].body.find((b) => b.kind === "columns");
  check(
    columns?.kind === "columns" &&
      JSON.stringify(columns.columns.map((c) => [c.width, htmlOf(c.segments).includes(c.width === 1 ? "Left column text" : "Right column text")])) ===
        JSON.stringify([[1, true], [1.5, true]]),
    "columns print with their widths and blocks",
    columns,
  );
  check(!ownHtml.includes(`/p/${child.id}`) && !ownHtml.includes(`/p/${secret.id}`), "…not as links", ownHtml);
  check(
    JSON.stringify(own.sections[0].children.map((c) => c.title)) === JSON.stringify(["Child page", "Secret plans", "Tasks"]),
    "its subpages are listed by title",
    own.sections[0].children,
  );

  const ownAll = await printDocument(ids.owner, report.id, { subpages: true });
  check(
    JSON.stringify(ownAll.sections.map((s) => [s.title, s.depth])) ===
      JSON.stringify([
        ["Quarterly report", 0],
        ["Child page", 1],
        ["Grandchild page", 2],
        ["Secret plans", 1],
        ["Tasks", 1],
      ]),
    "with subpages, the pages under it follow in sidebar order (rows stay in their database)",
    ownAll.sections.map((s) => [s.title, s.depth]),
  );
  check(!ownAll.truncated, "…all of them");
  check(htmlOf(ownAll.sections[2].body).includes('id="p3-heading-1"'), "subpages' heading anchors don't clash with the page's");
  const table = ownAll.sections[4].database;
  check(table && JSON.stringify(table.rows.map((r) => r.title)) === JSON.stringify(["Ship", "Write docs"]), "a database prints its rows", table?.rows);

  // What a member who can't see Secret prints
  const member = await printDocument(ids.member, report.id, { subpages: true });
  check(!member.sections.some((s) => s.title === "Secret plans"), "hidden subpages are left out");
  const memberHtml = htmlOf(member.sections[0].body);
  check(memberHtml.includes("No access") && !memberHtml.includes("Secret plans"), "links to hidden pages say \"No access\"", memberHtml);
  check((await printDocument(ids.member, secret.id).then(() => "ok", (e) => (e instanceof AccessError ? "access" : String(e)))) === "access", "a hidden page can't be printed");
  check((await printDocument(ids.outsider, report.id).then(() => "ok", (e) => (e instanceof AccessError ? "access" : String(e)))) === "access", "nor can people outside the workspace print it");

  // Over HTTP, when a server is running
  const base = (process.env.PRINT_E2E_URL ?? "").replace(/\/$/, "");
  const up = base ? await fetch(`${base}/api/auth/ok`).then(() => true, () => false) : false;
  if (!up) {
    console.log("\n(skipped the HTTP checks: set PRINT_E2E_URL to a running server)");
  } else {
    const cookieFor = async (userId: string, authMethod: string | null = null) => {
      const token = randomBytes(24).toString("hex");
      await db
        .insert(session)
        .values({ id: `${RUN}-session-${userId}`, token, userId, authMethod, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
      return `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`;
    };
    // The owner signed in with a passkey, which passes a two-step policy; the member didn't.
    const ownerCookie = await cookieFor(ids.owner, "passkey");
    const memberCookie = await cookieFor(ids.member);
    const outsiderCookie = await cookieFor(ids.outsider);
    const get = (path: string, cookie?: string) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
    const printUrl = `/print/${report.id}`;

    const anonymous = await get(printUrl);
    check(
      anonymous.status === 307 && (anonymous.headers.get("location") ?? "").includes(`/sign-in?next=${encodeURIComponent(printUrl)}`),
      "HTTP: printing needs a session (back to the print view after signing in)",
      anonymous.headers.get("location"),
    );
    check((await get(printUrl, outsiderCookie)).status === 404, "HTTP: people outside the workspace get 404");
    check((await get(`/print/${secret.id}`, memberCookie)).status === 404, "HTTP: pages hidden from the reader are 404");
    check((await get(`/print/${RUN}-missing`, ownerCookie)).status === 404, "HTTP: …the same as missing ones");

    const res = await get(printUrl, ownerCookie);
    const html = await res.text();
    check(res.status === 200 && res.headers.get("content-type")?.startsWith("text/html"), "HTTP: the owner gets the print view", res.status);
    check(html.includes("data-print-view") && html.includes("<title>Quarterly report</title>"), "HTTP: …titled after the page, which names the saved PDF", html.match(/<title>[^<]*<\/title>/)?.[0]);
    check(
      html.includes("Overview") && html.includes("North") && html.includes("wrap-me-wrap-me") && html.includes("Start--&gt;Finish"),
      "HTTP: …with the heading, table, code and diagram source",
    );
    check(html.includes(`src="/api/files/${photo.id}"`), "HTTP: …and the image");
    check(html.includes("Left column text") && html.includes("flex-grow:1.5"), "HTTP: …and the columns, side by side at their widths");
    check(!html.includes(`href="/w/${workspaceId}/p/${child.id}"`), "HTTP: linked pages aren't links");
    check(html.includes("@page"), "HTTP: …and page margins are set for print");
    const image = await get(`/api/files/${photo.id}`, ownerCookie);
    check(image.status === 200 && image.headers.get("content-type")?.startsWith("image/png"), "HTTP: the image loads with the same session", image.status);

    const withSubpages = await (await get(`${printUrl}?subpages=1`, memberCookie)).text();
    check(
      withSubpages.includes("Grandchild page") && withSubpages.includes("Deep heading") && !withSubpages.includes("Top secret body"),
      "HTTP: with subpages, the member gets the pages they can see",
    );

    await updateWorkspaceSettings(ids.owner, workspaceId, { requireTwoFactor: true }, { strongSession: true });
    const gated = await get(printUrl, memberCookie);
    check(
      gated.status === 307 && gated.headers.get("location")?.endsWith(`/two-step/${encodeURIComponent(workspaceId)}`),
      "HTTP: the workspace's two-step policy applies",
      gated.headers.get("location"),
    );
    check((await get(printUrl, ownerCookie)).status === 200, "HTTP: …and a session that passes it prints");
  }

  console.log(`\n${passed} checks passed`);
} finally {
  const stored = await db.select({ key: file.storageKey }).from(file).where(inArray(file.workspaceId, [workspaceId, otherWorkspace]));
  for (const { key } of stored) await instanceStorage().delete(key).catch(() => {});
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
