/**
 * Snippets (lib/snippets.ts): reusable pieces of content people insert into a page while typing.
 *
 * - Personal snippets belong to one person: only they see, use and change them, in every
 *   workspace they work in. They go when the person's account does.
 * - Workspace snippets are shared: the workspace's owners and members use them (guests don't,
 *   as they don't see the workspace's other shared things), and only owners create, change and
 *   delete them, like the workspace's other settings. Access is checked on every read, so someone
 *   who leaves the workspace or becomes a guest stops getting them at once. They go with the
 *   workspace, and its backups hold them.
 * - Every rule is checked here, whatever the client sent: the trigger's form and its uniqueness in
 *   its scope (a unique index too), title and body length, and MAX_SNIPPETS per scope (counted
 *   under a lock, so two requests at once can't pass it).
 */
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { snippet, workspace } from "@/db/schema";
import {
  checkSnippetInput,
  MAX_SNIPPET_TITLE,
  MAX_SNIPPET_TRIGGER,
  MAX_SNIPPETS,
  parseSnippetImport,
  snippetExport,
  SnippetError,
  type SkippedSnippet,
  type SnippetExport,
  type SnippetInput,
  type SnippetScope,
  type SnippetSummary,
  type SnippetView,
} from "@/lib/snippets";
import { getMembership, isGuest, requireMember } from "@/server/access";

export { SnippetError } from "@/lib/snippets";

/** Whose snippets: the person's own, or a workspace's. */
export type SnippetOwner = { kind: "personal" } | { kind: "workspace"; workspaceId: string };

type Row = typeof snippet.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const isUniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505";

const scopeOf = (row: Row): SnippetScope => (row.workspaceId ? "workspace" : "personal");

const summary = (row: Row): SnippetSummary => ({
  id: row.id,
  scope: scopeOf(row),
  trigger: row.trigger,
  title: row.title,
  updatedAt: row.updatedAt.toISOString(),
});

const view = (row: Row): SnippetView => ({ ...summary(row), body: row.body });

/** The rows of a scope, in the SQL `where` form. */
function scopeWhere(userId: string, owner: SnippetOwner) {
  return owner.kind === "personal" ? eq(snippet.userId, userId) : eq(snippet.workspaceId, owner.workspaceId);
}

/** May the person see the scope's snippets? Throws AccessError when not. */
async function requireReader(userId: string, owner: SnippetOwner) {
  if (owner.kind === "workspace") await requireMember(userId, String(owner.workspaceId));
}

/** May the person change the scope's snippets? Members get "ownersOnly", outsiders AccessError. */
async function requireManager(userId: string, owner: SnippetOwner) {
  if (owner.kind === "personal") return;
  const membership = await requireMember(userId, String(owner.workspaceId));
  if (membership.role !== "owner") throw new SnippetError("ownersOnly", "Only the workspace's owners change its snippets");
}

const ownerOf = (row: Row): SnippetOwner => (row.workspaceId ? { kind: "workspace", workspaceId: row.workspaceId } : { kind: "personal" });

/** A snippet the person may see; notFound for one they may not (a personal one of someone else). */
async function readable(userId: string, id: string): Promise<Row> {
  const [row] = await db.select().from(snippet).where(eq(snippet.id, String(id))).limit(1);
  if (!row || (row.userId && row.userId !== userId)) throw new SnippetError("notFound", "No such snippet");
  if (row.workspaceId) await requireReader(userId, ownerOf(row));
  return row;
}

async function manageable(userId: string, id: string): Promise<Row> {
  const row = await readable(userId, id);
  await requireManager(userId, ownerOf(row));
  return row;
}

