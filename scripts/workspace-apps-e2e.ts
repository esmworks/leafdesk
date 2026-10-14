/**
 * End-to-end check of the connected apps a workspace's owners see (Settings > Security) against the
 * database: the MCP clients its people authorized and their REST API tokens that reach it (not
 * someone else's, not the server's own clients, not tokens for other workspaces or expired ones),
 * when each last reached this workspace (a REST request through the API's own handler, an MCP
 * request as the endpoint runs it; at most once a minute; nothing while apps are off here), and
 * an owner disconnecting one person's app or token: only owners, only what reaches the workspace,
 * gone from all of that person's workspaces, recorded in this workspace's audit log only.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/workspace-apps-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

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
const { AccessError, requirePageAccess } = await import("@/server/access");
const { createApiToken } = await import("@/server/api/tokens");
const { handleApiRequest } = await import("@/server/api");
const { runAsConnectedApp } = await import("@/server/connected-app");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { disconnectWorkspaceApp, listWorkspaceApps } = await import("@/server/workspace-apps");

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

/** Recording a use doesn't hold up the request: give it a moment. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

const usesOf = (userId: string) => db.select().from(connectedAppUse).where(eq(connectedAppUse.userId, userId));

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
  const everywhere = await createApiToken(ids.member, { name: "Everywhere", scopes: ["pages:read"] });
  const here = await createApiToken(ids.member, { name: "Reports", scopes: ["pages:write"], workspaceId: ws });
  const elsewhere = await createApiToken(ids.member, { name: "Elsewhere", scopes: ["pages:read"], workspaceId: other });
  const expired = await createApiToken(ids.member, { name: "Old", scopes: ["pages:read"], expiresInDays: 1 });
  await db.update(apiToken).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiToken.id, expired.token.id));

  // ── Who sees what ───────────────────────────────────────────────────────────────────────────
  const listed = await listWorkspaceApps(ids.owner, ws);
  const keys = listed.map((a) => `${a.kind}:${a.person.id}:${a.id}`).sort();
  check(
    JSON.stringify(keys) ===
      JSON.stringify(
        [`connected_app:${ids.member}:${clients.assistant}`, `api_token:${ids.member}:${everywhere.token.id}`, `api_token:${ids.member}:${here.token.id}`].sort(),
      ),
    "owners see their people's apps and tokens that reach the workspace, not others', the server's own, other workspaces' or expired ones",
    keys,
  );
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
  await settle();
  check(response.status === 200, "a REST request with the token reads the page", response.status);
  let rows = await usesOf(ids.member);
  check(
    rows.length === 1 && rows[0].workspaceId === ws && rows[0].appKind === "api_token" && rows[0].appId === here.token.id,
    "…and is recorded as the token's use in this workspace",
    rows,
  );
  const mcp = { kind: "connected_app" as const, id: clients.assistant };
  await runAsConnectedApp({ userId: ids.member, app: mcp }, () => requirePageAccess(ids.member, page.id, "view"));
  await settle();
  rows = await usesOf(ids.member);
  const appUse = rows.find((r) => r.appKind === "connected_app");
  check(appUse?.workspaceId === ws, "an MCP request reaching the workspace is recorded as the app's use there", rows);
  const listedAfter = await listWorkspaceApps(ids.owner, ws);
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
  await updateWorkspaceSettings(ids.owner, ws, { connectedApps: "full" });

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
    (await listWorkspaceApps(ids.owner, ws)).map((a) => a.id).join() === everywhere.token.id,
    "the list then shows only what still reaches the workspace",
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(oauthClient).where(inArray(oauthClient.clientId, Object.values(clients)));
  await db.delete(workspace).where(inArray(workspace.id, [ws, other]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
