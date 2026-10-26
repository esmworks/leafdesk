import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, page, uniqueValue } from "@/db/schema";
import { PropertyValueError } from "@/lib/properties";
import { canBeUnique, repeatedValues } from "@/lib/unique-values";

/**
 * Properties that keep their values unique (lib/unique-values): Postgres refuses a second row with
 * the same value (drizzle/0149_unique_values.sql), whichever way it is written. This turns that
 * refusal into a PropertyValueError naming the property, and checks a property's rows before the
 * rule is turned on.
 */

type DbError = { code?: string; constraint_name?: string; detail?: string; cause?: DbError };

type Violation = { propertyId: string; key: string; hashed?: boolean };

/**
 * The property and folded value of a write Postgres refused as a second row with that value. The
 * triggers name the value ("Key (property_id, key)=(<id>, <key>) already exists."); the index
 * itself, which a write racing another one can still reach, names only its hash
 * ("Key (property_id, md5(key))=(<id>, <hash>) …", `hashed`). Ids hold no ", ".
 */
export function uniqueViolation(error: unknown): Violation | null {
  for (let e = error as DbError | undefined, depth = 0; e && depth < 3; e = e.cause, depth++) {
    if (e.code !== "23505" || e.constraint_name !== "unique_value_key_idx") continue;
    const match = /^Key \((.*?)\)=\((.*?), (.*)\) already exists/s.exec(e.detail ?? "");
    if (!match) return { propertyId: "", key: "" };
    return match[1].includes("md5(") ? { propertyId: match[2], key: match[3], hashed: true } : { propertyId: match[2], key: match[3] };
  }
  return null;
}

/** The error to give for a write another row's value refused. */
export async function notUniqueError(violation: Violation) {
  const [prop] = violation.propertyId
    ? await db.select({ name: databaseProperty.name }).from(databaseProperty).where(eq(databaseProperty.id, violation.propertyId))
    : [];
  const name = prop?.name ?? "";
  let key = violation.key;
  if (violation.hashed) {
    // The value whose hash it is, as the row that won stored it.
    const [held] = await db
      .select({ key: uniqueValue.key })
      .from(uniqueValue)
      .where(and(eq(uniqueValue.propertyId, violation.propertyId), sql`md5(${uniqueValue.key}) = ${violation.key}`))
      .limit(1);
    key = held?.key ?? "";
  }
  return new PropertyValueError(`"${name}" keeps its values unique: another row already has "${key}"`, "notUnique", {
    property: name,
    value: key,
    propertyId: violation.propertyId,
  });
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

/** Values looked up per query when a batch is checked. */
const LOOKUP_CHUNK = 5000;

/**
 * Before a batch of row writes (a paste, an import, a sync run): leaves out each value a unique
 * property would refuse, because another row holds it or an earlier row of the batch takes it (see
 * lib/unique-values repeatedValues), and counts it in `invalid` like any other value that can't go
 * in, so the batch doesn't stop partway. `rows` are in the order they are written (`rowId` for a
 * row already there) and lose those values in place. Postgres still has the last word: a value
 * another write takes meanwhile is refused when written (withUniqueValues).
 */
export async function dropRepeatedValues(
  databaseId: string,
  rows: { rowId?: string; properties: Record<string, unknown> }[],
  invalid: Map<string, number>,
) {
  if (!rows.length) return;
  const props = (
    await db
      .select({ id: databaseProperty.id, type: databaseProperty.type })
      .from(databaseProperty)
      .where(
        and(eq(databaseProperty.databaseId, databaseId), isNull(databaseProperty.deletedAt), sql`${databaseProperty.options} -> 'unique' = 'true'::jsonb`),
      )
  ).filter((p) => canBeUnique(p.type) && rows.some((row) => p.id in row.properties));
  if (!props.length) return;
  // Each value's key as Postgres folds it (unique_value_key), and the row that holds it already.
  const values: { row: number; rowId?: string; propertyId: string; key: string | null }[] = [];
  const taken: { rowId: string; propertyId: string; key: string }[] = [];
  for (const prop of props) {
    const batch = rows.flatMap((row, i) => (prop.id in row.properties ? [{ row: i, value: row.properties[prop.id] ?? null }] : []));
    for (let start = 0; start < batch.length; start += LOOKUP_CHUNK) {
      const chunk = batch.slice(start, start + LOOKUP_CHUNK);
      // Joined by the key's hash, as unique_value_key_idx holds it.
      const found = await db.execute<{ ord: string | number; key: string | null; held_by: string | null }>(sql`
        select v.ord, v.key, u.row_id as held_by
        from (
          select e.ord, unique_value_key(${prop.type}::text, e.value) as key
          from jsonb_array_elements(${JSON.stringify(chunk.map((c) => c.value))}::jsonb) with ordinality as e(value, ord)
        ) v
        left join ${uniqueValue} u on u.property_id = ${prop.id} and md5(u.key) = md5(v.key) and u.key = v.key
      `);
      for (const f of found) {
        const { row } = chunk[Number(f.ord) - 1];
        values.push({ row, rowId: rows[row].rowId, propertyId: prop.id, key: f.key });
        if (f.held_by && f.key !== null) taken.push({ rowId: f.held_by, propertyId: prop.id, key: f.key });
      }
    }
  }
  for (const { row, propertyId } of repeatedValues(values, taken)) {
    delete rows[row].properties[propertyId];
    invalid.set(propertyId, (invalid.get(propertyId) ?? 0) + 1);
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
