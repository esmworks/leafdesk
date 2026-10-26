/**
 * End-to-end check of related pages (server/related-pages.ts) against the database, with a fake
 * embeddings server: pages close in meaning are offered, best first, from the index alone (no
 * embedding is asked for); pages already linked either way, the page's parent and its subpages are
 * left out, and so are pages the reader can't open, pages in the trash and templates; nothing is
 * offered with AI off, without an embeddings model or before the page is indexed. Creates its own
 * users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/related-pages-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { relatedPages } = await import("@/server/related-pages");
const { AccessError } = await import("@/server/access");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi } = await import("@/server/ai/fake-openai");
const index = await import("@/server/semantic-index");

const RUN = `related-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
const EMBEDDINGS = { AI_EMBEDDINGS_MODEL: "fake-embed", AI_EMBEDDINGS_BASE_URL: fake.baseUrl, AI_EMBEDDINGS_API_KEY: "local-test" };

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

async function settle(timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (index.indexBusy() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  await index.whenIndexIdle();
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const owner = { userId: ids.owner };
const link = (pageId: string) => `[x](/w/${workspaceId}/p/${pageId})`;
const FLEET = "Our car budget for the fleet: money for vehicles, fuel and repairs this year.";

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);

  const budget = await createPage(owner, { workspaceId, title: "Fleet budget" });
  const spending = await createPage(owner, { workspaceId, title: "Vehicle spending" });
  const costs = await createPage(owner, { workspaceId, title: "Fleet costs" });
  const linked = await createPage(owner, { workspaceId, title: "Fleet plan" });
  const linking = await createPage(owner, { workspaceId, title: "Fleet review" });
  const child = await createPage(owner, { workspaceId, parentId: budget.id, title: "Fleet budget details" });
  const secret = await createPage(owner, { workspaceId, title: "Fleet numbers" });
  const trashed = await createPage(owner, { workspaceId, title: "Old fleet budget" });
  const template = await createPage(owner, { workspaceId, title: "Fleet template" });
  const recipes = await createPage(owner, { workspaceId, title: "Recipes" });
  const fresh = await createPage(owner, { workspaceId, title: "Not indexed yet" });
  for (const p of [budget, spending, costs, linked, linking, child, trashed, template, recipes, fresh]) {
    await setPagePermission(ids.owner, p.id, ids.member, "view");
  }
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");

  await getCollab().replaceContent(budget.id, `${FLEET}\n\nSee ${link(linked.id)}.`, owner);
  await getCollab().replaceContent(spending.id, "The automobile spending of the fleet: cash for cars, fuel and repairs this year.", owner);
  await getCollab().replaceContent(costs.id, "Fleet costs: vehicles, fuel and repairs.", owner);
  await getCollab().replaceContent(linked.id, FLEET, owner);
  await getCollab().replaceContent(linking.id, `${FLEET}\n\nFrom ${link(budget.id)}.`, owner);
  await getCollab().replaceContent(child.id, FLEET, owner);
  await getCollab().replaceContent(secret.id, FLEET, owner);
  await getCollab().replaceContent(trashed.id, FLEET, owner);
  await getCollab().replaceContent(template.id, FLEET, owner);
  await getCollab().replaceContent(recipes.id, "Bake the bread at two hundred degrees with olive oil and rosemary.", owner);
  await getCollab().replaceContent(fresh.id, FLEET, owner);
  await db.update(page).set({ inTemplate: true }).where(eq(page.id, template.id));

  // ---- Without an embeddings model, nothing.
  setAiEnv({});
  check((await relatedPages(ids.owner, budget.id)).length === 0, "without an embeddings model nothing is offered");

  setAiEnv(EMBEDDINGS);
  await settle();
  for (const p of [budget, spending, costs, linked, linking, child, secret, trashed, template, recipes]) await index.indexPage(p.id);
  await archivePage(ids.owner, trashed.id);
  const embedded = fake.embedded.length;

  const forOwner = await relatedPages(ids.owner, budget.id);
  const ownerIds = forOwner.map((p) => p.id);
  check(ownerIds.includes(spending.id) && ownerIds.includes(costs.id), "pages close in meaning are offered", forOwner);
  check(ownerIds.includes(secret.id), "…the owner's own private page too", forOwner);
  check(
    ![budget.id, linked.id, linking.id, child.id, trashed.id, template.id, recipes.id].some((id) => ownerIds.includes(id)),
    "…not the page itself, pages linked either way, its subpages, the trash, templates or unrelated pages",
    forOwner,
  );
  check(forOwner.every((p, i) => i === 0 || forOwner[i - 1].score >= p.score), "…best first", forOwner);
  check(forOwner.find((p) => p.id === spending.id)?.passage.includes("automobile"), "…with the passage closest to the page", forOwner);
  check(fake.embedded.length === embedded, "…from the index alone: nothing is embedded for it", fake.embedded.slice(embedded));
  check(
    !(await relatedPages(ids.owner, child.id)).some((p) => p.id === budget.id),
    "a subpage isn't offered its parent",
  );

  const forMember = await relatedPages(ids.member, budget.id);
  check(!forMember.some((p) => p.id === secret.id), "a member isn't offered a page they can't open", forMember);
  check(forMember.some((p) => p.id === spending.id), "…the others are theirs too", forMember);

  check((await relatedPages(ids.owner, fresh.id)).length === 0, "a page not indexed yet has none");

  let refused = false;
  try {
    await relatedPages(ids.outsider, budget.id);
  } catch (error) {
    refused = error instanceof AccessError;
  }
  check(refused, "someone who can't open the page is refused");

  await updateWorkspaceSettings(ids.owner, workspaceId, { ai: false });
  check((await relatedPages(ids.owner, budget.id)).length === 0, "with AI off in the workspace, nothing is offered");

  console.log(`\n${passed} checks passed`);
} finally {
  await settle().catch(() => {});
  setAiEnv({});
  await fake.close();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
