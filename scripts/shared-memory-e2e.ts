/**
 * End-to-end check of the AI's notes beyond a person's own in a workspace, against the database,
 * with a fake OpenAI-compatible server (src/server/ai/fake-openai.ts) for the model: the workspace's
 * notes (owners write, members read, guests neither), a teamspace's (those who manage it write,
 * those in it read, others neither), and a person's notes for every workspace (theirs alone);
 * what goes with a question (the workspace's to every member, a teamspace's only to a question
 * asked inside it by someone in it, never an archived one's, the person's own everywhere only to
 * them), the chat asking before it keeps a shared note and refusing one the person may not
 * change, the audit log, and the workspace's memory switch stopping all of it.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/shared-memory-e2e.ts
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
const { auditEvent, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");
const { resetAi, setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const { startChat } = await import("@/server/ai-chat");
const { decideChange } = await import("@/server/ai-chat-approvals");
const { MemoryError, setMemoryUse } = await import("@/server/ai-memory");
const { releaseLegalHold, setLegalHold } = await import("@/server/legal-hold");
const { accountNotes, deleteAccountNotes, writeAccountNote } = await import("@/server/account-memory");
const { deleteSharedNotes, memoryPlaces, placeNotes, sharedMemoryFor, writeSharedNote } = await import("@/server/shared-memory");
const { addTeamspaceMembers, createTeamspace, setTeamspaceArchived } = await import("@/server/teamspaces");
type ChatEvent = import("@/lib/ai-chat").ChatEvent;
type ChatInput = import("@/server/ai-chat").ChatInput;

const RUN = `sharedmemory-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
setAiEnv({
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
});

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

/** Runs a question to the end, answering each approval with `decision`; returns what it asked and its memory steps. */
async function ask(userId: string, input: ChatInput, decision: "approve" | "decline" = "approve") {
  const events: ChatEvent[] = [];
  for await (const event of await startChat(userId, input)) {
    events.push(event);
    if (event.type === "approval") decideChange(userId, event.id, decision);
  }
  return {
    done: events.at(-1)?.type === "done",
    approvals: events.flatMap((e) => (e.type === "approval" ? [e.action] : [])),
    steps: events.flatMap((e) => (e.type === "step" && e.step.kind === "memory" ? [e.step] : [])),
  };
}

