/**
 * End-to-end check of snippets against the database: personal snippets only their owner reads or
 * changes, workspace snippets members use and only owners change (guests and outsiders get
 * nothing), triggers checked and unique in their scope (not across scopes or people), the limits
 * on size and count (also with requests at once), duplicating, importing both file shapes with what
 * was skipped and why, losing a workspace's snippets on leaving it or becoming a guest, deleting a
 * workspace or an account, and the MCP list_snippets tool. Creates its own users and workspaces
 * and deletes them afterwards.
 *
 *   pnpm tsx scripts/snippets-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { snippet, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE } = await import("@/server/mcp/principal");
const { registerCollab } = await import("@/server/collab/bridge");
const { AccessError } = await import("@/server/access");
const { removeMember, setMemberRole } = await import("@/server/workspaces");
const { MAX_SNIPPET_BODY, MAX_SNIPPETS, snippetExport } = await import("@/lib/snippets");
const {
  createSnippet,
  deleteSnippet,
  duplicateSnippet,
  exportSnippets,
  getSnippet,
  importSnippets,
  listSnippets,
  SnippetError,
  updateSnippet,
  usableSnippets,
} = await import("@/server/snippets");

const RUN = `snippets-e2e-${Date.now().toString(36)}`;

// Leaving a workspace drops open editors through the collab service, which only runs in the app server.
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectTeamspace() {},
  async disconnectLostAccess() {},
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
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

async function rejects(fn: () => Promise<unknown>, test: (error: unknown) => boolean, label: string) {
  try {
    await fn();
  } catch (error) {
    check(test(error), label, String(error));
    return;
  }
  check(false, label, "did not throw");
}

const code = (wanted: string) => (error: unknown) => error instanceof SnippetError && error.code === wanted;
const isAccessError = (error: unknown) => error instanceof AccessError;

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: [READ_SCOPE] });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 400; i++) {
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "snippets-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const ids = {
  owner: `${RUN}-owner`,
  member: `${RUN}-member`,
  leaver: `${RUN}-leaver`,
  demoted: `${RUN}-demoted`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
  gone: `${RUN}-gone`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWs = `${RUN}-ws2`;
const doomedWs = `${RUN}-ws3`;
const { owner, member, leaver, demoted, guest, outsider, gone } = ids;
const personal = { kind: "personal" } as const;
const shared = { kind: "workspace", workspaceId } as const;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWs, name: `${RUN} other` },
    { id: doomedWs, name: `${RUN} doomed` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: member, role: "member" },
    { workspaceId, userId: leaver, role: "member" },
    { workspaceId, userId: demoted, role: "member" },
    { workspaceId, userId: guest, role: "guest" },
    { workspaceId: otherWs, userId: outsider, role: "owner" },
    { workspaceId: doomedWs, userId: owner, role: "owner" },
  ]);

  // ── Personal snippets ───────────────────────────────────────────────────────────────────────
  const sig = await createSnippet(member, personal, { trigger: "  Sig ", title: "", body: "Best,\r\n{{me}}" });
  check(sig.trigger === "sig" && sig.title === "sig" && sig.body === "Best,\n{{me}}" && sig.scope === "personal", "a personal snippet is created, its trigger cleaned", sig);
  const [stored] = await db.select().from(snippet).where(eq(snippet.id, sig.id));
  check(stored.userId === member && stored.workspaceId === null && stored.createdBy === member, "…stored as the person's own");
  check((await listSnippets(member, personal)).map((s) => s.id).join() === sig.id, "the person lists it");
  check((await listSnippets(owner, personal)).length === 0, "nobody else does, not even a workspace owner");
  await rejects(() => getSnippet(owner, sig.id), code("notFound"), "someone else can't read it");
  await rejects(() => updateSnippet(owner, sig.id, { trigger: "x", body: "x" }), code("notFound"), "…nor change it");
  await rejects(() => deleteSnippet(owner, sig.id), code("notFound"), "…nor delete it");
  await rejects(() => duplicateSnippet(owner, sig.id, (t) => t), code("notFound"), "…nor copy it");
  check((await getSnippet(member, sig.id)).body === "Best,\n{{me}}", "its owner reads it with its body");

  // ── Rules, checked on the server whatever the client sent ───────────────────────────────────
  await rejects(() => createSnippet(member, personal, { trigger: "", body: "x" }), code("triggerRequired"), "a trigger is required");
  await rejects(() => createSnippet(member, personal, { trigger: "a/b", body: "x" }), code("triggerInvalid"), "a trigger with other characters is refused");
  await rejects(() => createSnippet(member, personal, { trigger: "toplantı", body: "x" }), code("triggerInvalid"), "…and one with letters outside a-z");
  await rejects(() => createSnippet(member, personal, { trigger: "x".repeat(33), body: "x" }), code("triggerInvalid"), "…and one over 32 characters");
  await rejects(() => createSnippet(member, personal, { trigger: "t", title: "t".repeat(121), body: "x" }), code("titleTooLong"), "a title over 120 characters is refused");
  await rejects(() => createSnippet(member, personal, { trigger: "t", body: " \n " }), code("bodyRequired"), "an empty body is refused");
  await rejects(
    () => createSnippet(member, personal, { trigger: "t", body: "x".repeat(MAX_SNIPPET_BODY + 1) }),
    code("bodyTooLong"),
    `a body over ${MAX_SNIPPET_BODY} characters is refused`,
  );
  await rejects(
    () => createSnippet(member, personal, { trigger: 42 as unknown as string, body: { x: 1 } as unknown as string }),
    (e) => e instanceof SnippetError,
    "values of the wrong type are refused",
  );
  check((await createSnippet(member, personal, { trigger: "x".repeat(32), body: "x".repeat(MAX_SNIPPET_BODY) })).trigger.length === 32, "the limits themselves are allowed");
  await rejects(
    () => db.insert(snippet).values({ userId: member, workspaceId, trigger: "both", title: "b", body: "b" }),
    () => true,
    "the database refuses a snippet with both a person and a workspace",
  );
  await rejects(() => db.insert(snippet).values({ trigger: "neither", title: "n", body: "n" }), () => true, "…and one with neither");
  await rejects(() => db.insert(snippet).values({ userId: member, trigger: "Bad!", title: "b", body: "b" }), () => true, "…and a trigger outside the pattern");

  // ── Unique per scope ────────────────────────────────────────────────────────────────────────
  await rejects(() => createSnippet(member, personal, { trigger: "SIG", body: "again" }), code("triggerTaken"), "a trigger is unique among the person's snippets");
  const log = await createSnippet(member, personal, { trigger: "log", body: "**{{datetime}}**: {{cursor}}" });
  await rejects(() => updateSnippet(member, log.id, { trigger: "sig", body: "x" }), code("triggerTaken"), "…also when one is renamed onto another");
  const renamed = await updateSnippet(member, log.id, { trigger: "log-line", title: "Log line", body: "{{time}} {{cursor}}" });
  check(renamed.trigger === "log-line" && renamed.title === "Log line" && renamed.body === "{{time}} {{cursor}}", "a snippet is changed", renamed);
  const ownersSig = await createSnippet(owner, personal, { trigger: "sig", body: "Cheers" });
  check(ownersSig.trigger === "sig", "two people may each have the same trigger");
  const sharedSig = await createSnippet(owner, shared, { trigger: "sig", title: "Team signature", body: "The team" });
  check(sharedSig.scope === "workspace", "a workspace may have a trigger a person also has");
  await rejects(() => createSnippet(owner, shared, { trigger: "sig", body: "x" }), code("triggerTaken"), "…but only once itself");

  // ── Workspace snippets: members use them, owners change them ────────────────────────────────
  const meeting = await createSnippet(owner, shared, { trigger: "meeting", title: "Meeting notes", body: "## {{page}}: {{date}}\n\n- {{cursor}}" });
  const [sharedRow] = await db.select().from(snippet).where(eq(snippet.id, meeting.id));
  check(sharedRow.workspaceId === workspaceId && sharedRow.userId === null && sharedRow.createdBy === owner, "a workspace snippet belongs to the workspace");
  check((await listSnippets(member, shared)).map((s) => s.trigger).join() === "meeting,sig", "members list the workspace's snippets");
  check((await getSnippet(member, meeting.id)).body.startsWith("## {{page}}"), "…and read them");
  const memberUse = await usableSnippets(member, workspaceId);
  check(
    memberUse.snippets.map((s) => `${s.scope}:${s.trigger}`).sort().join() === ["personal:log-line", "personal:sig", `personal:${"x".repeat(32)}`, "workspace:meeting", "workspace:sig"].sort().join(),
    "the editor offers members their own snippets and the workspace's",
    memberUse,
  );
  check(memberUse.manages === null && !("body" in memberUse.snippets[0]), "…without bodies, and without saving to the workspace");
  check((await usableSnippets(owner, workspaceId)).manages?.id === workspaceId, "owners may save to the workspace");
  await rejects(() => createSnippet(member, shared, { trigger: "mine", body: "x" }), code("ownersOnly"), "members can't add workspace snippets");
  await rejects(() => updateSnippet(member, meeting.id, { trigger: "meeting", body: "changed" }), code("ownersOnly"), "…nor change them");
  await rejects(() => deleteSnippet(member, meeting.id), code("ownersOnly"), "…nor delete them");
  await rejects(() => duplicateSnippet(member, meeting.id, (t) => t), code("ownersOnly"), "…nor copy them");
  await rejects(() => importSnippets(member, shared, "[]"), code("ownersOnly"), "…nor import into them");
  await rejects(() => listSnippets(guest, shared), isAccessError, "guests don't get the workspace's snippets");
  await rejects(() => getSnippet(guest, meeting.id), isAccessError, "…not even by id");
  await rejects(() => createSnippet(guest, shared, { trigger: "g", body: "x" }), isAccessError, "…and can't add any");
  const guestUse = await usableSnippets(guest, workspaceId);
  check(guestUse.snippets.length === 0 && guestUse.manages === null, "the editor offers a guest only their own snippets", guestUse);
  await rejects(() => listSnippets(outsider, shared), isAccessError, "someone outside the workspace gets nothing");
  await rejects(() => getSnippet(outsider, meeting.id), isAccessError, "…not even by id");
  await rejects(() => updateSnippet(outsider, meeting.id, { trigger: "meeting", body: "x" }), isAccessError, "…and changes nothing");
  check((await usableSnippets(outsider, workspaceId)).snippets.length === 0, "the editor offers an outsider nothing of the workspace");
  const changed = await updateSnippet(owner, meeting.id, { trigger: "meeting", title: "Meeting", body: "## {{page}}" });
  check(changed.body === "## {{page}}" && changed.title === "Meeting", "owners change workspace snippets");

  // ── Duplicating ─────────────────────────────────────────────────────────────────────────────
  const copy = await duplicateSnippet(owner, meeting.id, (t) => `${t} (copy)`);
  const copy2 = await duplicateSnippet(owner, copy.id, (t) => `${t} (copy)`);
  check(copy.trigger === "meeting-2" && copy.title === "Meeting (copy)" && copy.scope === "workspace" && copy.body === changed.body, "a copy gets the next free trigger in the same scope", copy);
  check(copy2.trigger === "meeting-3", "…and a copy of a copy the one after", copy2);
  const longTrigger = await duplicateSnippet(member, (await usableSnippets(member, workspaceId)).snippets.find((s) => s.trigger.length === 32)!.id, (t) => t);
  check(longTrigger.trigger === `${"x".repeat(30)}-2`, "a copy's trigger stays within 32 characters", longTrigger.trigger);

  // ── Import and export ───────────────────────────────────────────────────────────────────────
  const exported = await exportSnippets(owner, shared);
  check(exported.version === 1 && exported.snippets.map((s) => s.trigger).join() === "meeting,meeting-2,meeting-3,sig", "a scope exports as { version: 1, snippets }", exported);
  const roundTrip = await importSnippets(outsider, { kind: "workspace", workspaceId: otherWs }, JSON.stringify(exported));
  check(roundTrip.added.length === 4 && roundTrip.skipped.length === 0, "an export imports into another workspace as it was", roundTrip);
  check((await listSnippets(outsider, { kind: "workspace", workspaceId: otherWs })).find((s) => s.trigger === "meeting")?.body === "## {{page}}", "…bodies and all");
  const again = await importSnippets(outsider, { kind: "workspace", workspaceId: otherWs }, JSON.stringify(exported));
  check(again.added.length === 0 && again.skipped.every((s) => s.reason === "exists") && again.skipped.length === 4, "importing it again skips every trigger that exists, overwriting none", again);
  const plain = await importSnippets(
    member,
    personal,
    JSON.stringify([
      { id: "addr", label: "Somewhere 1\nIstanbul" },
      { id: "sig", label: "would clash" },
      { id: "Bad Id!", label: "x" },
      { id: "empty", label: "" },
      { id: "addr", label: "twice" },
    ]),
  );
  check(plain.added.map((s) => `${s.trigger}:${s.title}`).join() === "addr:addr", "a list of { id, label } imports: id as trigger and title, label as body", plain);
  check(
    JSON.stringify(plain.skipped) ===
      JSON.stringify([
        { trigger: "Bad Id!", reason: "triggerInvalid" },
        { trigger: "empty", reason: "bodyRequired" },
        { trigger: "addr", reason: "duplicate" },
        { trigger: "sig", reason: "exists" },
      ]),
    "…and says which were skipped and why",
    plain.skipped,
  );
  for (const bad of ["not json", "{}", '{"version":2,"snippets":[]}', '[{"label":"x"}]']) {
    await rejects(() => importSnippets(member, personal, bad), code("importInvalid"), `a file of neither shape is refused: ${bad}`);
  }
  check(snippetExport([{ trigger: "a", title: "A", body: "b" }]).snippets[0].trigger === "a", "the export file's shape");

  // ── Limits per scope ────────────────────────────────────────────────────────────────────────
  const count = async (owner: string) => (await db.select({ n: sql<number>`count(*)::int` }).from(snippet).where(eq(snippet.userId, owner)))[0].n;
  const have = await count(guest);
  await db.insert(snippet).values(
    Array.from({ length: MAX_SNIPPETS - 3 - have }, (_, i) => ({ userId: guest, trigger: `fill-${i}`, title: `Fill ${i}`, body: "x", createdBy: guest })),
  );
  // Three places left, five requests at once: the lock lets exactly three in.
  const racing = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => createSnippet(guest, personal, { trigger: `race-${i}`, body: "x" })));
  check(racing.filter((r) => r.status === "fulfilled").length === 3, "requests at once can't pass the limit", racing.map((r) => r.status));
  check(racing.filter((r) => r.status === "rejected").every((r) => code("tooMany")((r as PromiseRejectedResult).reason)), "…the others are told it's full");
  check((await count(guest)) === MAX_SNIPPETS, `a person has at most ${MAX_SNIPPETS} snippets`);
  await rejects(() => createSnippet(guest, personal, { trigger: "one-more", body: "x" }), code("tooMany"), "one more is refused");
  const raced = (racing.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>).value.id;
  await rejects(() => duplicateSnippet(guest, raced, (t) => t), code("tooMany"), "…and so is a copy");
  const overflow = await importSnippets(guest, personal, JSON.stringify({ version: 1, snippets: [{ trigger: "over", title: "Over", body: "x" }] }));
  check(overflow.added.length === 0 && overflow.skipped[0]?.reason === "tooMany", "an import past the limit skips what doesn't fit", overflow);
  const fresh = await createSnippet(outsider, personal, { trigger: "fill-0", body: "x" });
  check(fresh.trigger === "fill-0", "…and another person's scope is not");

  // ── Leaving the workspace, or becoming a guest ──────────────────────────────────────────────
  const leaverOwn = await createSnippet(leaver, personal, { trigger: "mine", body: "kept" });
  check((await usableSnippets(leaver, workspaceId)).snippets.some((s) => s.id === meeting.id), "before leaving, a member gets the workspace's snippets");
  await removeMember(leaver, workspaceId, leaver);
  const afterLeaving = await usableSnippets(leaver, workspaceId);
  check(afterLeaving.snippets.map((s) => s.id).join() === leaverOwn.id, "after leaving, only their own snippets are offered", afterLeaving);
  await rejects(() => getSnippet(leaver, meeting.id), isAccessError, "…a workspace snippet can't be read by id any more");
  await rejects(() => listSnippets(leaver, shared), isAccessError, "…nor listed");
  check((await getSnippet(leaver, leaverOwn.id)).body === "kept", "their personal snippets stay theirs");
  await setMemberRole(owner, workspaceId, demoted, "guest");
  check((await usableSnippets(demoted, workspaceId)).snippets.length === 0, "a member made a guest stops getting the workspace's snippets");
  await rejects(() => getSnippet(demoted, meeting.id), isAccessError, "…by id too");

  // ── MCP ─────────────────────────────────────────────────────────────────────────────────────
  const mcp = await callTool(member, "list_snippets", {});
  check(!mcp.isError, "MCP list_snippets answers", mcp.text);
  const listed = mcp.data.snippets as { trigger: string; scope: string; workspace_id?: string; markdown: string }[];
  check(listed.some((s) => s.scope === "workspace" && s.trigger === "meeting" && s.workspace_id === workspaceId && s.markdown === "## {{page}}"), "…with the workspace's snippets and their Markdown", listed);
  check(listed.some((s) => s.scope === "personal" && s.trigger === "addr"), "…and the person's own");
  check(!listed.some((s) => s.workspace_id === otherWs), "…not those of a workspace they aren't in");
  check(typeof mcp.data.placeholders === "string" && mcp.data.placeholders.includes("{{cursor}}"), "…saying what the placeholders mean");
  const mcpOne = await callTool(member, "list_snippets", { workspace_id: workspaceId });
  check(!mcpOne.isError && mcpOne.data.snippets.length === listed.length, "workspace_id narrows it to that workspace and their own", mcpOne.text);
  const mcpForeign = await callTool(member, "list_snippets", { workspace_id: otherWs });
  check(mcpForeign.isError, "…and refuses a workspace they aren't in", mcpForeign.text);
  const mcpGuest = await callTool(guest, "list_snippets", {});
  check(!mcpGuest.isError && mcpGuest.data.snippets.every((s: { scope: string }) => s.scope === "personal"), "a guest gets only their own snippets over MCP");
  const mcpLeaver = await callTool(leaver, "list_snippets", {});
  check(mcpLeaver.data.snippets.map((s: { trigger: string }) => s.trigger).join() === "mine", "someone who left gets only their own", mcpLeaver.data);

  // ── Deleting ────────────────────────────────────────────────────────────────────────────────
  await deleteSnippet(owner, copy2.id);
  check(!(await db.select().from(snippet).where(eq(snippet.id, copy2.id))).length, "owners delete workspace snippets");
  await deleteSnippet(member, renamed.id);
  await rejects(() => getSnippet(member, renamed.id), code("notFound"), "a deleted snippet is gone");
  await createSnippet(owner, { kind: "workspace", workspaceId: doomedWs }, { trigger: "bye", body: "x" });
  await db.delete(workspace).where(eq(workspace.id, doomedWs));
  check(!(await db.select().from(snippet).where(eq(snippet.workspaceId, doomedWs))).length, "a deleted workspace's snippets go with it");
  const goneOwn = await createSnippet(gone, personal, { trigger: "bye", body: "x" });
  await db.delete(user).where(eq(user.id, gone));
  check(!(await db.select().from(snippet).where(eq(snippet.id, goneOwn.id))).length, "a deleted account's snippets go with it");
  check((await db.select().from(snippet).where(eq(snippet.id, meeting.id)))[0]?.createdBy === owner, "workspace snippets keep who made them");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWs, doomedWs]));
  await db.delete(snippet).where(inArray(snippet.userId, userIds));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
