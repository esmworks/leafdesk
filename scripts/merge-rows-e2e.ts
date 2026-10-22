/**
 * End-to-end check of merging duplicate rows against the database: the kept row takes the values
 * picked for it (one row's, or every row's together); two-way links of other rows point at it, once,
 * and rollups over them count again; comments, activity, files, email, followers and page content
 * of the merged rows come along; they go to the trash pointing at the kept row, and links to them
 * count as links to it; restoring one doesn't undo the merge. Merges are refused without edit access
 * to every row, or to the rows whose links would change, and properties the person may not edit keep
 * the kept row's value. The same over MCP (merge_rows) and REST (POST /databases/{id}/rows/merge).
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/merge-rows-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: it runs the collab service in-process.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { file, oauthClient, page, rowActivity, rowEmail, rowFollower, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const databases = await import("@/server/databases");
const { createPage, listTrash, restorePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setPropertyAccess } = await import("@/server/property-access");
const { changeComments } = await import("@/server/comments");
const { listRowActivity } = await import("@/server/row-activity-feed");
const { countBacklinks, listBacklinks } = await import("@/server/mentions");
const { mergeCandidates, mergeRows, previewMerge } = await import("@/server/merge-rows");
const { createApiToken } = await import("@/server/api/tokens");
const { handleApiRequest } = await import("@/server/api");
const ops = await import("@/server/operations");
const { COMBINE, MERGE_TITLE } = await import("@/lib/merge-rows");
const { commentText } = await import("@/lib/comments");

const RUN = `merge-e2e-${Date.now().toString(36)}`;

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

/** The error code a call fails with, or "ok". */
async function failure(fn: () => Promise<unknown>) {
  try {
    await fn();
    return "ok";
  } catch (error) {
    const e = error as { code?: string; name?: string };
    return e.code ?? e.name ?? "error";
  }
}

const clientId = `${RUN}-client`;