/** Holds the scope's lock for the rest of the transaction: its count stays what was read. */
async function lockScope(tx: Tx, userId: string, owner: SnippetOwner) {
  const key = owner.kind === "personal" ? `user:${userId}` : `workspace:${owner.workspaceId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:snippets:${key}`}))`);
}

async function countIn(tx: Tx, userId: string, owner: SnippetOwner) {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(snippet).where(scopeWhere(userId, owner));
  return row?.n ?? 0;
}

const scopeColumns = (userId: string, owner: SnippetOwner) =>
  owner.kind === "personal" ? { userId, workspaceId: null } : { userId: null, workspaceId: owner.workspaceId };

/** The scope's snippets, by trigger, for settings. */
export async function listSnippets(userId: string, owner: SnippetOwner): Promise<SnippetView[]> {
  await requireReader(userId, owner);
  const rows = await db.select().from(snippet).where(scopeWhere(userId, owner)).orderBy(asc(snippet.trigger));
  return rows.map(view);
}

/**
 * What the person can insert in the workspace's pages: their personal snippets and, for an owner
 * or member, the workspace's. A trigger both have is offered twice (each says where it is from).
 * `manages`: the workspace, when they may save new ones to it (they own it).
 */
export async function usableSnippets(
  userId: string,
  workspaceId: string,
): Promise<{ snippets: SnippetSummary[]; manages: { id: string; name: string } | null }> {
  const membership = await getMembership(userId, String(workspaceId));
  const shared = Boolean(membership && !isGuest(membership.role));
  const rows = await db
    .select()
    .from(snippet)
    .where(shared ? sql`(${snippet.userId} = ${userId} or ${snippet.workspaceId} = ${String(workspaceId)})` : eq(snippet.userId, userId))
    .orderBy(asc(snippet.trigger));
  let manages: { id: string; name: string } | null = null;
  if (membership?.role === "owner") {
    const [ws] = await db.select({ id: workspace.id, name: workspace.name }).from(workspace).where(eq(workspace.id, String(workspaceId))).limit(1);
    manages = ws ?? null;
  }
  return { snippets: rows.map(summary), manages };
}

/** One snippet with its body, to insert it. */
export async function getSnippet(userId: string, id: string): Promise<SnippetView> {
  return view(await readable(userId, id));
}

export async function createSnippet(userId: string, owner: SnippetOwner, input: Partial<SnippetInput>): Promise<SnippetView> {
  await requireManager(userId, owner);
  const clean = checkSnippetInput(input);
  try {
    return await db.transaction(async (tx) => {
      await lockScope(tx, userId, owner);
      if ((await countIn(tx, userId, owner)) >= MAX_SNIPPETS) throw new SnippetError("tooMany", `Up to ${MAX_SNIPPETS} snippets`);
      const [row] = await tx
        .insert(snippet)
        .values({ ...scopeColumns(userId, owner), ...clean, createdBy: userId })
        .returning();
      return view(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new SnippetError("triggerTaken", `Another snippet already has the trigger "${clean.trigger}"`);
    throw error;
  }
}

export async function updateSnippet(userId: string, id: string, input: Partial<SnippetInput>): Promise<SnippetView> {
  const row = await manageable(userId, id);
  const clean = checkSnippetInput(input);
  try {
    const [updated] = await db.update(snippet).set(clean).where(eq(snippet.id, row.id)).returning();
    if (!updated) throw new SnippetError("notFound", "No such snippet");
    return view(updated);
  } catch (error) {
    if (isUniqueViolation(error)) throw new SnippetError("triggerTaken", `Another snippet already has the trigger "${clean.trigger}"`);
    throw error;
  }
}

/** A copy next to it, under the first free trigger "<trigger>-2", "-3"… and the title `copyTitle` gives. */
export async function duplicateSnippet(userId: string, id: string, copyTitle: (title: string) => string): Promise<SnippetView> {
  const row = await manageable(userId, id);
  const owner = ownerOf(row);
  return db.transaction(async (tx) => {
    await lockScope(tx, userId, owner);
    if ((await countIn(tx, userId, owner)) >= MAX_SNIPPETS) throw new SnippetError("tooMany", `Up to ${MAX_SNIPPETS} snippets`);
    const taken = new Set(
      (await tx.select({ trigger: snippet.trigger }).from(snippet).where(scopeWhere(userId, owner))).map((r) => r.trigger),
    );
    const base = row.trigger.replace(/-\d+$/, "");
    let trigger = "";
    for (let n = 2; !trigger || taken.has(trigger); n++) {
      const suffix = `-${n}`;
      trigger = `${base.slice(0, MAX_SNIPPET_TRIGGER - suffix.length)}${suffix}`;
    }
    const clean = checkSnippetInput({ trigger, title: copyTitle(row.title).slice(0, MAX_SNIPPET_TITLE), body: row.body });
    const [copy] = await tx
      .insert(snippet)
      .values({ ...scopeColumns(userId, owner), ...clean, createdBy: userId })
      .returning();
    return view(copy);
  });
}

export async function deleteSnippet(userId: string, id: string): Promise<void> {
  const row = await manageable(userId, id);
  await db.delete(snippet).where(eq(snippet.id, row.id));
}

/**
 * Adds the snippets of an import file (lib/snippets parseSnippetImport) to the scope. Triggers the
 * scope already has are skipped, not overwritten, and so is everything past MAX_SNIPPETS; each
 * skipped one comes back with why.
 */
export async function importSnippets(
  userId: string,
  owner: SnippetOwner,
  text: string,
): Promise<{ added: SnippetView[]; skipped: SkippedSnippet[] }> {
  await requireManager(userId, owner);
  const parsed = parseSnippetImport(text);
  return db.transaction(async (tx) => {
    await lockScope(tx, userId, owner);
    const existing = await tx.select({ trigger: snippet.trigger }).from(snippet).where(scopeWhere(userId, owner));
    const taken = new Set(existing.map((r) => r.trigger));
    let room = MAX_SNIPPETS - existing.length;
    const skipped = [...parsed.skipped];
    const fresh: SnippetInput[] = [];
    for (const item of parsed.snippets) {
      if (taken.has(item.trigger)) skipped.push({ trigger: item.trigger, reason: "exists" });
      else if (room <= 0) skipped.push({ trigger: item.trigger, reason: "tooMany" });
      else {
        fresh.push(item);
        room--;
      }
    }
    const added = fresh.length
      ? await tx
          .insert(snippet)
          .values(fresh.map((item) => ({ ...scopeColumns(userId, owner), ...item, createdBy: userId })))
          .returning()
      : [];
    return { added: added.map(view), skipped };
  });
}

/** The scope's snippets as an export file (lib/snippets snippetExport). */
export async function exportSnippets(userId: string, owner: SnippetOwner): Promise<SnippetExport> {
  return snippetExport(await listSnippets(userId, owner));
}

/**
 * For AI clients (MCP list_snippets): the person's snippets and those of the given workspaces
 * where they are an owner or member, with their bodies.
 */
export async function snippetsForWorkspaces(
  userId: string,
  workspaceIds: string[],
): Promise<(SnippetView & { workspaceId: string | null })[]> {
  const shared: string[] = [];
  for (const id of workspaceIds) {
    const membership = await getMembership(userId, id).catch(() => null);
    if (membership && !isGuest(membership.role)) shared.push(id);
  }
  const rows = await db
    .select()
    .from(snippet)
    .where(shared.length ? sql`(${snippet.userId} = ${userId} or ${inArray(snippet.workspaceId, shared)})` : eq(snippet.userId, userId))
    .orderBy(asc(snippet.trigger));
  return rows.map((row) => ({ ...view(row), workspaceId: row.workspaceId }));
}

