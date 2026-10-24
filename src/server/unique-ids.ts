import { sql } from "drizzle-orm";
import type { db } from "@/db";
import type { PropertyOptions } from "@/db/schema";
import { PropertyValueError } from "@/lib/properties";
import { cleanUniqueIdPrefix, MAX_UNIQUE_ID_PREFIX } from "@/lib/unique-id";

/**
 * Unique ID properties (lib/unique-id), as the app sets them up: one per database, each with a
 * prefix no other database of the workspace has, so "TASK-12" names one row. Postgres numbers the
 * rows (drizzle/*_unique_id.sql); this is only about the properties.
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A prefix as given for a unique ID property, as stored (null for none); refuses one that can't be one. */
export function checkedPrefix(input: unknown): string | null {
  const prefix = cleanUniqueIdPrefix(input);
  if (prefix === undefined) {
    throw new PropertyValueError(
      `An ID prefix is up to ${MAX_UNIQUE_ID_PREFIX} letters (A-Z) and digits, like "TASK"`,
      "invalidUniqueIdPrefix",
      { max: String(MAX_UNIQUE_ID_PREFIX) },
    );
  }
  return prefix;
}

/** Refuses a second unique ID property in a database (one in its trash doesn't count until restored). */
export async function refuseSecondUniqueId(exec: Executor, databaseId: string, exceptId?: string) {
  const [taken] = await exec.execute<{ name: string }>(sql`
    select name from database_property
    where database_id = ${databaseId} and type = 'unique_id' and deleted_at is null and id <> ${exceptId ?? ""}
    limit 1`);
  if (taken) {
    throw new PropertyValueError(`This database already numbers its rows in "${taken.name}"`, "oneUniqueId", { property: taken.name });
  }
}

/**
 * Whether another unique ID property of the workspace has `prefix`: in any database but templates
 * (copies of them get their own), counting those in the trash, which may come back.
 */
async function prefixTaken(exec: Executor, workspaceId: string, prefix: string, exceptId?: string) {
  const rows = await exec.execute(sql`
    select 1 from database_property dp
    join page d on d.id = dp.database_id
    where d.workspace_id = ${workspaceId} and not d.in_template and dp.type = 'unique_id' and dp.id <> ${exceptId ?? ""}
      and upper(dp.options -> 'uniqueId' ->> 'prefix') = ${prefix}
    limit 1`);
  return rows.length > 0;
}

/** Waits for other changes to the workspace's prefixes, until the transaction ends. */
async function lockPrefixes(exec: Executor, workspaceId: string) {
  await exec.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`unique-id-prefix:${workspaceId}`}, 0))`);
}

/**
 * Refuses `prefix` when another database of the workspace has it; call it in the transaction that
 * stores it, which then holds the workspace's prefixes until it ends.
 */
export async function claimPrefix(exec: Executor, workspaceId: string, prefix: string | null, exceptId?: string) {
  if (!prefix) return;
  await lockPrefixes(exec, workspaceId);
  if (await prefixTaken(exec, workspaceId, prefix, exceptId)) {
    throw new PropertyValueError(`Another database of this workspace already uses the ID prefix "${prefix}"`, "uniqueIdPrefixTaken", { prefix });
  }
}

/**
 * Copies of unique ID properties (a duplicated database, a template used, a published page copied)
 * with their prefix only where it is still free: a copy outside the templates of a database the
 * workspace has goes without, and its rows' IDs show as plain numbers until someone gives it one.
 */
export async function freeCopiedPrefixes<P extends { id: string; databaseId: string; type: string; options: PropertyOptions }>(
  exec: Executor,
  workspaceId: string,
  props: P[],
  inTemplate: (databaseId: string) => boolean,
): Promise<P[]> {
  if (!props.some((p) => p.type === "unique_id" && p.options.uniqueId?.prefix && !inTemplate(p.databaseId))) return props;
  await lockPrefixes(exec, workspaceId);
  const out: P[] = [];
  // Two templates may share a prefix; copies of both don't.
  const kept = new Set<string>();
  for (const p of props) {
    const prefix = p.type === "unique_id" && !inTemplate(p.databaseId) ? p.options.uniqueId?.prefix : undefined;
    if (prefix && (kept.has(prefix) || (await prefixTaken(exec, workspaceId, prefix, p.id)))) {
      const { uniqueId: _taken, ...options } = p.options;
      out.push({ ...p, options });
    } else {
      if (prefix) kept.add(prefix);
      out.push(p);
    }
  }
  return out;
}
