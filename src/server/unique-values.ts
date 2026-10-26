import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, page } from "@/db/schema";
import { PropertyValueError } from "@/lib/properties";
import { canBeUnique } from "@/lib/unique-values";

/**
 * Properties that keep their values unique (lib/unique-values): Postgres refuses a second row with
 * the same value (drizzle/0149_unique_values.sql), whichever way it is written. This turns that
 * refusal into a PropertyValueError naming the property, and checks a property's rows before the
 * rule is turned on.
 */

type DbError = { code?: string; constraint_name?: string; detail?: string; cause?: DbError };

/** The property and folded value of a write Postgres refused as a second row with that value. */
export function uniqueViolation(error: unknown): { propertyId: string; key: string } | null {
  for (let e = error as DbError | undefined, depth = 0; e && depth < 3; e = e.cause, depth++) {
    if (e.code !== "23505" || e.constraint_name !== "unique_value_key_idx") continue;
    // "Key (property_id, key)=(<id>, <key>) already exists." Ids hold no ", ".
    const match = /=\((.*?), (.*)\) already exists/s.exec(e.detail ?? "");
    return match ? { propertyId: match[1], key: match[2] } : { propertyId: "", key: "" };
  }
  return null;
}

/** The error to give for a write another row's value refused. */
export async function notUniqueError(violation: { propertyId: string; key: string }) {
  const [prop] = violation.propertyId
    ? await db.select({ name: databaseProperty.name }).from(databaseProperty).where(eq(databaseProperty.id, violation.propertyId))
    : [];
  const name = prop?.name ?? "";
  return new PropertyValueError(
    `"${name}" keeps its values unique: another row already has "${violation.key}"`,
    "notUnique",
    { property: name, value: violation.key, propertyId: violation.propertyId },
  );
}

/** Runs a row write, giving a PropertyValueError when a unique property refused it. */
export async function withUniqueValues<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const violation = uniqueViolation(error);
    if (violation) throw await notUniqueError(violation);
    throw error;
  }
}

/** Ids of the database's properties that keep their values unique. */
export async function uniquePropertyIds(databaseId: string, exec: Pick<typeof db, "select"> = db): Promise<string[]> {
  const rows = await exec
    .select({ id: databaseProperty.id })
    .from(databaseProperty)
    .where(
      and(eq(databaseProperty.databaseId, databaseId), isNull(databaseProperty.deletedAt), sql`${databaseProperty.options} -> 'unique' = 'true'::jsonb`),
    );
  return rows.map((r) => r.id);
}

/** One value two or more live rows of the property's database share, and how many such values there are. */
export async function sharedValue(
  prop: { id: string; databaseId: string; type: string },
  exec: Pick<typeof db, "execute"> = db,
): Promise<{ key: string; total: number } | null> {
  const repeated = await exec.execute<{ key: string; total: number }>(sql`
    select k.key, count(*) over () as total
    from ${page} p, lateral (select unique_value_key(${prop.type}, p.properties -> ${prop.id}::text) as key) k
    where p.parent_id = ${prop.databaseId} and p.archived_at is null and not p.is_template and p.kind = 'page' and k.key is not null
    group by k.key
    having count(*) > 1
    order by k.key
    limit 1
  `);
  return repeated[0] ? { key: repeated[0].key, total: Number(repeated[0].total) } : null;
}

/**
 * Before the rule is turned on: refuses when two live rows hold the same value, naming one such
 * value and how many values appear more than once, so the person can tidy them first.
 */
export async function requireNoDuplicates(prop: { id: string; databaseId: string; name: string; type: string }) {
  if (!canBeUnique(prop.type)) {
    throw new PropertyValueError(`"${prop.name}" is a ${prop.type} property; only text, numbers, emails, URLs and phone numbers keep their values unique`, "unsupportedType", {
      type: prop.type,
    });
  }
  const shared = await sharedValue(prop);
  if (!shared) return;
  throw new PropertyValueError(
    `"${prop.name}" can't keep its values unique: ${shared.total} values appear in more than one row, such as "${shared.key}"`,
    "duplicateValues",
    { property: prop.name, count: String(shared.total), value: shared.key },
  );
}