/** A model that makes these tool calls, one per turn, then answers "Done." */
function caller(calls: { name: string; arguments: Record<string, unknown> }[]) {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    return made < calls.length ? { toolCalls: [calls[made]] } : { text: "Done." };
  };
}
const answering = (): FakeReply => ({ text: "Hello." });
const question = (request: FakeChatRequest) => textOf(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
const tagged = (request: FakeChatRequest, tag: string) => new RegExp(`<${tag}[^>]*>\\n([\\s\\S]*?)\\n</${tag}>`).exec(question(request))?.[1] ?? null;
const toolResults = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
/** The question the fake model got last, after asking `userId` this. */
async function sent(userId: string, input: ChatInput) {
  fake.setChat(answering);
  fake.chats.length = 0;
  await ask(userId, input);
  return fake.chats[0];
}

const ids = { owner: `${RUN}-owner`, alice: `${RUN}-alice`, bob: `${RUN}-bob`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const { owner, alice, bob, guest } = ids;
const workspaceId = `${RUN}-ws`;
const otherWs = `${RUN}-ws2`;

const auditOf = (action: string) => db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, action)));

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWs, name: `${RUN} other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: bob, role: "member" },
    { workspaceId, userId: guest, role: "guest" },
    { workspaceId: otherWs, userId: alice, role: "owner" },
  ]);
  // Sales is closed: Alice is in it, Bob isn't; the owner made it, so manages it.
  const sales = await createTeamspace(owner, workspaceId, { name: "Sales", access: "closed" });
  await addTeamspaceMembers(owner, sales.id, [alice]);

  // ── The workspace's notes ───────────────────────────────────────────────────────────────────
  const fiscal = await writeSharedNote(owner, workspaceId, null, "Our fiscal year starts in April.");
  check(fiscal.text === "Our fiscal year starts in April.", "an owner keeps a note for the workspace");
  const again = await writeSharedNote(owner, workspaceId, null, "our FISCAL year starts in april.");
  check(again.known === true && again.id === fiscal.id && (await placeNotes(owner, workspaceId, null)).length === 1, "the same note (case aside) is kept once");
  const memberWrite = await writeSharedNote(alice, workspaceId, null, "Hijack").catch((e) => e);
  check(memberWrite instanceof AccessError, "a member can't change the workspace's notes");
  check((await placeNotes(alice, workspaceId, null)).map((n) => n.text).join() === fiscal.text, "…but reads them, with who changed each", await placeNotes(alice, workspaceId, null));
  check((await placeNotes(alice, workspaceId, null))[0].by === owner, "…naming who changed it last");
  const guestRead = await placeNotes(guest, workspaceId, null).catch((e) => e);
  check(guestRead instanceof AccessError, "a guest can't read them");
  check((await memoryPlaces(guest, workspaceId)).workspace === null, "…and the Memory page shows a guest none");
  check((await auditOf("memory.note_added")).length === 1, "keeping one is in the audit log, once");

  // ── A teamspace's notes ─────────────────────────────────────────────────────────────────────
  const quota = await writeSharedNote(owner, workspaceId, sales.id, "Quotas reset each quarter.");
  check(quota.teamspaceId === sales.id, "the teamspace's owner keeps a note for it");
  check((await placeNotes(alice, workspaceId, sales.id)).length === 1, "someone in it reads its notes");
  const aliceWrite = await writeSharedNote(alice, workspaceId, sales.id, "Hijack").catch((e) => e);
  check(aliceWrite instanceof AccessError, "…but a member of it doesn't change them");
  const bobRead = await placeNotes(bob, workspaceId, sales.id).catch((e) => e);
  check(bobRead instanceof AccessError, "someone outside it can't read them");
  const places = await memoryPlaces(alice, workspaceId);
  check(
    places.workspace?.canChange === false && places.teamspaces.some((t) => t.id === sales.id && !t.canChange && t.notes.length === 1),
    "the Memory page lists the workspace's and the teamspace's notes, read-only for a member",
    places,
  );
  check(!(await memoryPlaces(bob, workspaceId)).teamspaces.some((t) => t.id === sales.id), "…and not a teamspace the person isn't in");

  // ── The person's notes everywhere ───────────────────────────────────────────────────────────
  const turkish = await writeAccountNote(alice, "Answer in Turkish.");
  check((await writeAccountNote(alice, "answer in turkish.")).known === true && (await accountNotes(alice)).length === 1, "a person keeps a note for all their workspaces, once");
  check((await deleteAccountNotes(bob, [turkish.id])).length === 0 && (await accountNotes(alice)).length === 1, "no one else can delete it");

  // ── What goes with a question ───────────────────────────────────────────────────────────────
  const shared = await sharedMemoryFor(alice, workspaceId, sales.id);
  check(shared.workspace.length === 1 && shared.teamspace?.notes.length === 1, "inside the teamspace, someone in it gets both");
  check((await sharedMemoryFor(bob, workspaceId, sales.id)).teamspace === null, "someone outside it gets only the workspace's");
  const guestShared = await sharedMemoryFor(guest, workspaceId, null);
  check(guestShared.workspace.length === 0, "a guest gets none");

  let request = await sent(alice, { workspaceId, message: "Hi", scope: { teamspaceId: sales.id } });
  check(tagged(request, "workspace_memory")?.includes("fiscal year") && tagged(request, "teamspace_memory")?.includes("Quotas"), "a question asked in the teamspace carries its notes and the workspace's", question(request));
  check(tagged(request, "account_memory")?.includes("Answer in Turkish."), "…and the person's notes everywhere");
  request = await sent(alice, { workspaceId, message: "Hi" });
  check(tagged(request, "workspace_memory") !== null && tagged(request, "teamspace_memory") === null, "a question asked elsewhere doesn't carry the teamspace's notes");
  check(question(request).includes(`teamspace_id ${sales.id}, 1 note`), "…it names the teamspace, for read_memory", question(request));
  request = await sent(alice, { workspaceId: otherWs, message: "Hi" });
  check(tagged(request, "account_memory")?.includes("Answer in Turkish.") && !question(request).includes("fiscal"), "in another workspace the notes everywhere go, the first workspace's don't");
  request = await sent(bob, { workspaceId, message: "Hi" });
  check(tagged(request, "workspace_memory") !== null && !JSON.stringify(request).includes("Answer in Turkish") && !JSON.stringify(request).includes("Quotas"), "someone else gets neither her notes nor the teamspace's");

  // ── The chat keeping shared notes ───────────────────────────────────────────────────────────
  fake.setChat(caller([{ name: "remember", arguments: { text: "Invoices go out on the 1st.", scope: "workspace" } }]));
  const asked = await ask(owner, { workspaceId, message: "Remember for everyone: invoices go out on the 1st.", mode: "auto" });
  check(asked.approvals.length === 1 && asked.approvals[0].memoryLayer?.layer === "workspace", "the chat asks before keeping a note for the workspace, even on Auto", asked.approvals);
  check((await placeNotes(owner, workspaceId, null)).some((n) => n.text === "Invoices go out on the 1st."), "…and keeps it once approved");
  check(asked.steps.some((s) => s.layer === "workspace" && s.memoryId === undefined), "…shown as a step saying where it went", asked.steps);
  fake.setChat(caller([{ name: "remember", arguments: { text: "Quotas are secret.", scope: "workspace" } }]));
  fake.chats.length = 0;
  const refused = await ask(alice, { workspaceId, message: "Remember for everyone: quotas are secret." });
  check(refused.approvals.length === 0 && !(await placeNotes(alice, workspaceId, null)).some((n) => n.text === "Quotas are secret."), "a member's chat can't keep one for the workspace");
  check(toolResults(fake.chats.at(-1)!).some((r) => r.includes("Only the workspace's owners")), "…and the model is told why");
  fake.setChat(caller([{ name: "remember", arguments: { text: "Reads only.", scope: "workspace" } }]));
  fake.chats.length = 0;
  const readOnly = await ask(owner, { workspaceId, message: "Remember for everyone: reads only.", mode: "read" });
  check(
    readOnly.approvals.length === 0 && !(await placeNotes(owner, workspaceId, null)).some((n) => n.text === "Reads only.") && toolResults(fake.chats.at(-1)!).some((r) => r.includes("may change nothing")),
    "a chat that may change nothing keeps no note for the workspace, not even asking",
  );
  await setMemoryUse(alice, workspaceId, false);
  fake.setChat(caller([{ name: "read_memory", arguments: { layer: "account" } }]));
  fake.chats.length = 0;
  await ask(alice, { workspaceId, message: "What do you know about me?" });
  check(
    !JSON.stringify(fake.chats).includes("Answer in Turkish") && toolResults(fake.chats.at(-1)!).some((r) => r.includes("memory is off")),
    "with the person's memory off, read_memory reads none of their notes, though called anyway",
  );
  await setMemoryUse(alice, workspaceId, true);
  fake.setChat(caller([{ name: "remember", arguments: { text: "Prefers short answers.", scope: "account" } }]));
  const everywhere = await ask(alice, { workspaceId, message: "Everywhere, keep answers short.", mode: "auto" }, "decline");
  check(everywhere.approvals.length === 1 && (await accountNotes(alice)).length === 1, "a note for every workspace is asked about too, and a No keeps nothing");

  // ── Archived teamspaces, deleting, the switch ───────────────────────────────────────────────
  await setTeamspaceArchived(owner, sales.id, true);
  check((await sharedMemoryFor(alice, workspaceId, sales.id)).teamspace === null, "an archived teamspace's notes go nowhere");
  const archivedWrite = await writeSharedNote(owner, workspaceId, sales.id, "More").catch((e) => e);
  check(archivedWrite instanceof AccessError, "…and can't be changed");
  await setTeamspaceArchived(owner, sales.id, false);
  check((await deleteSharedNotes(owner, workspaceId, sales.id, "all")).length === 1 && (await auditOf("memory.note_deleted")).length === 1, "deleting a teamspace's notes is in the audit log");

  const hold = await setLegalHold(owner, workspaceId, { name: "Audit", reason: "", userIds: [owner] });
  const heldDelete = await deleteSharedNotes(owner, workspaceId, null, "all").catch((e) => e);
  check(heldDelete instanceof MemoryError && heldDelete.code === "held" && (await placeNotes(owner, workspaceId, null)).length === 2, "a legal hold keeps the notes its people wrote");
  await releaseLegalHold(owner, workspaceId, hold.id);

  await updateWorkspaceSettings(owner, workspaceId, { aiMemory: false });
  check((await sharedMemoryFor(alice, workspaceId, null)).workspace.length === 0, "with the workspace's memory off, its notes go nowhere");
  const offWrite = await writeSharedNote(owner, workspaceId, null, "More").catch((e) => e);
  check(offWrite instanceof MemoryError && offWrite.code === "off", "…and none is kept");
  request = await sent(alice, { workspaceId, message: "Hi" });
  check(tagged(request, "workspace_memory") === null && tagged(request, "account_memory") === null, "…nor the person's notes everywhere, in that workspace", question(request));
  check((await placeNotes(owner, workspaceId, null)).length === 2, "the notes stay");

  console.log(`\n${passed} checks passed`);
} finally {
  resetAi();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWs]));
  await db.delete(user).where(inArray(user.id, userIds));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
