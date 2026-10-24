/**
 * End-to-end check of saving web pages (server/web-clip.ts), against web pages served here on
 * 127.0.0.1: an article as a private page at the top (its text without the clutter, a link back,
 * its pictures copied into the workspace), a recipe into a database as a row (the address in its
 * URL property, the recipe first), a page under a page with a quote, the person's last choice
 * remembered and forgotten once it is gone, redirects followed and checked again, pictures over
 * the count and size limits or not pictures at all left out with warnings, a long page read up to
 * its limit, and refusals: private addresses and ports, a redirect into one, a file that isn't a
 * web page, an error answer, a slow site, and people who may not save there (checked before
 * anything is fetched). Then the REST API's operation and its error answers.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/web-clip-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be applied.
 * The fixture server is let through the address checks with CONNECTOR_ALLOWED_HOSTS=127.0.0.1:<its
 * port>, set here: only that host and port. Every other local address stays refused.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { createServer } = await import("node:http");
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-web-clip-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;

const PORT = 30_000 + Math.floor(Math.random() * 20_000);
const OTHER_PORT = PORT + 1;
process.env.CONNECTOR_ALLOWED_HOSTS = `127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${PORT}`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, file, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage } = await import("@/server/pages");
const { addProperty, getProperties } = await import("@/server/databases");
const { AccessError } = await import("@/server/access");
const { lastWebClipTarget, saveWebPage, WebClipError, WEB_CLIP_LIMITS } = await import("@/server/web-clip");
const { articleHtml, recipeHtml } = await import("@/server/web-clip-fixtures");
const ops = await import("@/server/operations");
const { apiErrorFor } = await import("@/server/api/errors");

const RUN = `webclip-e2e-${Date.now().toString(36)}`;
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
    if (error instanceof WebClipError) return error.code;
    throw error;
  }
}

// 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const many = (n: number) =>
  `<html><head><title>Gallery</title></head><body><article><h1>Gallery</h1>${Array.from(
    { length: n },
    (_, i) => `<p>Picture number ${i} of the harbour at night, with the ferries and their lights on the water.</p><img src="/img/many-${i}.png" alt="${i}">`,
  ).join("")}<p>The odd ones:</p><img src="/img/huge.png"><img src="/img/not-a-picture.png"><img src="/img/missing.png"></article></body></html>`;

/** Pictures of the gallery page besides the three odd ones: three over the count limit. */
const GALLERY = WEB_CLIP_LIMITS.images + 3;

/** What the fixture site was asked for, path by path. */
const hits: string[] = [];
const site = createServer((req, res) => {
  const path = req.url ?? "/";
  hits.push(path);
  const html = (body: string, status = 200) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  };
  if (path === "/article") return html(articleHtml({ imageBase: `${SITE}/img` }));
  if (path === "/recipe") return html(recipeHtml({ imageBase: `${SITE}/img` }));
  if (path === "/gallery") return html(many(GALLERY));
  if (path === "/r1") return res.writeHead(302, { location: "/r2" }).end();
  if (path === "/r2") return res.writeHead(301, { location: `${SITE}/article` }).end();
  if (path === "/to-private") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
  if (path === "/to-other-port") return res.writeHead(302, { location: `http://127.0.0.1:${OTHER_PORT}/` }).end();
  if (path === "/file.pdf") {
    res.writeHead(200, { "content-type": "application/pdf" });
    return res.end("%PDF-1.7");
  }
  if (path === "/gone") return html("<h1>Not here</h1>", 404);
  if (path === "/slow") return void setTimeout(() => html("<h1>Late</h1>"), 3_000);
  if (path === "/long") {
    // Past the page limit: the start is read (its title and first text), the rest isn't.
    res.writeHead(200, { "content-type": "text/html" });
    res.write(`<html><head><title>A very long page</title></head><body><article><h1>A very long page</h1>`);
    const filler = `<p>${"The long page goes on and on about the sea and its weather and its ships. ".repeat(20)}</p>`;
    for (let size = 0; size < WEB_CLIP_LIMITS.pageBytes + 1024 * 1024; size += filler.length) res.write(filler);
    return res.end("<p>THE VERY END</p></article></body></html>");
  }
  if (path === "/img/huge.png") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(Buffer.alloc(WEB_CLIP_LIMITS.imageBytes + 10));
  }
  if (path === "/img/not-a-picture.png") return html("<p>surprise</p>");
  if (path.startsWith("/img/") && path !== "/img/missing.png") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(PNG);
  }
  html("<h1>Not found</h1>", 404);
});
await new Promise<void>((resolve) => site.listen(PORT, "127.0.0.1", resolve));

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;

