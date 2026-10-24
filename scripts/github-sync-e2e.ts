/**
 * End-to-end check of a database's GitHub setup against the database: who may set it up and what
 * it needs (an ID property with a prefix); signed pull request deliveries adding their link to the
 * rows they name and moving their status (drafts only linking, a done row moved back by nothing but
 * a merge); the same delivery taken once; bad signatures, unknown addresses and pings; writes made
 * as the person who saved it, with their access when the delivery comes (a row they can't edit is
 * skipped, losing the database stops it); the deliveries the dialog lists and the audit log.
 * Deliveries are handed to the route's handler directly, so no server is needed.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/github-sync-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { createHmac, randomUUID } = await import("node:crypto");
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, githubDelivery, githubSync, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, getProperties } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { AccessError } = await import("@/server/access");
const manage = await import("@/server/github-sync/manage");
const { receiveGithub } = await import("@/server/github-sync/receive");

const RUN = `github-e2e-${Date.now().toString(36)}`;

registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async disconnectLostAccess() {},
  async replaceContent() {},
  async setTitle() {},
} as unknown as Parameters<typeof registerCollab>[0]);

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

const failsWith = (promise: Promise<unknown>, test: (error: unknown) => boolean) =>
  promise.then(
    () => false,
    (error: unknown) => test(error),
  );

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest` };
const workspaceId = `${RUN}-ws`;

/** A delivery as GitHub sends it, signed with `secret`. */
function delivery(syncId: string, secret: string, payload: unknown, { event = "pull_request", id = randomUUID() as string }: { event?: string; id?: string } = {}) {
  const body = JSON.stringify(payload);
  return new Request(`http://127.0.0.1/api/github/${syncId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": id,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
}

let prNumber = 100;
/** A pull request event's payload. */
function pullRequest(action: string, pr: { title: string; body?: string; branch?: string; draft?: boolean; merged?: boolean; number?: number }) {
  const number = pr.number ?? ++prNumber;
  return {
    action,
    number,
    repository: { full_name: "acme/web" },
    pull_request: {
      number,
      html_url: `https://github.com/acme/web/pull/${number}`,
      title: pr.title,
      body: pr.body ?? null,
      draft: pr.draft ?? false,
      merged: pr.merged ?? false,
      head: { ref: pr.branch ?? "main" },
    },
  };
}

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
    { id: ids.guest, name: "Guest Gül", email: `${ids.guest}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const owner = { userId: ids.owner };
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: "Tasks", seedProperties: false });
  const status = await addProperty(ids.owner, tasks.id, { name: "Status", type: "status", options: ["Not started", "In review", "Done"] });
  const option = (name: string) => status.options.options!.find((o) => o.name === name)!.id;
  const [NOT_STARTED, IN_REVIEW, DONE] = [option("Not started"), option("In review"), option("Done")];

  // ------------------------------------------------------------------ setting up
  await setPagePermission(ids.owner, tasks.id, ids.guest, "edit");
  check(await failsWith(manage.getGithubSetup(ids.guest, tasks.id), (e) => e instanceof AccessError), "someone without full access can't see the setup");
  const before = await manage.getGithubSetup(ids.member, tasks.id);
  check(before.sync === null && before.uniqueId === null, "a database without an ID property has no setup and says so", before);
  check(
    await failsWith(manage.saveGithubSetup(ids.member, tasks.id, { newLinkProperty: "Pull requests" }), (e) => e instanceof manage.GithubSyncError && e.code === "noUniqueId"),
    "it can't be set up without an ID property",
  );
  const uid = await addProperty(ids.owner, tasks.id, { name: "ID", type: "unique_id", prefix: "TASK" });
  const row = async (title: string, value = "Not started") => createPage(owner, { workspaceId, parentId: tasks.id, title, properties: { Status: value } });
  const login = await row("Login page"); // TASK-1
  const signup = await row("Signup"); // TASK-2
  const shipped = await row("Shipped already", "Done"); // TASK-3
  const secret = await row("Kept from the member"); // TASK-4
  const number = async (id: string) => (await db.select({ p: page.properties }).from(page).where(eq(page.id, id)))[0].p[uid.id];
  check((await number(login.id)) === 1 && (await number(secret.id)) === 4, "rows are numbered TASK-1 to TASK-4");

  check(
    await failsWith(
      manage.saveGithubSetup(ids.member, tasks.id, { linkPropertyId: status.id }),
      (e) => e instanceof manage.GithubSyncError && e.code === "invalidProperty",
    ),
    "links can't go to a status property",
  );
  const setUp = await manage.saveGithubSetup(ids.member, tasks.id, {
    newLinkProperty: "Pull requests",
    statusPropertyId: status.id,
    opened: IN_REVIEW,
    merged: DONE,
    closed: NOT_STARTED,
  });
  const sync = setUp.sync!;
  const links = (await getProperties(tasks.id)).find((p) => p.name === "Pull requests")!;
  check(
    links?.type === "text" &&
      sync.mapping.linkPropertyId === links.id &&
      sync.runAs?.id === ids.member &&
      sync.webhookUrl.endsWith(`/api/github/${sync.webhookUrl.split("/").pop()}`) &&
      typeof sync.secret === "string" &&
      sync.secret.length >= 30,
    "a member with full access sets it up: a new text property for links, an address and a secret, run as them",
    sync,
  );
  const syncId = sync.webhookUrl.split("/").pop()!;
  const [stored] = await db.select().from(githubSync).where(eq(githubSync.id, syncId));
  check(!stored.secret.includes(sync.secret!), "the secret is stored sealed");
  const send = (payload: unknown, options?: { event?: string; id?: string }, key = sync.secret!) => receiveGithub(syncId, delivery(syncId, key, payload, options));
  const values = async (id: string) => (await db.select({ p: page.properties }).from(page).where(eq(page.id, id)))[0].p;

  // ------------------------------------------------------------------ deliveries
  const ping = await send({ zen: "Keep it logically awesome.", hook_id: 1 }, { event: "ping" });
  check(ping.status === 200 && ping.body.ignored === true, "GitHub's ping is answered", ping);

  const unknown = await receiveGithub(randomUUID(), delivery(syncId, sync.secret!, pullRequest("opened", { title: "TASK-1" })));
  check(unknown.status === 404, "an unknown address is refused", unknown);
  const forged = await send(pullRequest("opened", { title: "TASK-1 forged" }), undefined, "not-the-secret");
  check(forged.status === 401 && !(await values(login.id))[links.id], "a delivery with a bad signature is refused and changes nothing", forged);

  const opened = pullRequest("opened", { title: "Fix the login form (task-1)", body: "Also touches TASK-2.\nNot TASK-22 or XTASK-3.", branch: "feature/TASK-9-login" });
  const first = await send(opened, { id: "delivery-1" });
  check(first.status === 200 && first.body.rows === 2, "an opened pull request updates the rows it names", first);
  check(
    (await values(login.id))[links.id] === opened.pull_request.html_url && (await values(login.id))[status.id] === IN_REVIEW && (await values(signup.id))[status.id] === IN_REVIEW,
    "…adding its link and moving them to In review (title, body and branch; any case; whole IDs only)",
    await values(login.id),
  );
  const again = await send(opened, { id: "delivery-1" });
  check(again.status === 200 && again.body.duplicate === true, "the same delivery sent again is taken once", again);
  const resent = await receiveGithub(syncId, delivery(syncId, sync.secret!, opened, { id: "delivery-1-copy" }));
  check(resent.body.ok === true, "…and the same body under another delivery id changes nothing more", resent);
  check((await values(login.id))[links.id] === opened.pull_request.html_url, "…so the link is there once", await values(login.id));

  const draft = pullRequest("opened", { title: "WIP TASK-1", draft: true });
  await send(draft);
  const loginNow = await values(login.id);
  check(
    loginNow[links.id] === `${opened.pull_request.html_url}\n${draft.pull_request.html_url}` && loginNow[status.id] === IN_REVIEW,
    "a draft adds its link on a line of its own and moves nothing",
    loginNow,
  );

  const reopenDone = await send(pullRequest("opened", { title: "Follow-up for TASK-3" }));
  check(
    (await values(shipped.id))[status.id] === DONE && reopenDone.body.rows === 1,
    "a row already done keeps its status when a pull request is opened (only the link is added)",
    await values(shipped.id),
  );
  await send(pullRequest("closed", { title: "Abandoned TASK-3", merged: false }));
  check((await values(shipped.id))[status.id] === DONE, "…or closed without merging");

  await send(pullRequest("closed", { title: "Fix the login form (task-1)", number: opened.number, merged: true }));
  check((await values(login.id))[status.id] === DONE, "a merged pull request moves its rows to Done");
  await send(pullRequest("closed", { title: "Revert TASK-1", merged: false }));
  check((await values(login.id))[status.id] === DONE, "…and a pull request closed later doesn't move them back");

  await send(pullRequest("closed", { title: "Drop TASK-2", merged: false }));
  check((await values(signup.id))[status.id] === NOT_STARTED, "a pull request closed without merging moves an open row as set up");
  const sync2 = await send(pullRequest("synchronize", { title: "TASK-2" }));
  check(sync2.body.ignored === true, "pushes to a pull request (synchronize) are ignored", sync2);

  // ------------------------------------------------------------------ access when it runs
  // Members have full access unless a page says otherwise: this row lets the member only read it.
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");
  await setPagePermission(ids.owner, secret.id, ids.member, "view");
  const skipped = await send(pullRequest("opened", { title: "TASK-4 and TASK-2 and TASK-99" }));
  const [latest] = (await manage.getGithubSetup(ids.member, tasks.id)).sync!.deliveries;
  check(
    skipped.body.rows === 1 &&
      !(await values(secret.id))[links.id] &&
      JSON.stringify(latest.rows) === JSON.stringify([{ id: "TASK-4", outcome: "noAccess" }, { id: "TASK-2", outcome: "updated" }, { id: "TASK-99", outcome: "notFound" }]),
    "a row the person who set it up can't edit is skipped, one that isn't there is noted",
    latest,
  );
  check(latest.pullRequest?.repo === "acme/web" && latest.status === "done", "the deliveries list shows the pull request and how it went", latest);

  await setPagePermission(ids.owner, tasks.id, ids.owner, "full");
  await setPagePermission(ids.owner, tasks.id, null, "none");
  await setPagePermission(ids.owner, tasks.id, ids.member, "view");
  const signupLinks = (await values(signup.id))[links.id];
  const lost = await send(pullRequest("opened", { title: "TASK-2 again" }));
  const [lostView] = await db.select().from(githubDelivery).where(eq(githubDelivery.syncId, syncId)).orderBy(githubDelivery.receivedAt).then((r) => r.slice(-1));
  check(lost.body.ok === false && lostView.error === "accessLost" && (await values(signup.id))[links.id] === signupLinks, "once they can't edit the database, deliveries change nothing", {
    lost,
    lostView,
  });
  await setPagePermission(ids.owner, tasks.id, ids.member, "full");

  // ------------------------------------------------------------------ changing, new secret, removing
  const rotated = await manage.rotateGithubSecret(ids.owner, tasks.id);
  check(rotated.sync!.secret !== sync.secret && rotated.sync!.runAs?.id === ids.owner, "a new secret replaces the old one; whoever made it is who it runs as from then on");
  const old = await send(pullRequest("opened", { title: "TASK-2" }));
  check(old.status === 401, "deliveries signed with the old secret are refused", old);
  const resaved = await manage.saveGithubSetup(ids.member, tasks.id, { linkPropertyId: links.id, statusPropertyId: null });
  check(resaved.sync!.runAs?.id === ids.member && resaved.sync!.mapping.statusPropertyId === null, "saving it again makes it run as whoever saved it");
  const list = (await manage.getGithubSetup(ids.owner, tasks.id)).sync!.deliveries;
  check(list.length >= 10 && list[0].at >= list.at(-1)!.at, "the deliveries are listed newest first", list.length);

  await manage.removeGithubSetup(ids.owner, tasks.id);
  const removed = await receiveGithub(syncId, delivery(syncId, rotated.sync!.secret!, pullRequest("opened", { title: "TASK-2" })));
  check(removed.status === 404 && (await manage.getGithubSetup(ids.owner, tasks.id)).sync === null, "once removed, its address is refused");
  check((await db.select().from(githubDelivery).where(eq(githubDelivery.syncId, syncId))).length === 0, "…and its deliveries are gone");

  const audit = (await db.select({ action: auditEvent.action }).from(auditEvent).where(eq(auditEvent.workspaceId, workspaceId))).map((a) => a.action);
  check(
    audit.filter((a) => a === "github_sync.created").length === 1 && audit.filter((a) => a === "github_sync.updated").length === 2 && audit.includes("github_sync.deleted"),
    "setting up, changing and removing are in the audit log",
    audit,
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
