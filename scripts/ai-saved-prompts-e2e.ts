/**
 * End-to-end check of the AI assistant's saved prompts: each person keeps their own per
 * workspace, within the limits; nobody else lists, renames or deletes them, and people outside the
 * workspace can't save any there.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/ai-saved-prompts-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. No server needed.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { user, workspace, workspaceMember } = await import("@/db/schema");
const { MAX_SAVED_PROMPTS } = await import("@/lib/ai-saved-prompts");
const { AccessError } = await import("@/server/access");
const prompts = await import("@/server/ai-saved-prompts");

const RUN = `ai-saved-prompts-e2e-${Date.now().toString(36)}`;

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
    if (error instanceof AccessError) return "access";
    if (error instanceof prompts.SavedPromptError) return error.code;
    throw error;
  }
}

const ids = { ada: `${RUN}-ada`, bob: `${RUN}-bob`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.ada, role: "owner" },
    { workspaceId, userId: ids.bob, role: "member" },
    { workspaceId: otherWorkspace, userId: ids.ada, role: "owner" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);

  const tone = await prompts.savePrompt(ids.ada, workspaceId, { name: "  Friendly\n tone ", prompt: "  Make this friendlier and shorter.  " });
  check(tone.name === "Friendly tone" && tone.prompt === "Make this friendlier and shorter.", "a prompt is saved with its name on one line", tone);
  check((await prompts.listSavedPrompts(ids.ada, workspaceId)).map((p) => p.id).join() === tone.id, "…and listed for its person");
  check((await prompts.listSavedPrompts(ids.bob, workspaceId)).length === 0, "others in the workspace don't see it");
  check((await prompts.listSavedPrompts(ids.ada, otherWorkspace)).length === 0, "…nor does its person in another workspace");
  check((await failure(() => prompts.savePrompt(ids.outsider, workspaceId, { name: "x", prompt: "y" }))) === "access", "people outside the workspace can't save prompts there");
  check((await failure(() => prompts.listSavedPrompts(ids.outsider, workspaceId))) === "access", "…or list them");
  check((await failure(() => prompts.savePrompt(ids.ada, workspaceId, { name: "", prompt: "y" }))) === "emptyName", "a prompt needs a name");
  check((await failure(() => prompts.savePrompt(ids.ada, workspaceId, { name: "x", prompt: "  " }))) === "emptyPrompt", "…and an instruction");
  check((await failure(() => prompts.savePrompt(ids.ada, workspaceId, { name: "x", prompt: "y".repeat(1001) }))) === "promptTooLong", "…of at most 1000 characters");

  check((await failure(() => prompts.renameSavedPrompt(ids.bob, tone.id, { name: "Mine now" }))) === "notFound", "nobody else renames it");
  check((await failure(() => prompts.deleteSavedPrompt(ids.bob, tone.id))) === "notFound", "…or deletes it");
  const renamed = await prompts.renameSavedPrompt(ids.ada, tone.id, { name: "Warmer" });
  check(renamed.name === "Warmer" && renamed.prompt === tone.prompt, "its person renames it", renamed);

  // The limit, also when saves come at once.
  await Promise.all(
    Array.from({ length: MAX_SAVED_PROMPTS + 5 }, (_, i) => failure(() => prompts.savePrompt(ids.ada, workspaceId, { name: `P${i}`, prompt: `Do ${i}` }))),
  );
  check((await prompts.listSavedPrompts(ids.ada, workspaceId)).length === MAX_SAVED_PROMPTS, `at most ${MAX_SAVED_PROMPTS} prompts are kept, even saved at once`);
  check((await failure(() => prompts.savePrompt(ids.ada, workspaceId, { name: "One more", prompt: "x" }))) === "full", "…and one more is refused");
  await prompts.deleteSavedPrompt(ids.ada, tone.id);
  check(!(await prompts.listSavedPrompts(ids.ada, workspaceId)).some((p) => p.id === tone.id), "its person deletes it");
  check((await failure(() => prompts.savePrompt(ids.ada, workspaceId, { name: "One more", prompt: "x" }))) === null, "…which makes room for another");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