const body = async (id: string) => (await getCollab().readPage(id)).markdown;
const filesOf = async (id: string) => db.select({ name: file.name, contentType: file.contentType }).from(file).where(eq(file.pageId, id));

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
  ]);
  const owner = { userId: ids.owner };
  const shared = await createPage(owner, { workspaceId, title: "Reading", teamspaceId: undefined });
  const database = await createPage(owner, { workspaceId, title: "Recipes", kind: "database", teamspaceId: undefined });
  await addProperty(ids.owner, database.id, { name: "Source", type: "url" });
  const urlProperty = (await getProperties(database.id)).find((p) => p.type === "url")!;
  const away = await createPage({ userId: ids.outsider }, { workspaceId: otherWorkspace, title: "Away" });

  // An article, as a private page at the top
  check((await lastWebClipTarget(ids.owner, workspaceId)) === null, "with nothing saved yet, the starting place is a private page at the top");
  const article = await saveWebPage(owner, { workspaceId, url: `${SITE}/article`, targetId: null, remember: true, locale: "en" });
  const [articleRow] = await db.select().from(page).where(eq(page.id, article.page.id));
  check(
    articleRow.title === "Night Ferries of the North Sea" && articleRow.parentId === null && articleRow.teamspaceId === null && !article.page.row,
    "an article is saved as a private page at the top, titled by the article",
    articleRow,
  );
  const articleBody = await body(article.page.id);
  check(
    articleBody.startsWith(`[The Harbour Review](${SITE}/article)`) && articleBody.includes("The crew") && articleBody.includes("Leaves at 17:30"),
    "…starting with a link back to the page, then its text",
    articleBody.slice(0, 400),
  );
  check(
    !["Subscribe", "Accept all", "ADVERTISEMENT", "Most read", "First!", "All rights reserved", "hacked"].some((clutter) => articleBody.includes(clutter)),
    "…without the menus, banner, ads, sidebar, comments and footer around it",
    articleBody,
  );
  const articleFiles = await filesOf(article.page.id);
  check(
    articleFiles.length === 2 && article.created.files === 2 && articleFiles.every((f) => f.contentType === "image/png") && articleFiles.map((f) => f.name).sort().join() === "cabin.png,deck.png",
    "…its two pictures copied into the workspace (the lazy-loaded one from its real source), named by their address and type",
    articleFiles,
  );
  check(!articleBody.includes(`${SITE}/img`) && (articleBody.match(/\/api\/files\//g) ?? []).length === 2, "…and shown from there, not from the site", articleBody);
  check(hits.includes("/img/deck.jpg") && hits.includes("/img/cabin.png"), "the pictures were fetched from the site");
  const audit = await db
    .select({ details: auditEvent.details, targetId: auditEvent.targetId })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "page.imported")));
  check(audit.length === 1 && audit[0].targetId === article.page.id && (audit[0].details as { format?: string }).format === "web", "the save is in the audit log as an import from the web", audit);

  // A recipe, into a database
  const recipe = await saveWebPage(owner, { workspaceId, url: `${SITE}/recipe`, targetId: database.id, remember: true, locale: "en" });
  const [recipeRow] = await db.select().from(page).where(eq(page.id, recipe.page.id));
  check(
    recipeRow.parentId === database.id && recipe.page.row && recipeRow.title === "Lentil Soup with Lemon" && (recipeRow.properties as Record<string, unknown>)[urlProperty.id] === `${SITE}/recipe`,
    "a recipe saved into a database becomes its row, with the address in its URL property",
    recipeRow,
  );
  const recipeBody = await body(recipe.page.id);
  const order = ["Kitchen Notes", "**Makes** 4 servings", "**Prep** 15 min", "Ingredients", "[ ] 1 cup red lentils", "[ ] Juice of 1 lemon & its zest", "Steps", "The soup", "1. Warm the oil", "To serve", "Stir in the lemon", "***", "Winter"];
  let at = -1;
  const positions = order.map((part) => {
    const found = recipeBody.indexOf(part, at + 1);
    at = found >= 0 ? found : at;
    return found;
  });
  check(
    positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
    "…its body starts with the recipe: what it makes and how long, ingredients to tick off, numbered steps by section, then the rest",
    { positions: Object.fromEntries(order.map((o, i) => [o, positions[i]])), recipeBody },
  );
  check((await lastWebClipTarget(ids.owner, workspaceId)) === database.id, "the database is remembered as the person's last choice");
  check((await lastWebClipTarget(ids.member, workspaceId)) === null, "…for that person only");

  // The last choice, and a page under a page
  const again = await saveWebPage(owner, { workspaceId, url: `${SITE}/article`, locale: "en" });
  check(again.page.parentId === database.id && again.page.row, "with no place given, it goes where the person saved the last time");
  const under = await saveWebPage({ userId: ids.member }, { workspaceId, url: `${SITE}/r1`, targetId: shared.id, quote: "the harbour lights\ncame on", remember: true });
  const underBody = await body(under.page.id);
  check(
    under.page.parentId === shared.id && under.page.title === "Night Ferries of the North Sea" && hits.includes("/r1") && hits.includes("/r2"),
    "a member saves under a shared page, through two redirects",
    under.page,
  );
  check(
    underBody.startsWith(`[The Harbour Review](${SITE}/article)`) && /> the harbour lights\\?\n> came on/.test(underBody),
    "…linking to where the redirects led, with their selection as a quote",
    underBody.slice(0, 300),
  );
  await archivePage(ids.owner, database.id);
  check((await lastWebClipTarget(ids.owner, workspaceId)) === null, "a last choice that went to the trash is forgotten");

  // Pictures over the limits
  const gallery = await saveWebPage(owner, { workspaceId, url: `${SITE}/gallery`, targetId: shared.id });
  const galleryFiles = await filesOf(gallery.page.id);
  const reasons = gallery.warnings.flatMap((w) => (w.code === "fileNotStored" ? [`${w.path}:${w.reason}`] : [])).sort();
  check(
    galleryFiles.length === WEB_CLIP_LIMITS.images && gallery.warnings.some((w) => w.code === "tooManyImages" && w.count === 6 && w.limit === WEB_CLIP_LIMITS.images),
    `at most ${WEB_CLIP_LIMITS.images} pictures are copied; the rest are left out with a warning`,
    { files: galleryFiles.length, warnings: gallery.warnings },
  );
  check(!hits.includes("/img/huge.png") && !hits.includes("/img/missing.png"), "pictures past the limit aren't even fetched");
  check(reasons.length === 0, "the copied pictures had no trouble", reasons);

  // Pictures that aren't, or are too large, or are missing: with fewer pictures, so they get their turn
  WEB_CLIP_LIMITS.images = 30;
  const odds = await saveWebPage(owner, { workspaceId, url: `${SITE}/gallery`, targetId: shared.id });
  const oddReasons = odds.warnings.flatMap((w) => (w.code === "fileNotStored" ? [`${w.path}:${w.reason}`] : [])).sort();
  check(
    oddReasons.join() === "huge:tooLarge,missing:failed,not-a-picture:unsupportedType" && (await filesOf(odds.page.id)).length === GALLERY,
    "a picture too large, one that isn't a picture and one that isn't there are left out with a warning each",
    oddReasons,
  );
  WEB_CLIP_LIMITS.images = 20;

  // A long page
  const long = await saveWebPage(owner, { workspaceId, url: `${SITE}/long`, targetId: shared.id });
  const longBody = await body(long.page.id);
  check(long.page.title === "A very long page" && longBody.includes("the sea and its weather") && !longBody.includes("THE VERY END"), "a page past the size limit is read up to it");

  // Refusals: addresses
  const before = hits.length;
  const refusal = (url: string) => failure(() => saveWebPage(owner, { workspaceId, url, targetId: shared.id }));
  check((await refusal("http://10.0.0.1/")) === "blocked", "a private address is refused");
  check((await refusal("http://localhost/")) === "blocked", "a local host name is refused");
  check((await refusal(`http://127.0.0.1:${OTHER_PORT}/`)) === "blocked", "127.0.0.1 on a port that isn't allowed is refused");
  check((await refusal("https://example.com:6379/")) === "blocked", "a port web pages don't use is refused");
  check((await refusal("ftp://example.com/a")) === "invalidUrl" && (await refusal("not an address at all")) !== null, "what isn't a web address is refused");
  check(hits.length === before, "…none of them reached the site");
  check((await refusal(`${SITE}/to-private`)) === "blocked", "a redirect to a private address is refused");
  check((await refusal(`${SITE}/to-other-port`)) === "blocked", "a redirect to a port that isn't allowed is refused");
  check((await refusal(`${SITE}/file.pdf`)) === "notHtml", "a file that isn't a web page is refused");
  check((await refusal(`${SITE}/gone`)) === "httpError", "a page that answers with an error is refused");
  WEB_CLIP_LIMITS.pageTimeoutMs = 1_000;
  check((await refusal(`${SITE}/slow`)) === "timeout", "a site that takes too long is given up on");
  WEB_CLIP_LIMITS.pageTimeoutMs = 15_000;

  // Refusals: who may save where, checked before anything is fetched
  const beforeAccess = hits.length;
  const ownerPrivate = await createPage(owner, { workspaceId, title: "Owner's own", teamspaceId: null });
  check((await failure(() => saveWebPage({ userId: ids.outsider }, { workspaceId, url: `${SITE}/article`, targetId: null }))) === "access", "someone outside the workspace is refused");
  check((await failure(() => saveWebPage({ userId: ids.guest }, { workspaceId, url: `${SITE}/article`, targetId: null }))) === "access", "a guest may not save at the top");
  check((await failure(() => saveWebPage({ userId: ids.member }, { workspaceId, url: `${SITE}/article`, targetId: ownerPrivate.id }))) === "noAccess", "nor may a member save under a page they can't edit");
  check((await failure(() => saveWebPage(owner, { workspaceId, url: `${SITE}/article`, targetId: away.id }))) === "noAccess", "nor anyone into another workspace's page");
  check((await failure(() => saveWebPage(owner, { workspaceId, url: `${SITE}/article`, targetId: database.id }))) === "noAccess", "nor into a database in the trash");
  check(hits.length === beforeAccess, "…none of them fetched the page");

  // The REST API's operation
  const ctx = { userId: ids.member, actor: { userId: ids.member } };
  const viaApi = await ops.saveWebPage(ctx, { url: `${SITE}/recipe`, parent_id: shared.id });
  check(
    viaApi.parent_id === shared.id && viaApi.title === "Lentil Soup with Lemon" && viaApi.row === false && viaApi.pictures_copied === 1 && viaApi.source_url === `${SITE}/recipe` && viaApi.url.includes(viaApi.id),
    "the API's operation saves a page and says where",
    viaApi,
  );
  const top = await ops.saveWebPage(ctx, { url: `${SITE}/article`, workspace_id: workspaceId });
  check(top.parent_id === null && top.teamspace === "Private", "…at the top it is private to the user", top);
  const apiError = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (error) {
      const mapped = apiErrorFor(error);
      return `${mapped.status} ${mapped.code}`;
    }
  };
  check((await apiError(() => ops.saveWebPage(ctx, { url: "http://10.0.0.1/", workspace_id: workspaceId }))) === "400 invalid_request", "a refused address answers 400");
  check((await apiError(() => ops.saveWebPage(ctx, { url: `${SITE}/gone`, workspace_id: workspaceId }))) === "502 page_unreachable", "a site's error answers 502");
  check((await apiError(() => ops.saveWebPage(ctx, { url: `${SITE}/article`, parent_id: ownerPrivate.id }))) === "404 not_found", "a page the user can't open answers 404");

  console.log(`\n${passed} checks passed`);
} finally {
  // Rows written above have their access checked again in the background: let that finish first.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  await rm(uploadDir, { recursive: true, force: true });
  site.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
