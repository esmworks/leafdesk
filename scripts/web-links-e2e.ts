/**
 * End-to-end check of broken web links in the workspace check (server/web-links.ts) against the
 * database and a small web server of its own: the check asks about the addresses of page bodies and
 * URL properties, the job fetches each address once (HEAD, then GET where HEAD gets an error), 404
 * and 410 are broken at once while a server error must repeat, images, code and the app's own
 * addresses aren't checked, readers only hear of pages they can open, and addresses nobody asks
 * about are forgotten. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/web-links-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server on
 * the same database: a server's job would fetch the addresses first.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export {};

try {
  process.loadEnvFile();
} catch {}

const hits = new Map<string, number>();
const site = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  hits.set(path, (hits.get(path) ?? 0) + 1);
  const status: Record<string, number> = { "/ok": 200, "/missing": 404, "/gone": 410, "/down": 503, "/row-missing": 404, "/hidden-missing": 404 };
  res.statusCode = path === "/head-405" ? (req.method === "HEAD" ? 405 : 200) : (status[path] ?? 200);
  res.end();
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
// The checks fetch public addresses only; this test's server is let through like a host on your own network.
process.env.WEB_FETCH_ALLOWED_HOSTS = `127.0.0.1:${(site.address() as AddressInfo).port}`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { user, webLinkCheck, workspace, workspaceMember } = await import("@/db/schema");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const databases = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { checkWorkspace } = await import("@/server/workspace-check");
const { runWebLinkChecks } = await import("@/server/web-links");
const { env } = await import("@/lib/env");

const RUN = `weblinks-e2e-${Date.now().toString(36)}`;
const DAY = 24 * 60 * 60 * 1000;

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

/** Rounds of the job as of `now` until nothing is due. */
async function checkAll(now: Date) {
  let total = 0;
  for (let round = 0; round < 20; round++) {
    const { checked } = await runWebLinkChecks(now);
    if (!checked) break;
    total += checked;
  }
  return total;
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const workspaceId = `${RUN}-ws`;
const owner = { userId: ids.owner };
const start = new Date();

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);

  const links = await createPage(owner, { workspaceId, title: "Reading list" });
  const hidden = await createPage(owner, { workspaceId, title: "Private notes" });
  await setPagePermission(ids.owner, links.id, ids.member, "view");
  await setPagePermission(ids.owner, hidden.id, ids.owner, "full");
  await setPagePermission(ids.owner, hidden.id, null, "none");
  await getCollab().replaceContent(
    links.id,
    [
      `Read [this](${origin}/ok), [that](${origin}/missing#part) and ${origin}/gone.`,
      `Also [the status page](${origin}/down) and [a picky server](${origin}/head-405).`,
      `![a picture](${origin}/picture.png)`,
      "```",
      `curl ${origin}/in-code`,
      "```",
      `[Our own page](${env.appUrl}/w/${workspaceId}/p/${hidden.id})`,
    ].join("\n\n"),
    owner,
  );
  await getCollab().replaceContent(hidden.id, `Secret: [link](${origin}/hidden-missing)`, owner);
  const hiddenMissing = `${origin}/hidden-missing`;

  const bookmarks = await createPage(owner, { workspaceId, kind: "database", title: "Bookmarks" });
  await setPagePermission(ids.owner, bookmarks.id, ids.member, "view");
  await databases.addProperty(ids.owner, bookmarks.id, { name: "Link", type: "url" });
  const row = await createPage(owner, { workspaceId, parentId: bookmarks.id, title: "Old article", properties: { Link: `${origin}/row-missing` } });

  // ---- First check: everything waits for the job.
  const first = await checkWorkspace(ids.owner, workspaceId, { now: start });
  check(first.brokenWebLinks.status === "done", "web links are checked", first.brokenWebLinks);
  check(first.brokenWebLinks.total === 0 && first.brokenWebLinks.pending === first.brokenWebLinks.links, "…not fetched yet the first time", first.brokenWebLinks);
  const asked = (await db.select({ url: webLinkCheck.url }).from(webLinkCheck).where(eq(webLinkCheck.workspaceId, workspaceId))).map((r) => r.url).sort();
  const expected = ["/ok", "/missing", "/gone", "/down", "/head-405", "/row-missing", "/hidden-missing"].map((p) => `${origin}${p}`).sort();
  check(JSON.stringify(asked) === JSON.stringify(expected), "bodies' links, bare addresses and URL values are asked about; not images, code or the app's own pages", asked);

  // ---- The job fetches each address once.
  check((await checkAll(start)) === expected.length, "the job fetches every address", Object.fromEntries(hits));
  check(hits.get("/ok") === 1 && hits.get("/missing") === 2, "…once each (HEAD, and GET again only after an error)", Object.fromEntries(hits));
  check(hits.get("/head-405") === 2, "…GET where HEAD isn't allowed", Object.fromEntries(hits));
  check((await checkAll(start)) === 0, "…and not again until they are due");

  const second = await checkWorkspace(ids.owner, workspaceId, { now: start });
  check(second.brokenWebLinks.status === "done", "checked again");
  const found = second.brokenWebLinks.items.map((f) => [f.source.id, f.url.replace(origin, ""), f.reason, f.httpStatus, f.property?.name ?? null].join(" ")).sort();
  check(
    JSON.stringify(found) ===
      JSON.stringify(
        [
          `${links.id} /missing notFound 404 `,
          `${links.id} /gone gone 410 `,
          `${hidden.id} /hidden-missing notFound 404 `,
          `${row.id} /row-missing notFound 404 Link`,
        ].sort(),
      ),
    "404 and 410 are broken at once, in bodies and URL properties; a server error isn't yet",
    found,
  );
  check(second.brokenWebLinks.pending === 0, "…nothing waits any more", second.brokenWebLinks);

  const asMember = await checkWorkspace(ids.member, workspaceId, { now: start });
  check(
    asMember.brokenWebLinks.status === "done" && !asMember.brokenWebLinks.items.some((f) => f.url === hiddenMissing),
    "a member doesn't hear of links in a page they can't open",
    asMember.brokenWebLinks,
  );
  check(asMember.brokenWebLinks.status === "done" && asMember.brokenWebLinks.total === 3, "…the others are theirs too", asMember.brokenWebLinks);

  // ---- A site that keeps failing is listed after a few days.
  for (let day = 1; day <= 2; day++) await checkAll(new Date(start.getTime() + day * (DAY + 60_000)));
  const later = await checkWorkspace(ids.owner, workspaceId, { now: new Date(start.getTime() + 2 * DAY + 180_000) });
  const down = later.brokenWebLinks.status === "done" ? later.brokenWebLinks.items.find((f) => f.url.endsWith("/down")) : undefined;
  check(down?.reason === "serverError" && down.httpStatus === 503, "a server error three checks in a row is listed", later.brokenWebLinks);
  check(hits.get("/ok") === 1, "…while working addresses wait a week", Object.fromEntries(hits));

  // ---- Off, and forgetting.
  process.env.WEB_LINK_CHECKS = "off";
  const off = await checkWorkspace(ids.owner, workspaceId, { now: start });
  check(off.brokenWebLinks.status === "skipped", "WEB_LINK_CHECKS=off skips them", off.brokenWebLinks);
  check((await runWebLinkChecks(new Date(start.getTime() + 30 * DAY))).checked === 0, "…and the job fetches nothing");
  delete process.env.WEB_LINK_CHECKS;
  await runWebLinkChecks(new Date(start.getTime() + 70 * DAY));
  const kept = await db.select({ url: webLinkCheck.url }).from(webLinkCheck).where(eq(webLinkCheck.workspaceId, workspaceId));
  check(kept.length === 0, "addresses nobody asked about for two months are forgotten", kept);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  hocuspocus.closeConnections();
  site.close();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