/** Calls an MCP tool as `userId` through the test OAuth client, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId, scopes: [READ_SCOPE, WRITE_SCOPE] });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 2000; i++) {
      const hit = inbox.find((m) => m.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no MCP response for ${name}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "merge-rows-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

/** A REST call, handled in-process as the route handler does. */
async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await handleApiRequest(
    new Request(`http://localhost/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const owner = { userId: ids.owner };
const rowOf = async (id: string) => (await db.select().from(page).where(eq(page.id, id)))[0];
const linksOf = async (id: string, propertyId: string) => {
  const value = (await rowOf(id)).properties[propertyId];
  return Array.isArray(value) ? [...value].sort() : value;
};
const sorted = (values: string[]) => [...values].sort();

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id.split("-").at(-1)!, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  await db.insert(oauthClient).values({ id: clientId, clientId, name: "Test AI", redirectUris: [] });

  // Companies, with deals linking to them both ways, a count of those deals, and sub-items.
  const companies = await createPage(owner, { workspaceId, kind: "database", title: "Companies" });
  const deals = await createPage(owner, { workspaceId, kind: "database", title: "Deals" });
  const notes = await createPage(owner, { workspaceId, kind: "database", title: "Notes" });
  const phone = await databases.addProperty(ids.owner, companies.id, { name: "Phone", type: "text" });
  const size = await databases.addProperty(ids.owner, companies.id, { name: "Size", type: "number" });
  const secret = await databases.addProperty(ids.owner, companies.id, { name: "Rating", type: "number" });
  const tags = await databases.addProperty(ids.owner, companies.id, {
    name: "Labels",
    type: "multi_select",
    options: [{ name: "Lead" }, { name: "Partner" }, { name: "Vendor" }],
  });
  const [lead, partner, vendor] = tags.options.options!;
  const company = await databases.addProperty(ids.owner, deals.id, {
    name: "Company",
    type: "relation",
    relation: { databaseId: companies.id, twoWay: true, pairedName: "Deals" },
  });
  const dealsProp = (await databases.getProperties(companies.id)).find((p) => p.name === "Deals")!;
  check(dealsProp?.options.relation?.pairedPropertyId === company.id, "the deals' company relation shows back on companies");
  await databases.addProperty(ids.owner, companies.id, {
    name: "Deal count",
    type: "rollup",
    rollup: { relationPropertyId: dealsProp.id, targetPropertyId: "title", function: "count_all" },
  });
  // The member edits these databases; full access would see and change every property.
  for (const database of [companies, deals, notes]) {
    await setPagePermission(ids.owner, database.id, ids.owner, "full");
    await setPagePermission(ids.owner, database.id, null, "none");
    await setPagePermission(ids.owner, database.id, ids.member, "edit");
  }
  const about = await databases.addProperty(ids.owner, notes.id, { name: "About", type: "relation", relation: { databaseId: companies.id } });
  await databases.setSubItems(ids.owner, companies.id, { on: true });
  const parentProp = (await databases.getProperties(companies.id)).find((p) => p.options.relation?.role === "parent")!;

  const row = (title: string, properties: Record<string, unknown> = {}, parentId = companies.id) =>
    createPage(owner, { workspaceId, parentId, title, properties });
  const acme = await row("Acme", { [tags.id]: [lead.id], [secret.id]: 1 });
  await new Promise((r) => setTimeout(r, 20));
  const acme2 = await row("Acme Inc.", { [phone.id]: "+90 555 0101", [size.id]: 40, [tags.id]: [partner.id], [secret.id]: 9 });
  const acme3 = await row("ACME", { [tags.id]: [vendor.id, lead.id] });
  const d1 = await row("Deal 1", { [company.id]: [acme.id] }, deals.id);
  const d2 = await row("Deal 2", { [company.id]: [acme2.id] }, deals.id);
  const d3 = await row("Deal 3", { [company.id]: [acme2.id, acme3.id] }, deals.id);
  const n1 = await row("Call notes", { [about.id]: [acme3.id] }, notes.id);
  const child = await row("Acme Inc. Europe", { [parentProp.id]: [acme2.id] });
  check(sorted((await linksOf(acme2.id, dealsProp.id)) as string[]).join() === sorted([d2.id, d3.id]).join(), "the paired links are on the duplicates");

  // What the duplicates have of their own.
  await service.replaceContent(acme.id, "Our main account.", owner);
  await service.replaceContent(acme2.id, "Call back Tuesday about the renewal.\n\nThey use the Istanbul office.", owner);
  await changeComments(ids.owner, acme2.id, { type: "createThread", body: "Who owns this account?" });
  await changeComments(ids.owner, acme2.id, { type: "createThread", body: "Which renewal?", anchor: { quote: "Call back Tuesday" } });
  await databases.updateRowProperties(ids.owner, acme2.id, { [phone.id]: "+90 555 0102" });
  await db.insert(file).values({
    id: `${RUN}-file`,
    workspaceId,
    pageId: acme2.id,
    storageKey: `${workspaceId}/${RUN}-file`,
    name: "contract.pdf",
    contentType: "application/pdf",
    size: 10,
  });
  await db.insert(rowEmail).values({
    workspaceId,
    databaseId: companies.id,
    rowId: acme2.id,
    direction: "in",
    messageId: `<${RUN}@example.test>`,
    fromAddress: "sales@acme.example",
    subject: "Renewal",
    sentAt: new Date(),
    status: "received",
  });
  await db.insert(rowFollower).values({ rowId: acme3.id, userId: ids.member, following: true });
  const wiki = await createPage(owner, { workspaceId, title: "Accounts" });
  await service.replaceContent(wiki.id, `See [x](/w/${workspaceId}/p/${acme3.id}) and [y](/w/${workspaceId}/p/${acme.id}).`, owner);

  // ── The dialog's preview and "Merge with…" ────────────────────────────────────────────
  const preview = await previewMerge(ids.owner, [acme2.id, acme.id, acme3.id]);
  check(preview.rows[0].id === acme.id, "the preview lists the oldest row first", preview.rows.map((r) => r.title));
  const carried = preview.rows.find((r) => r.id === acme2.id)!.carries;
  check(carried.threads === 2 && carried.files === 1 && carried.emails === 1 && carried.body && carried.links === 3, "the preview says what a row brings along (two deals and a sub-item link to it)", carried);
  check(preview.defaults[acme.id][dealsProp.id] === COMBINE, "relations start out combined");
  check(preview.defaults[acme.id][phone.id] === acme2.id, "an empty value starts out taken from the first row that has one", preview.defaults[acme.id]);
  const candidates = await mergeCandidates(ids.owner, acme.id, "acme");
  check(
    sorted(candidates.map((c) => c.id)).join() === sorted([acme2.id, acme3.id, child.id]).join(),
    "\"Merge with…\" offers the other rows of the database whose title matches",
    candidates,
  );

  // ── Refused merges ────────────────────────────────────────────────────────────────────
  check((await failure(() => mergeRows(owner, { keptRowId: acme.id, otherRowIds: [] }))) === "mergeRowCount", "one row alone can't be merged");
  check((await failure(() => mergeRows(owner, { keptRowId: acme.id, otherRowIds: [d1.id] }))) === "mergeRowsInvalid", "rows of two databases can't be merged");
  // Everyone else can't open the row; the member gets the level given.
  const restrict = async (pageId: string, level: "view" | "edit") => {
    await setPagePermission(ids.owner, pageId, ids.owner, "full");
    await setPagePermission(ids.owner, pageId, null, "none");
    await setPagePermission(ids.owner, pageId, ids.member, level);
  };
  await restrict(acme3.id, "view");
  const readOnly = await failure(() => mergeRows({ userId: ids.member }, { keptRowId: acme.id, otherRowIds: [acme3.id] }));
  check(readOnly === "mergeRowsReadOnly", "a row the person may only view can't be merged", readOnly);
  await restrict(acme3.id, "edit");
  await restrict(d3.id, "view");
  const blocked = await mergeRows({ userId: ids.member }, { keptRowId: acme.id, otherRowIds: [acme3.id] }).catch((e) => e);
  check(blocked?.code === "mergeLinksBlocked" && String(blocked.params?.rows).includes("Deal 3"), "a merge is refused when it would change links the person can't edit, naming them", blocked);
  check(sorted((await linksOf(d3.id, company.id)) as string[]).join() === sorted([acme2.id, acme3.id]).join(), "…and changes nothing");
  await restrict(d3.id, "edit");

  // ── Over MCP, as the member: a dry run, then a property they may not edit ───────────────
  await setPropertyAccess(ids.owner, secret.id, { everyone: "view", exceptions: [] });
  const dry = await callTool(ids.member, "merge_rows", { kept_row_id: acme.id, other_row_ids: [acme2.id], dry_run: true });
  check(!dry.isError && dry.data.dry_run && dry.data.would_merge_row_ids[0] === acme2.id && dry.data.relinked_rows === 3, "merge_rows dry_run says what would happen (two deals and a sub-item relinked)", dry);
  check(!(await rowOf(acme2.id)).archivedAt, "…without merging");
  const bad = await callTool(ids.member, "merge_rows", { kept_row_id: acme.id, other_row_ids: [acme2.id], properties: { Phone: d1.id } });
  check(bad.isError && bad.text.includes("neither a row of this merge"), "merge_rows takes values only from the rows merged", bad.text);

  const viaMcp = await callTool(ids.member, "merge_rows", {
    kept_row_id: acme.id,
    other_row_ids: [acme2.id],
    properties: { Phone: acme2.id, Labels: COMBINE, Rating: acme2.id },
    title: acme2.id,
  });
  check(!viaMcp.isError && viaMcp.data.merged_row_ids[0] === acme2.id, "merge_rows merges", viaMcp.text);
  check(viaMcp.data.moved.comment_threads === 2 && viaMcp.data.moved.files === 1 && viaMcp.data.moved.emails === 1, "…and says what came along", viaMcp.data);

  // ── The kept row ──────────────────────────────────────────────────────────────────────
  let kept = await rowOf(acme.id);
  check(kept.title === "Acme Inc.", "the kept row takes the title picked", kept.title);
  check(kept.properties[phone.id] === "+90 555 0102" && kept.properties[size.id] === 40, "…the value picked, and one it had none of", kept.properties);
  check(sorted(kept.properties[tags.id] as string[]).join() === sorted([lead.id, partner.id]).join(), "…every row's labels together");
  check(kept.properties[secret.id] === 1, "a property the person may not edit keeps the kept row's value", kept.properties[secret.id]);
  check(sorted((await linksOf(acme.id, dealsProp.id)) as string[]).join() === sorted([d1.id, d2.id, d3.id]).join(), "the kept row has every deal");
  check(
    ((await linksOf(d2.id, company.id)) as string[]).join() === acme.id &&
      sorted((await linksOf(d3.id, company.id)) as string[]).join() === sorted([acme.id, acme3.id]).join(),
    "the deals link to the kept row instead, once each",
    { d2: await linksOf(d2.id, company.id), d3: await linksOf(d3.id, company.id) },
  );
  const out = await ops.rowOutput({ userId: ids.owner, actor: owner }, companies.id, acme.id);
  check(String((out.properties as Record<string, unknown>)["Deal count"]) === "3", "the rollup over the deals counts them all", out.properties);
  check(((await linksOf(child.id, parentProp.id)) as string[]).join() === acme.id, "sub-items move under the kept row");

  const threads = await service.readThreads(acme.id);
  check(threads.length === 2, "the comments came along", threads);
  check(threads.some((t) => t.quote === "Call back Tuesday"), "a comment on text stays on that text", threads.map((t) => t.quote));
  check(threads.some((t) => t.page && commentText(t.comments[0]?.body).includes("Who owns")), "a comment on the whole row stays one", threads);
  const body = (await service.readPage(acme.id)).markdown;
  check(body.includes("Our main account.") && body.includes("Merged from Acme Inc.") && body.includes("They use the Istanbul office."), "the merged row's content is added under a heading", body);

  const feed = (await listRowActivity(ids.owner, acme.id, { limit: 100 })).entries;
  const mergedEntry = feed.find((e) => e.kind === "merged");
  check(mergedEntry?.merged?.[0]?.id === acme2.id && mergedEntry.actor.person?.id === ids.member, "the activity says who merged which rows into it", mergedEntry);
  check(feed.some((e) => e.mergedFrom?.id === acme2.id && e.property?.id === phone.id), "the merged row's activity moved, marked as such", feed);
  check(feed.filter((e) => e.kind === "created" && !e.mergedFrom).length === 1, "the kept row was still created once");
  check((await db.select().from(file).where(eq(file.id, `${RUN}-file`)))[0].pageId === acme.id, "uploads move to the kept row");
  check((await db.select().from(rowEmail).where(eq(rowEmail.workspaceId, workspaceId)))[0].rowId === acme.id, "so does email");

  // ── The merged row ────────────────────────────────────────────────────────────────────
  const merged = await rowOf(acme2.id);
  check(merged.archivedAt && merged.mergedIntoId === acme.id, "the merged row is in the trash, pointing at the kept row");
  check(!(await linksOf(acme2.id, dealsProp.id)), "…without the links it gave away");
  const trash = await listTrash(ids.owner, workspaceId);
  check(trash.find((t) => t.id === acme2.id)?.mergedInto?.id === acme.id, "the trash says which row it was merged into");

  // ── Over REST, as the owner: merging the third into the kept row ───────────────────────
  const { secret: token } = await createApiToken(ids.owner, { name: "merge e2e", scopes: ["pages:write"] });
  const wrongDb = await api("POST", `/databases/${deals.id}/rows/merge`, token, { kept_row_id: acme.id, other_row_ids: [acme3.id] });
  check(wrongDb.status === 400, "REST refuses rows of another database than the path's", wrongDb);
  const viaRest = await api("POST", `/databases/${companies.id}/rows/merge`, token, {
    kept_row_id: acme.id,
    other_row_ids: [acme3.id],
    properties: { Labels: COMBINE },
  });
  check(viaRest.status === 200 && viaRest.body.merged_row_ids[0] === acme3.id, "POST /databases/{id}/rows/merge merges", viaRest);
  kept = await rowOf(acme.id);
  check(sorted(kept.properties[tags.id] as string[]).join() === sorted([lead.id, partner.id, vendor.id]).join(), "…combining labels again");
  check(((await linksOf(d3.id, company.id)) as string[]).join() === acme.id, "a deal that listed two duplicates now lists the kept row once");
  check(((await linksOf(n1.id, about.id)) as string[]).join() === acme.id, "one-way links from other databases point at the kept row too");
  const followers = await db.select().from(rowFollower).where(eq(rowFollower.rowId, acme.id));
  check(followers.some((f) => f.userId === ids.member && f.following), "followers of a merged row follow the kept row", followers);
  check((await countBacklinks(ids.owner, acme.id)) === 1, "a page linking to the kept row and a merged one counts once");
  check((await listBacklinks(ids.owner, acme.id))[0]?.id === wiki.id, "…and is listed as linking to the kept row");
  check((await rowOf(acme3.id)).mergedIntoId === acme.id, "the row merged over REST points at the kept row");

  // ── Restoring a merged row ────────────────────────────────────────────────────────────
  await restorePage(ids.owner, acme2.id);
  const restored = await rowOf(acme2.id);
  check(!restored.archivedAt && restored.mergedIntoId === null, "a merged row comes back from the trash as a row of its own");
  check(((await linksOf(d2.id, company.id)) as string[]).join() === acme.id, "…and the links it gave away stay with the kept row");
  check((await failure(() => mergeRows(owner, { keptRowId: acme.id, otherRowIds: [acme2.id], choices: { [MERGE_TITLE]: d1.id } }))) === "mergeChoiceInvalid", "a title from outside the merge is refused");

  const [{ entries: activityLeft }] = [{ entries: await db.select().from(rowActivity).where(eq(rowActivity.rowId, acme2.id)) }];
  check(activityLeft.length === 0, "the restored row's old activity stays with the kept row", activityLeft);

  // ── The merger's language ─────────────────────────────────────────────────────────────
  const turkish = await row("Ege Soğutma");
  const turkishDupe = await row("Ege Sogutma");
  await service.replaceContent(turkishDupe.id, "İzmir deposu.", owner);
  await mergeRows(owner, { keptRowId: turkish.id, otherRowIds: [turkishDupe.id] }, { locale: "tr" });
  const turkishBody = (await service.readPage(turkish.id)).markdown;
  check(turkishBody.includes("Ege Sogutma satırından birleştirildi") && !turkishBody.includes("Merged from"), "the heading is in the language the merger's app is in", turkishBody);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(oauthClient).where(eq(oauthClient.clientId, clientId));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
