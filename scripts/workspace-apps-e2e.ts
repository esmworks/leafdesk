/**
 * End-to-end check of the connected apps a workspace's owners see (Settings > Security) against the
 * database: the MCP clients its people authorized and their REST API tokens that reach it (not
 * someone else's, not the server's own clients, not tokens for other workspaces or expired ones),
 * when each last reached this workspace (a REST request through the API's own handler, an MCP
 * request as the endpoint runs it; at most once a minute; nothing while apps are off here), and
 * owners letting in only the apps they approved (approving and withdrawing, the server's own clients
 * and REST API tokens not held to it), and
 * an owner disconnecting one person's app or token: only owners, only what reaches the workspace,
 * gone from all of that person's workspaces, recorded in this workspace's audit log only.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/workspace-apps-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
import { API_TOKEN_SCOPES as ALL_SCOPES, READ_SCOPES } from "@/lib/api-scopes";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { apiToken, auditEvent, connectedAppUse, oauthAccessToken, oauthClient, oauthConsent, teamspace, user, workspace, workspaceMember } =
  await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { AccessError, requirePageAccess, workspacesAwaitingApproval, workspacesHiddenFromApp } = await import("@/server/access");
const { createApiToken } = await import("@/server/api/tokens");
const { handleApiRequest } = await import("@/server/api");
const { runAsConnectedApp } = await import("@/server/connected-app");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { disconnectWorkspaceApp, listWorkspaceApps, pruneConnectedAppUse, setWorkspaceAppApproved } = await import("@/server/workspace-apps");
const { noteConnectedAppUse } = await import("@/server/connected-app-use");

const RUN = `workspace-apps-e2e-${Date.now().toString(36)}`;

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

/** Whether the promise fails with an AccessError. */
async function refused(promise: Promise<unknown>) {
  try {
    await promise;
    return false;
  } catch (error) {
    return error instanceof AccessError;
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const ws = `${RUN}-ws`;
const other = `${RUN}-other`;
const clients = { assistant: `${RUN}-assistant`, own: `${RUN}-own` };

const usesOf = (userId: string) => db.select().from(connectedAppUse).where(eq(connectedAppUse.userId, userId));

/**
 * Recording a use doesn't hold up the request: waits until the member's recorded uses number
 * `count` (up to 3 seconds), or a moment when nothing more should come.
 */
async function settle(count?: number) {
  for (let waited = 0; waited < 3000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (count === undefined ? waited >= 300 : (await usesOf(ids.member)).length >= count) return;
  }
}

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
    { id: ids.outsider, name: "Outsider Oya", email: `${ids.outsider}@example.test` },
  ]);
  await db.insert(workspace).values([
    { id: ws, name: RUN },
    { id: other, name: `${RUN} other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: ws, userId: ids.owner, role: "owner" },
    { workspaceId: ws, userId: ids.member, role: "member" },
    { workspaceId: other, userId: ids.member, role: "owner" },
    { workspaceId: other, userId: ids.outsider, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, ws));
  const page = await createPage({ userId: ids.owner }, { workspaceId: ws, teamspaceId: general.id, title: "Plans" });

  const now = new Date();
  await db.insert(oauthClient).values([
    { id: clients.assistant, clientId: clients.assistant, name: "Writing assistant", redirectUris: ["http://127.0.0.1/cb"], createdAt: now, updatedAt: now },
    { id: clients.own, clientId: clients.own, name: "Server's own", skipConsent: true, redirectUris: ["http://127.0.0.1/cb"], createdAt: now, updatedAt: now },
  ]);
  await db.insert(oauthConsent).values([
    { id: `${RUN}-c1`, clientId: clients.assistant, userId: ids.member, scopes: ["pages:read", "pages:write"], createdAt: now, updatedAt: now },
    { id: `${RUN}-c2`, clientId: clients.assistant, userId: ids.outsider, scopes: ["pages:read"], createdAt: now, updatedAt: now },
    { id: `${RUN}-c3`, clientId: clients.own, userId: ids.member, scopes: ["pages:read"], createdAt: now, updatedAt: now },
  ]);
  await db.insert(oauthAccessToken).values({
    id: `${RUN}-at`,
    token: `${RUN}-at`,
    clientId: clients.assistant,
    userId: ids.member,
    scopes: ["pages:read"],
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: now,
  });
  const everywhere = await createApiToken(ids.member, { name: "Everywhere", scopes: READ_SCOPES });
  const here = await createApiToken(ids.member, { name: "Reports", scopes: ALL_SCOPES, workspaceId: ws });
  const elsewhere = await createApiToken(ids.member, { name: "Elsewhere", scopes: READ_SCOPES, workspaceId: other });
  const expired = await createApiToken(ids.member, { name: "Old", scopes: READ_SCOPES, expiresInDays: 1 });
  await db.update(apiToken).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiToken.id, expired.token.id));

  // ── Who sees what ───────────────────────────────────────────────────────────────────────────
  const { apps: listed, total } = await listWorkspaceApps(ids.owner, ws);
  const keys = listed.map((a) => `${a.kind}:${a.person.id}:${a.id}`).sort();
  check(
    JSON.stringify(keys) ===
      JSON.stringify(
        [`connected_app:${ids.member}:${clients.assistant}`, `api_token:${ids.member}:${everywhere.token.id}`, `api_token:${ids.member}:${here.token.id}`].sort(),
      ),
    "owners see their people's apps and tokens that reach the workspace, not others', the server's own, other workspaces' or expired ones",
    keys,
  );
  check(total === 3, "…and how many there are in all", total);
  const app = listed.find((a) => a.kind === "connected_app")!;
  const token = listed.find((a) => a.id === here.token.id)!;
  check(
    app.name === "Writing assistant" && app.writes && app.allWorkspaces && app.person.name === "Member Mert" && !app.lastUsedHere,
    "…each with its name, what it may do, whom it acts for and no use here yet",
    app,
  );
  check(token.writes && !token.allWorkspaces && token.prefix === here.token.prefix, "…a token limited to this workspace says so", token);
  check(await refused(listWorkspaceApps(ids.member, ws)), "members can't see the list");

  // ── Last used here ──────────────────────────────────────────────────────────────────────────
  const rest = (secret: string) =>
    handleApiRequest(new Request(`http://localhost/api/v1/pages/${page.id}`, { headers: { authorization: `Bearer ${secret}` } }));
  const response = await rest(here.secret);
  await settle(1);
  check(response.status === 200, "a REST request with the token reads the page", response.status);
  let rows = await usesOf(ids.member);
  check(
    rows.length === 1 && rows[0].workspaceId === ws && rows[0].appKind === "api_token" && rows[0].appId === here.token.id,
    "…and is recorded as the token's use in this workspace",
    rows,
  );
  const mcp = { kind: "connected_app" as const, id: clients.assistant };
  await runAsConnectedApp({ userId: ids.member, app: mcp }, () => requirePageAccess(ids.member, page.id, "view"));
  await settle(2);
  rows = await usesOf(ids.member);
  const appUse = rows.find((r) => r.appKind === "connected_app");
  check(appUse?.workspaceId === ws, "an MCP request reaching the workspace is recorded as the app's use there", rows);
  const listedAfter = (await listWorkspaceApps(ids.owner, ws)).apps;
  check(
    listedAfter[0]?.kind === "connected_app" && listedAfter[0].lastUsedHere !== null && listedAfter.find((a) => a.id === everywhere.token.id)?.lastUsedHere === null,
    "owners see when each was last used here, most recent first",
    listedAfter.map((a) => [a.name, a.lastUsedHere]),
  );
  await rest(here.secret);
  await runAsConnectedApp({ userId: ids.member, app: mcp }, () => requirePageAccess(ids.member, page.id, "view"));
  await settle();
  const again = await usesOf(ids.member);
  check(
    again.length === 2 && again.every((r) => rows.find((s) => s.appId === r.appId)?.lastUsedAt.getTime() === r.lastUsedAt.getTime()),
    "a use is written at most once a minute",
    again,
  );
  await updateWorkspaceSettings(ids.owner, ws, { connectedApps: "off" });
  const hidden = await rest(everywhere.secret);
  await settle();
  check(
    hidden.status === 404 && !(await usesOf(ids.member)).some((r) => r.appId === everywhere.token.id),
    "while connected apps are off here, a request isn't let in and isn't counted as a use",
    hidden.status,
  );
  await updateWorkspaceSettings(ids.owner, ws, { connectedApps: "read" });
  const tokenApp = { kind: "api_token" as const, id: everywhere.token.id };
  const write = await runAsConnectedApp({ userId: ids.member, app: tokenApp, writing: true }, () => requirePageAccess(ids.member, page.id, "edit")).then(
    () => "allowed",
    () => "refused",
  );
  await settle();
  check(
    write === "refused" && !(await usesOf(ids.member)).some((r) => r.appId === everywhere.token.id),
    "where apps may only read, a refused write isn't counted as a use either",
    write,
  );
  await updateWorkspaceSettings(ids.owner, ws, { connectedApps: "full" });

  // ── Only approved apps ──────────────────────────────────────────────────────────────────────
  const reads = (client: { kind: "connected_app" | "api_token"; id: string }) =>
    runAsConnectedApp({ userId: ids.member, app: client }, () => requirePageAccess(ids.member, page.id, "view")).then(
      () => true,
      () => false,
    );
  const hiddenFor = (client: { kind: "connected_app" | "api_token"; id: string }) =>
    runAsConnectedApp({ userId: ids.member, app: client }, () => workspacesHiddenFromApp(ids.member));
  check(await refused(setWorkspaceAppApproved(ids.member, ws, clients.assistant, true)), "members can't approve apps");
  check(await refused(setWorkspaceAppApproved(ids.owner, ws, `${RUN}-nobody`, true)), "owners can't approve an app no one here connected");
  check(
    await updateWorkspaceSettings(ids.owner, ws, { approvedApps: [clients.assistant] }).then(
      () => false,
      () => true,
    ),
    "approved apps can't be set through a settings change",
  );
  await updateWorkspaceSettings(ids.owner, ws, { onlyApprovedApps: true });
  check(!(await reads(mcp)), "where only approved apps may come, an app not approved can't open the page");
  check((await hiddenFor(mcp)).has(ws) && !(await hiddenFor(mcp)).has(other), "…and the workspace is left out of its lists, not the person's other one");
  check(await reads({ kind: "connected_app", id: clients.own }), "the server's own clients aren't held to it");
  check(
    (await workspacesAwaitingApproval(ids.member, clients.assistant)).join() === RUN && !(await workspacesAwaitingApproval(ids.member, clients.own)).length,
    "the consent screen can tell which workspaces the app won't reach yet",
  );
  check((await rest(everywhere.secret)).status === 200, "nor are REST API tokens");
  check(
    (await listWorkspaceApps(ids.owner, ws)).apps.find((a) => a.id === clients.assistant)?.approved === false,
    "owners see the app isn't approved",
  );
  check((await setWorkspaceAppApproved(ids.owner, ws, clients.assistant, true)).changed, "an owner approves it");
  check(await reads(mcp), "…and it opens the page again");
  check(!(await hiddenFor(mcp)).has(ws), "…and lists the workspace");
  check(
    (await listWorkspaceApps(ids.owner, ws)).apps.find((a) => a.id === clients.assistant)?.approved === true,
    "…shown approved in the list",
  );
  check(!(await setWorkspaceAppApproved(ids.owner, ws, clients.assistant, true)).changed, "approving it again changes nothing");
  await setWorkspaceAppApproved(ids.owner, ws, clients.assistant, false);
  check(!(await reads(mcp)), "withdrawing the approval shuts it out again");
  await updateWorkspaceSettings(ids.owner, ws, { onlyApprovedApps: false });
  check(await reads(mcp), "turning the setting off lets every app in again");
  // The uses these requests record are written after them: let them land, and forget those of the
  // server's own client and the token, which the checks below don't expect.
  await settle();
  await db
    .delete(connectedAppUse)
    .where(and(eq(connectedAppUse.userId, ids.member), inArray(connectedAppUse.appId, [clients.own, everywhere.token.id])));
  const approvals = (await db.select().from(auditEvent).where(eq(auditEvent.workspaceId, ws)).orderBy(auditEvent.createdAt)).filter((e) =>
    ["connected_app.approved", "connected_app.unapproved"].includes(e.action),
  );
  check(
    approvals.map((e) => e.action).join() === "connected_app.approved,connected_app.unapproved" &&
      approvals.every((e) => e.actorUserId === ids.owner && e.targetLabel === "Writing assistant"),
    "the audit log records the approval and its withdrawal, by the owner",
    approvals.map((e) => [e.action, e.actorUserId, e.targetLabel]),
  );

  // ── Disconnecting ───────────────────────────────────────────────────────────────────────────
  check(
    await refused(disconnectWorkspaceApp(ids.member, ws, { kind: "connected_app", userId: ids.member, id: clients.assistant })),
    "members can't disconnect apps from the list",
  );
  check(
    await refused(disconnectWorkspaceApp(ids.owner, ws, { kind: "connected_app", userId: ids.outsider, id: clients.assistant })),
    "owners can't disconnect the app of someone not in the workspace",
  );
  check(
    await refused(disconnectWorkspaceApp(ids.owner, ws, { kind: "api_token", userId: ids.member, id: elsewhere.token.id })),
    "…nor a token that doesn't reach it",
  );
  await db.insert(connectedAppUse).values({ workspaceId: other, userId: ids.member, appKind: "connected_app", appId: clients.assistant, lastUsedAt: now });
  await disconnectWorkspaceApp(ids.owner, ws, { kind: "connected_app", userId: ids.member, id: clients.assistant });
  const consents = await db.select().from(oauthConsent).where(and(eq(oauthConsent.userId, ids.member), eq(oauthConsent.clientId, clients.assistant)));
  const [access] = await db.select({ revoked: oauthAccessToken.revoked }).from(oauthAccessToken).where(eq(oauthAccessToken.id, `${RUN}-at`));
  const outsiderConsent = await db.select().from(oauthConsent).where(eq(oauthConsent.userId, ids.outsider));
  check(
    consents.length === 0 && access?.revoked !== null && outsiderConsent.length === 1,
    "an owner disconnects the member's app: their consent and tokens go, others' stay",
  );
  check(
    !(await usesOf(ids.member)).some((r) => r.appKind === "connected_app"),
    "…and when it was last used is forgotten, in every workspace",
  );
  noteConnectedAppUse(ids.member, mcp, ws);
  await settle();
  check(
    !(await usesOf(ids.member)).some((r) => r.appKind === "connected_app"),
    "a request that was under way when it was disconnected doesn't bring its use back",
  );
  await disconnectWorkspaceApp(ids.owner, ws, { kind: "api_token", userId: ids.member, id: here.token.id });
  check((await rest(here.secret)).status === 401, "an owner revokes the member's token: it stops working");
  check(
    (await db.select().from(apiToken).where(inArray(apiToken.id, [everywhere.token.id, elsewhere.token.id]))).length === 2,
    "…and their other tokens keep working",
  );
  const events = await db.select().from(auditEvent).where(inArray(auditEvent.workspaceId, [ws, other]));
  const revokes = events.filter((e) => e.action === "connected_app.revoked" || e.action === "api_token.revoked");
  check(
    revokes.length === 2 &&
      revokes.every((e) => e.workspaceId === ws && e.actorUserId === ids.owner) &&
      revokes.every((e) => (e.details as Record<string, unknown>).subjectId === ids.member && (e.details as Record<string, unknown>).subject === "Member Mert"),
    "this workspace's audit log records both, by the owner, about the member; their other workspace's doesn't",
    revokes.map((e) => [e.workspaceId, e.action, e.actorUserId, e.details]),
  );
  check(
    (await listWorkspaceApps(ids.owner, ws)).apps.map((a) => a.id).join() === everywhere.token.id,
    "the list then shows only what still reaches the workspace",
  );

  // ── Daily cleanup ───────────────────────────────────────────────────────────────────────────
  await db.insert(connectedAppUse).values([
    { workspaceId: ws, userId: ids.member, appKind: "api_token", appId: everywhere.token.id, lastUsedAt: now },
    { workspaceId: ws, userId: ids.member, appKind: "api_token", appId: expired.token.id, lastUsedAt: now },
    { workspaceId: ws, userId: ids.outsider, appKind: "connected_app", appId: clients.assistant, lastUsedAt: now },
  ]);
  const pruned = await pruneConnectedAppUse([ws, other]);
  const left = await db.select().from(connectedAppUse).where(inArray(connectedAppUse.workspaceId, [ws, other]));
  check(
    pruned === 2 && left.length === 1 && left[0].appId === everywhere.token.id,
    "the daily cleanup forgets uses of expired tokens and of people no longer in the workspace, and keeps the rest",
    { pruned, left },
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(oauthClient).where(inArray(oauthClient.clientId, Object.values(clients)));
  await db.delete(workspace).where(inArray(workspace.id, [ws, other]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
