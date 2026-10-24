/**
 * End-to-end check of workspace sites and "Duplicate" on published pages: setting up a site (slug
 * rules, owners only, home page among published pages), which publications it lists and serves
 * (never unlisted ones or pages the publisher can't see), its navigation and links, search-engine
 * settings carried over, the home page falling back, the site's own domain, theme, header links,
 * search descriptions and analytics ID (loaded only on the site's own domain), and duplicating a published page into another workspace
 * (only when allowed, only what is published, files copied, no people or private properties, rate
 * limited). With APP_URL set, also checks the public routes over HTTP: the site on its own domain
 * (and nothing else there), its metadata, favicon and Content-Security-Policy.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/site-e2e.ts
 *   APP_URL=http://localhost:4200 pnpm tsx scripts/site-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

const appUrl = process.env.APP_URL;
try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { Readable } = await import("node:stream");
const http = await import("node:http");
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseProperty, databaseView, file, fileReference, page, pagePermission, pagePublication, user, workspace, workspaceMember, workspaceSite } =
  await import("@/db/schema");
const { addProperty, addView, createRows, getDatabaseSnapshot } = await import("@/server/databases");
const publication = await import("@/server/publication");
const site = await import("@/server/site");
const dup = await import("@/server/published-duplicate");
const { createPage, archivePage, setPageIcon } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { storeFile } = await import("@/server/files");
const { instanceStorage } = await import("@/server/storage");
const { AccessError } = await import("@/server/access");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { pageSegment } = await import("@/lib/site");

const RUN = `site-e2e-${Date.now().toString(36)}`;
const SLUG = `e2e-${Date.now().toString(36)}`;
const DOMAIN = `${SLUG}.example.net`;
const GA = "G-E2E1234567";

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

/** "access", the error's code, or null when `fn` succeeds. */
async function failure(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof AccessError && !(error as { code?: string }).code) return "access";
    const code = (error as { code?: string }).code;
    if (code) return code;
    throw error;
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, visitor: `${RUN}-visitor` };
const userIds = Object.values(ids);
const names = { [ids.owner]: "Olivia Owner", [ids.member]: "Mert Member", [ids.visitor]: "Veli Visitor" };
const source = `${RUN}-ws`;
const target = `${RUN}-ws2`;
const owner = { userId: ids.owner };
const member = { userId: ids.member };
const visitor = { userId: ids.visitor };
const mention = (props: Record<string, string>) => ({
  type: "mention",
  props: { kind: "page", id: "", userId: "", name: "", pageId: "", date: "", remindAt: "", ...props },
});

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: names[id], email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: source, name: "Acme Docs" },
    { id: target, name: `${RUN}-visitor` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: source, userId: ids.owner, role: "owner" },
    { workspaceId: source, userId: ids.member, role: "member" },
    { workspaceId: target, userId: ids.visitor, role: "owner" },
  ]);

  // Source workspace: Home, Guide (Chapter, Tasks database, a Secret page), and a link-only page.
  const home = await createPage(owner, { workspaceId: source, title: "Home" });
  const guide = await createPage(owner, { workspaceId: source, title: "Guide" });
  const chapter = await createPage(owner, { workspaceId: source, parentId: guide.id, title: "Chapter One" });
  const deep = await createPage(owner, { workspaceId: source, parentId: chapter.id, title: "Deep" });
  const tasks = await createPage(owner, { workspaceId: source, parentId: guide.id, kind: "database", title: "Tasks" });
  const secret = await createPage(member, { workspaceId: source, parentId: guide.id, title: "Secret" });
  await setPagePermission(ids.member, secret.id, ids.member, "full");
  await setPagePermission(ids.member, secret.id, null, "none");
  const binned = await createPage(owner, { workspaceId: source, parentId: guide.id, title: "Binned" });
  await archivePage(ids.owner, binned.id);
  const linkOnly = await createPage(owner, { workspaceId: source, title: "Link only" });
  const unpublished = await createPage(owner, { workspaceId: source, title: "Not published" });

  const who = await addProperty(ids.owner, tasks.id, { name: "Who", type: "person" });
  const size = await addProperty(ids.owner, tasks.id, { name: "Size", type: "select", options: ["S", "L"] });
  const notes = await addProperty(ids.owner, tasks.id, { name: "Notes", type: "text" });
  const [table] = (await getDatabaseSnapshot(ids.owner, tasks.id)).views;
  const hiddenView = await addView(ids.owner, tasks.id, { name: "Only mine", type: "list" });
  const sizeOption = (await getDatabaseSnapshot(ids.owner, tasks.id)).properties.find((p) => p.id === size.id)!.options.options![0];
  const rows = await createRows(ids.owner, tasks.id, [
    { title: "Write intro", properties: { [who.id]: [ids.owner], [size.id]: sizeOption.id, [notes.id]: "n1" } },
    { title: "Review", properties: { [notes.id]: "n2" } },
  ]);

  // Chapter's body: a person, pages inside and outside what gets copied, an uploaded image.
  const image = await storeFile(
    { workspaceId: source, pageId: chapter.id, uploadedBy: ids.owner },
    { name: "pic.png", contentType: "image/png", body: Readable.from(Buffer.from("not really a png")) },
  );
  await getCollab().appendBlocks(
    chapter.id,
    [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Ask ", styles: {} },
          mention({ kind: "user", userId: ids.owner, name: names[ids.owner], id: "m1" }),
          { type: "text", text: " about ", styles: {} },
          mention({ pageId: deep.id }),
          { type: "text", text: ", ", styles: {} },
          mention({ pageId: home.id }),
          { type: "text", text: " and ", styles: {} },
          mention({ pageId: guide.id }),
        ],
      },
      { type: "image", props: { url: image.url, caption: "" } },
    ],
    owner,
  );

  const homePub = await publication.publishPage(ids.owner, home.id);
  const guidePub = await publication.publishPage(ids.owner, guide.id);
  const linkPub = await publication.publishPage(ids.owner, linkOnly.id);
  await publication.setWebViews(ids.owner, tasks.id, [table.id]);

  // ---------------------------------------------------------------------------------------------
  // Setting up the site
  check((await site.getSite(ids.member, source)) === null, "a workspace starts without a site");
  check((await failure(() => site.saveSite(ids.member, source, { slug: SLUG, title: "Acme", homePageId: null }))) === "access", "members can't set up the site");
  for (const [slug, code] of [
    ["ab", "tooShort"],
    ["Acme Docs", "invalid"],
    ["acme--docs", "invalid"],
    ["api", "reserved"],
    ["x".repeat(41), "tooLong"],
  ] as const) {
    check((await failure(() => site.saveSite(ids.owner, source, { slug, title: "", homePageId: null }))) === code, `"${slug}" is refused (${code})`);
  }
  check(
    (await failure(() => site.saveSite(ids.owner, source, { slug: SLUG, title: "Acme", homePageId: unpublished.id }))) === "homeNotPublished",
    "the home page must be published",
  );
  const saved = await site.saveSite(ids.owner, source, { slug: SLUG.toUpperCase(), title: "Acme Docs", homePageId: home.id });
  check(saved.slug === SLUG && saved.url === `/s/${SLUG}`, "the owner sets up the site; the slug is stored lowercased", saved);
  check((await publication.getPublication(ids.owner, home.id))?.inSite === true, "the home page is listed in the site");
  check((await site.getSite(ids.member, source))?.slug === SLUG, "members see the site's address");
  check(
    (await failure(() => site.saveSite(ids.visitor, target, { slug: SLUG, title: "", homePageId: null }))) === "slugTaken",
    "another workspace can't take the same slug",
  );

  // ---------------------------------------------------------------------------------------------
  // What the site lists and serves
  let ctx = (await site.loadSite(SLUG))!;
  check(ctx.homeId === home.id && ctx.nav.map((n) => n.id).join() === home.id, "only the listed home page is in the navigation at first", ctx.nav);
  check((await site.getSitePage(ctx, guide.id)) === null, "unlisted publications aren't served by the site");
  await publication.updatePublication(ids.owner, guide.id, { inSite: true });
  check((await failure(() => site.setSiteListing(ids.member, source, linkOnly.id, true))) === "access", "only owners list pages from Settings");
  ctx = (await site.loadSite(SLUG))!;
  check(ctx.nav.map((n) => n.title).join() === "Home,Guide", "the home page comes first, then listed pages by title", ctx.nav.map((n) => n.title));
  const guideNav = ctx.nav.find((n) => n.id === guide.id)!;
  const navIds = JSON.stringify(ctx.nav);
  check(
    guideNav.children.map((c) => c.title).sort().join() === "Chapter One,Tasks",
    "a listed page shows its live subpages the publisher can see (no restricted or binned pages)",
    guideNav.children,
  );
  check(!navIds.includes(secret.id) && !navIds.includes(binned.id) && !navIds.includes(linkOnly.id), "no hidden, trashed or unlisted pages in the navigation");
  check(!navIds.includes(rows[0].id), "database rows stay out of the navigation");
  check(guideNav.children.find((c) => c.id === chapter.id)?.children[0]?.id === deep.id, "deeper subpages nest under their parent");
  check(guideNav.href === `/s/${SLUG}/${pageSegment(guide.id, "Guide")}`, "site pages have readable addresses", guideNav.href);

  const homePage = (await site.getSitePage(ctx))!;
  check(homePage.data.id === home.id && homePage.data.links.base === `/s/${SLUG}`, "the site's address opens the home page");
  const chapterPage = (await site.getSitePage(ctx, chapter.id))!;
  check(chapterPage.data.crumbs.map((c) => c.title).join(" / ") === "Guide / Chapter One", "site pages have breadcrumbs from their listed page");
  const html = chapterPage.data.body.filter((b) => b.kind === "html").map((b) => (b as { html: string }).html).join("");
  check(html.includes(`href="/s/${SLUG}"`), "a mention of another listed page links to its site address", html);
  check(html.includes(`/s/${SLUG}/${pageSegment(guide.id, "Guide")}`), "a mention of a page in the same publication links into the site");
  check(!html.includes(guidePub.token) && !html.includes(homePub.token), "site pages don't give away publication tokens");
  check((await site.getSitePage(ctx, secret.id)) === null, "a page restricted from the publisher isn't served");
  check((await site.getSitePage(ctx, binned.id)) === null, "a page in the trash isn't served");
  check((await site.getSitePage(ctx, linkOnly.id)) === null, "a link-only publication isn't served by the site");
  check((await site.getSitePage(ctx, rows[0].id))?.data.row !== null, "database rows are served under their listed page");
  check((await publication.getPublishedPage(linkPub.token))?.id === linkOnly.id, "publication links keep working");
  check(!JSON.stringify(ctx).includes("example.test") && !JSON.stringify(ctx).includes(names[ids.owner]), "the site names no member");

  // Search engines follow each publication
  check(chapterPage.data.indexable === false, "site pages stay out of search engines by default");
  await publication.updatePublication(ids.owner, guide.id, { indexable: true });
  ctx = (await site.loadSite(SLUG))!;
  check((await site.getSitePage(ctx, chapter.id))!.data.indexable, "…and follow their publication's setting");
  check(!(await site.getSitePage(ctx))!.data.indexable, "…per publication");

  // ---------------------------------------------------------------------------------------------
  // Own domain, theme, header links, search descriptions, analytics
  const options = (patch: Parameters<typeof site.updateSiteOptions>[2], userId = ids.owner, ws = source) =>
    site.updateSiteOptions(userId, ws, patch);
  check((await failure(() => options({ theme: "dark" }, ids.member))) === "access", "members can't change the site's options");
  check((await failure(() => options({ domain: "docs.example.com" }, ids.visitor, target))) === "noSite", "options need a site");
  for (const [domain, code] of [
    ["not a domain", "domainInvalid"],
    ["127.0.0.1", "domainInvalid"],
    ["intranet", "domainInvalid"],
    ["docs.example.com/path", "domainInvalid"],
    [new URL(process.env.APP_URL ?? "http://localhost:3000").hostname, "domainReserved"],
  ] as const) {
    const got = await failure(() => options({ domain }));
    check(got === code || (code === "domainReserved" && got === "domainInvalid"), `the domain "${domain}" is refused (${got})`);
  }
  check((await failure(() => options({ theme: "sepia" as never }))) === "themeInvalid", "the theme is light, dark or system");
  check((await failure(() => options({ analyticsId: "UA-1234-1" }))) === "analyticsInvalid", "only Google Analytics 4 measurement IDs");
  check((await failure(() => options({ headerLinks: [{ label: "x", url: "javascript:alert(1)" }] }))) === "linksInvalid", "header links can't run script");
  check((await failure(() => options({ headerLinks: [{ label: "Theirs", pageId: `${RUN}-nope` }] }))) === "linksInvalid", "header links lead to pages of the workspace");
  await setPageIcon(ids.owner, home.id, "📘");
  const withOptions = await options({
    domain: `https://${DOMAIN.toUpperCase()}/`,
    theme: "dark",
    description: "  Acme's docs:\n how things work.  ",
    analyticsId: GA.toLowerCase(),
    headerLinks: [
      { label: "Guide", pageId: guide.id },
      { label: "Hidden", pageId: linkOnly.id },
      { label: "Status", url: "https://status.example.com" },
    ],
  });
  check(withOptions.domain === DOMAIN && withOptions.analyticsId === GA, "the domain is stored as a host name, the ID uppercased", withOptions);
  check(withOptions.description === "Acme's docs: how things work.", "the description is kept to one paragraph");
  await site.saveSite(ids.visitor, target, { slug: `${SLUG}-b`, title: "", homePageId: null });
  check((await failure(() => options({ domain: DOMAIN }, ids.visitor, target))) === "domainTaken", "another site can't take the same domain");
  ctx = (await site.loadSite(SLUG))!;
  check(ctx.links.base === `/s/${SLUG}` && !ctx.onDomain && ctx.domain === DOMAIN && ctx.theme === "dark", "at the app's address the site keeps its /s/ links");
  check(
    ctx.headerLinks.map((l) => `${l.label}=${l.href}`).join() === `Guide=/s/${SLUG}/${pageSegment(guide.id, "Guide")},Status=https://status.example.com`,
    "header links lead to the site's pages, leave out pages it doesn't serve, and keep web addresses",
    ctx.headerLinks,
  );
  check(ctx.homeIcon === "📘" && ctx.analyticsId === GA, "the site knows its home page's icon and analytics ID");
  const onDomain = (await site.loadSite(SLUG, { onDomain: true }))!;
  check(onDomain.links.base === "" && onDomain.onDomain, "on its own domain the site links at the root");
  check(
    onDomain.nav.find((n) => n.id === guide.id)?.href === `/${pageSegment(guide.id, "Guide")}` && onDomain.headerLinks[0].href === `/${pageSegment(guide.id, "Guide")}`,
    "navigation and header links have root addresses there",
  );
  const onDomainChapter = (await site.getSitePage(onDomain, chapter.id))!;
  const domainHtml = onDomainChapter.data.body.filter((b) => b.kind === "html").map((b) => (b as { html: string }).html).join("");
  check(domainHtml.includes(`href="/${pageSegment(guide.id, "Guide")}"`) && !domainHtml.includes(`/s/${SLUG}`), "links in page bodies stay on the domain", domainHtml);
  check((await site.siteForPage(ids.owner, guide.id))?.pageUrl === `https://${DOMAIN}/${pageSegment(guide.id, "Guide")}`, "the Publish tab gives the page's address on the domain");

  await publication.updatePublication(ids.owner, guide.id, { description: "The guide,\n\tstep by step." });
  check((await publication.getPublication(ids.owner, guide.id))?.description === "The guide, step by step.", "a publication keeps its own search description");
  check((await failure(() => publication.updatePublication(ids.visitor, guide.id, { description: "x" }))) === "access", "only people who may publish the page change it");
  check((await site.getSitePage(ctx, guide.id))!.data.description === "The guide, step by step.", "the published page carries its description");
  check((await site.getSitePage(ctx, chapter.id))!.data.description === "", "…its subpages fall back to the site's");

  // A listed page under another listed page shows under it
  await publication.publishPage(ids.owner, chapter.id);
  await publication.updatePublication(ids.owner, chapter.id, { inSite: true });
  ctx = (await site.loadSite(SLUG))!;
  check(ctx.nav.map((n) => n.id).join() === [home.id, guide.id].join(), "a listed page under another listed page isn't repeated at the top");
  check((await site.getSitePage(ctx, chapter.id))!.data.crumbs[0].id === guide.id, "…and is served by the outer one");

  // The home page falls back when it goes offline
  await publication.unpublishPage(ids.owner, home.id);
  ctx = (await site.loadSite(SLUG))!;
  check(ctx.homeId === guide.id, "without its home page the site opens its first listed page");
  const again = await publication.publishPage(ids.owner, home.id);
  check(again.token !== homePub.token, "publishing again makes a new link");
  check((await site.loadSite(SLUG))!.homeId === guide.id, "a new publication isn't listed until someone lists it");
  await site.setSiteListing(ids.owner, source, home.id, true);
  check((await site.loadSite(SLUG))!.homeId === home.id, "listing it again brings the home page back");

  // ---------------------------------------------------------------------------------------------
  // Duplicate
  dup.resetDuplicateLimits();
  const byVisitor = (key: string, pageId: string | undefined, workspaceId = target, asTemplate = false) =>
    dup.duplicatePublishedPage(visitor, { key, pageId, workspaceId, asTemplate });
  check((await failure(() => byVisitor(SLUG, guide.id))) === "notAllowed", "duplicating is off by default");
  check(
    (await failure(() => publication.updatePublication(ids.visitor, guide.id, { allowDuplicate: true }))) === "access",
    "only people who may publish the page allow duplicating it",
  );
  await publication.updatePublication(ids.owner, guide.id, { allowDuplicate: true });
  check((await failure(() => byVisitor(SLUG, guide.id, source))) === "noAccess", "visitors can only copy into workspaces where they add pages");
  check((await failure(() => byVisitor(SLUG, secret.id))) === "notFound", "pages the publication doesn't serve can't be copied");
  check((await failure(() => byVisitor(linkPub.token, undefined))) === "notAllowed", "the setting is per publication");

  const copy = await byVisitor(SLUG, guide.id);
  check(copy.workspaceId === target, "the visitor copies the published page into their workspace");
  const copied = await db.select().from(page).where(eq(page.workspaceId, target));
  const byTitle = (title: string) => copied.filter((p) => p.title === title);
  const root = copied.find((p) => p.id === copy.pageId)!;
  check(root.parentId === null && root.title === "Guide" && !root.isTemplate, "the copy sits at the top of the workspace, as an ordinary page");
  check(
    ["Chapter One", "Deep", "Tasks", "Write intro", "Review"].every((t) => byTitle(t).length === 1) &&
      !byTitle("Secret").length &&
      !byTitle("Binned").length,
    "only what the publication shows is copied",
    copied.map((p) => p.title),
  );
  check(copied.every((p) => p.createdBy === ids.visitor), "the copies are the visitor's");
  const copiedTasks = byTitle("Tasks")[0];
  const copiedProps = await db.select().from(databaseProperty).where(eq(databaseProperty.databaseId, copiedTasks.id));
  check(!copiedProps.some((p) => p.type === "person") && copiedProps.some((p) => p.name === "Size"), "people properties stay behind", copiedProps.map((p) => p.name));
  const copiedRow = byTitle("Write intro")[0];
  check(!JSON.stringify(copiedRow.properties).includes(ids.owner), "no person's id reaches the copy", copiedRow.properties);
  check(Object.values(copiedRow.properties).includes("n1"), "published values come along");
  const copiedViews = await db.select().from(databaseView).where(eq(databaseView.databaseId, copiedTasks.id));
  check(copiedViews.map((v) => v.name).join() === table.name && !copiedViews.some((v) => v.name === hiddenView.name), "only the views on the web are copied", copiedViews);
  const perms = await db.select().from(pagePermission).where(inArray(pagePermission.pageId, copied.map((p) => p.id)));
  // The copy lands among the visitor's private pages (teamspaces, #36): the only entries are the
  // ones that make it theirs, none of the source workspace's.
  check(
    perms.every((p) => p.workspaceId === target && p.pageId === root.id && (p.userId === null ? p.level === "none" : p.userId === ids.visitor)) &&
      root.teamspaceId === null,
    "no permission entries of the source workspace come along: the copy is private to the visitor",
    perms,
  );

  const copiedChapter = byTitle("Chapter One")[0];
  check(!copiedChapter.contentMarkdown.includes(ids.owner) && copiedChapter.contentText.includes("@Olivia Owner"), "people mentions become their name", copiedChapter.contentMarkdown);
  const copiedDeep = byTitle("Deep")[0];
  check(copiedChapter.contentMarkdown.includes(`/w/${target}/p/${copiedDeep.id}`), "mentions of copied pages point at the copies", copiedChapter.contentMarkdown);
  check(copiedChapter.contentMarkdown.includes(`(/w/${target}/p/${copy.pageId})`), "…including the copied page itself");
  check(copiedChapter.contentMarkdown.includes(`/s/${SLUG}`) && !copiedChapter.contentMarkdown.includes(`/w/${source}/`), "pages that weren't copied link to their public address", copiedChapter.contentMarkdown);
  const [copiedFile] = await db.select().from(file).where(eq(file.workspaceId, target));
  check(copiedFile && copiedFile.id !== image.id && copiedFile.size === image.size, "the image is copied into the visitor's workspace");
  check(copiedChapter.contentMarkdown.includes(`/api/files/${copiedFile.id}`) && !copiedChapter.contentMarkdown.includes(image.id), "the copy shows the copied file");
  const refs = await db.select().from(fileReference).where(eq(fileReference.fileId, copiedFile.id));
  check(refs.some((r) => r.pageId === copiedChapter.id), "the copied file counts as shown by the copy");
  const bytes = Buffer.from(await new Response(await instanceStorage().get(copiedFile.storageKey)).arrayBuffer()).toString();
  check(bytes === "not really a png", "the file's bytes were copied");

  const viaToken = await byVisitor(guidePub.token, chapter.id, target, true);
  const [template] = await db.select().from(page).where(eq(page.id, viaToken.pageId));
  check(template.isTemplate && template.inTemplate && template.title === "Chapter One", "a subpage can be copied by its publication link, as a template");

  dup.resetDuplicateLimits();
  const results: (string | null)[] = [];
  for (let i = 0; i < 6; i++) results.push(await failure(() => byVisitor(SLUG, deep.id)));
  check(results.slice(0, 5).every((r) => r === null) && results[5] === "rateLimited", "duplicating is rate limited per person", results);

  // ---------------------------------------------------------------------------------------------
  // Public routes, when a server is running
  if (appUrl) {
    const get = (path: string, init: RequestInit = {}) => fetch(new URL(path, appUrl), { redirect: "manual", ...init });
    const port = new URL(appUrl).port || "80";
    // fetch keeps its own Host header: these go to the server with the one a browser would send.
    const onHost = (host: string, path: string, method = "GET", headers: Record<string, string> = {}) =>
      new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host: `${host}:${port}`, ...headers } }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.end();
      });
    const res = await get(`/s/${SLUG}`);
    const body = await res.text();
    check(res.status === 200 && body.includes("Acme Docs") && body.includes("Chapter One"), "GET /s/<slug> shows the site with its navigation", res.status);
    check(/<meta name="robots" content="noindex, ?nofollow"/.test(body), "the home page stays out of search engines");
    check(!body.includes("example.test") && !body.includes(guidePub.token), "the site page shows no emails or tokens");
    const pretty = `/s/${SLUG}/${pageSegment(chapter.id, "Chapter One")}`;
    const chapterRes = await get(pretty);
    const chapterBody = await chapterRes.text();
    check(chapterRes.status === 200 && /<meta name="robots" content="index, ?follow"/.test(chapterBody), "a page of an indexable publication may be indexed");
    check(chapterBody.includes("Duplicate") || chapterBody.includes("Çoğalt"), "pages that allow it offer Duplicate");
    const old = await get(`/s/${SLUG}/old-title-${chapter.id}`);
    check(old.status === 307 && old.headers.get("location")?.endsWith(pretty), "an old address leads to the page's current one", old.headers.get("location"));
    check((await get(`/s/${SLUG}/${secret.id}`)).status === 404, "a hidden page is a 404 on the site");
    check((await get(`/s/${SLUG}/${linkOnly.id}`)).status === 404, "a link-only page is a 404 on the site");
    check((await get(`/s/${linkPub.token}`)).status === 200, "publication links still open");
    const signIn = await get(`/s/${SLUG}/duplicate?page=${chapter.id}`);
    check(
      signIn.status === 307 && decodeURIComponent(signIn.headers.get("location") ?? "").includes(`/sign-in?next=/s/${SLUG}/duplicate?page=${chapter.id}`),
      "Duplicate asks visitors to sign in and come back",
      signIn.headers.get("location"),
    );

    // The site on its own domain. The server reads sites' domains every few seconds.
    let root = await onHost(DOMAIN, "/");
    for (let i = 0; i < 40 && !root.body.includes("Acme Docs"); i++) {
      await new Promise((r) => setTimeout(r, 500));
      root = await onHost(DOMAIN, "/");
    }
    check(root.status === 200 && root.body.includes("Acme Docs"), "the domain's root is the site's home page", root.status);
    check(!root.headers["set-cookie"], "a site page on the domain sets no cookie", root.headers["set-cookie"]);
    const guideSegment = pageSegment(guide.id, "Guide");
    check(root.body.includes(`href="/${guideSegment}"`) && !root.body.includes(`href="/s/${SLUG}`), "its links stay on the domain");
    check(root.body.includes(`<link rel="canonical" href="https://${DOMAIN}/"`), "the canonical address is on the domain", /<link rel="canonical"[^>]*>/.exec(root.body)?.[0]);
    check(/<html[^>]*data-theme="dark"/.test(root.body), "the site's theme applies, whatever the visitor's cookie", /<html[^>]*>/.exec(root.body)?.[0]);
    check(
      root.body.includes('<meta name="description" content="Acme&#x27;s docs: how things work."') &&
        root.body.includes('<meta property="og:description" content="Acme&#x27;s docs: how things work."') &&
        root.body.includes('<meta name="twitter:card" content="summary"') &&
        root.body.includes('<meta property="og:site_name" content="Acme Docs"'),
      "pages without a description carry the site's, with Open Graph and Twitter tags",
      root.body.match(/<meta (name|property)="(description|og:[a-z_]+|twitter:[a-z]+)"[^>]*>/g),
    );
    check(/<title>📘 Home<\/title>/.test(root.body), "the home page's title doesn't end in the app's name", /<title>[^<]*<\/title>/.exec(root.body)?.[0]);
    const icon = /<link rel="icon" href="([^"]+)" type="image\/svg\+xml"/.exec(root.body)?.[1];
    check(icon?.startsWith("/favicon.svg?v=") && !root.body.includes('href="/icon.svg'), "the favicon is the home page's emoji", icon);
    const favicon = await onHost(DOMAIN, icon!.replace(/&amp;/g, "&"));
    check(favicon.status === 200 && String(favicon.headers["content-type"]).startsWith("image/svg+xml") && favicon.body.includes("📘"), "favicon.svg draws it");
    const csp = String(root.headers["content-security-policy"]);
    check(csp.includes("https://www.googletagmanager.com") && csp.includes("https://*.google-analytics.com"), "with an analytics ID the policy lets Google's tag in", csp);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    check(
      root.body.includes(`https://www.googletagmanager.com/gtag/js?id=${GA}`) && root.body.includes(`nonce="${nonce}"`) && root.body.includes(`gtag("config","${GA}")`),
      "the page loads Google's tag with the response's nonce",
    );
    const guideOnDomain = await onHost(DOMAIN, `/${guideSegment}`);
    check(
      guideOnDomain.status === 200 && guideOnDomain.body.includes('<meta name="description" content="The guide, step by step."'),
      "a page on the domain carries its own description",
    );
    check(guideOnDomain.body.includes('href="https://status.example.com"') && guideOnDomain.body.includes(">Status</a>"), "the header shows the site's links");
    check(!guideOnDomain.headers["set-cookie"] && !favicon.headers["set-cookie"], "…nor does any other page or its favicon");
    const imageOnDomain = await onHost(DOMAIN, `/api/files/${image.id}`);
    check(imageOnDomain.status === 200, "files the pages show load on the domain", imageOnDomain.status);
    const moved = await onHost(DOMAIN, `/s/${SLUG}/${guideSegment}`);
    check(moved.status === 308 && moved.headers.location === `/${guideSegment}`, "the app's site address leads to the root one there", moved.headers.location);
    const dupOnDomain = await onHost(DOMAIN, `/duplicate?page=${guide.id}`);
    check(dupOnDomain.status === 308 && dupOnDomain.headers.location === `${appUrl.replace(/\/$/, "")}/s/${SLUG}/duplicate?page=${guide.id}`, "Duplicate goes to the app's address", dupOnDomain.headers.location);
    for (const path of ["/w/x", "/sign-in", "/api/auth/get-session", "/api/v1/pages", "/mcp", "/sw.js", "/f/x", `/s/${linkPub.token}`, "/.well-known/oauth-authorization-server"]) {
      const res = await onHost(DOMAIN, path);
      check(res.status === 404 && !res.headers["set-cookie"], `${path} isn't served on the domain`, res.status);
    }
    const post = await onHost(DOMAIN, "/", "POST", { "content-type": "text/plain", "next-action": "x" });
    check(post.status === 404, "nothing is written through the domain (server actions included)", post.status);
    const socket = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/collab",
        headers: { host: DOMAIN, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
      });
      req.on("upgrade", (_res, s) => {
        s.destroy();
        resolve(101);
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.end();
    });
    check(socket === 404, "the collaboration socket isn't served on the domain", socket);

    const atApp = await get(`/s/${SLUG}`);
    const atAppBody = await atApp.text();
    check(atAppBody.includes(`<link rel="canonical" href="https://${DOMAIN}/"`), "at the app's address the canonical one is on the domain");
    const withoutNonce = (policy: string | null | undefined) => String(policy).replace(/'nonce-[^']+'/g, "'nonce'");
    const appPolicy = withoutNonce((await get("/sign-in")).headers.get("content-security-policy"));
    check(
      withoutNonce(atApp.headers.get("content-security-policy")) === appPolicy && !atAppBody.includes("googletagmanager") && !atAppBody.includes("gtag("),
      "at the app's address the site's pages never load Google's tag, and their policy is the app's",
      atApp.headers.get("content-security-policy"),
    );
    const atAppPage = await get(`/s/${SLUG}/${guideSegment}`, { headers: { "x-leafdesk-site-analytics": GA } });
    const atAppPageBody = await atAppPage.text();
    check(
      atAppPage.status === 200 && withoutNonce(atAppPage.headers.get("content-security-policy")) === appPolicy && !atAppPageBody.includes("googletagmanager"),
      "…not even when a client sends the analytics header",
    );
    const elsewhere = await onHost(`other-${DOMAIN}`, `/s/${SLUG}`);
    check(elsewhere.status === 200 && elsewhere.body.includes(`href="/s/${SLUG}/${guideSegment}"`), "an unknown host is served as before");
    const tokenPage = await get(`/s/${linkPub.token}`);
    check(!String(tokenPage.headers.get("content-security-policy")).includes("googletagmanager"), "other published pages' policy is unchanged");
    const signInPage = await get("/sign-in");
    check(!String(signInPage.headers.get("content-security-policy")).includes("googletagmanager"), "…and so is the app's");
    const spoofed = await onHost(`other-${DOMAIN}`, "/sign-in", "GET", { "x-leafdesk-site-host": SLUG, "x-leafdesk-site-analytics": GA });
    check(!String(spoofed.headers["content-security-policy"]).includes("googletagmanager") && !spoofed.body.includes("Acme Docs"), "clients can't send the server's site headers");
    await site.updateSiteOptions(ids.owner, source, { domain: null, analyticsId: null });
    let gone = await onHost(DOMAIN, "/");
    for (let i = 0; i < 40 && gone.body.includes("Acme Docs"); i++) {
      await new Promise((r) => setTimeout(r, 500));
      gone = await onHost(DOMAIN, "/");
    }
    check(!gone.body.includes("Acme Docs"), "taking the domain away stops serving the site there");
  } else {
    console.log("(APP_URL not set: skipping the HTTP checks)");
  }

  console.log(`\n${passed} checks passed`);
} finally {
  // Stored bytes don't go with the rows: remove them first.
  const stored = await db.select({ key: file.storageKey }).from(file).where(inArray(file.workspaceId, [source, target]));
  for (const { key } of stored) await instanceStorage().delete(key).catch(() => {});
  await db.delete(workspaceSite).where(and(eq(workspaceSite.workspaceId, source)));
  await db.delete(pagePublication).where(inArray(pagePublication.publishedBy, userIds));
  await db.delete(workspace).where(inArray(workspace.id, [source, target]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
