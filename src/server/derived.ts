import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, page } from "@/db/schema";
import { compileFormulas, evaluateFormulas, formulasNeedLookups, withFormulaTypes, type FormulaContext } from "@/lib/derived";
import { computedValues } from "@/lib/properties";
import { holdsPeople, isComputed, isDerived } from "@/lib/property-types";
import { resolveRollup, rollupError, rollupRelation, rollupValue, type RelatedRow } from "@/lib/rollup";
import { pageVisibleTo } from "@/server/access";

type Property = typeof databaseProperty.$inferSelect;

/** Names of people and titles of related rows, as the viewer may see them (see databases.getLookups). */
export type FormulaLookups = Pick<FormulaContext, "people" | "relations">;

export type DerivedOptions = {
  /** Loads the names and titles formulas of these properties' database may show. */
  lookups: (properties: Property[]) => Promise<FormulaLookups>;
  /**
   * Who is reading: rollups only count the related rows they may see. Null leaves rollups out
   * (published pages, which show no relations).
   */
  viewerId: string | null;
  /** What `now()` and `today()` see; one instant for the whole read. */
  now?: Date;
  /** How many rollups deep this read is (a rollup of a rollup of…); see MAX_ROLLUP_DEPTH. */
  depth?: number;
  /**
   * The viewer's access to the properties of a related database (see server/property-access):
   * rollups only read what the viewer may see there. Without it rollups read every value.
   */
  accessFor?: (databaseId: string, properties: Property[]) => Promise<RelatedAccess>;
};

/** What rollups need of a viewer's access to a related database's properties. */
export type RelatedAccess = {
  levelOf(propertyId: string): string;
  strip<R extends { properties: Record<string, unknown> }>(rows: R[]): R[];
  finish<R extends { properties: Record<string, unknown> }>(rows: R[]): R[];
};

/**
 * How deep rollups of rollups (or of formulas using rollups) go before they stop with an error:
 * each level is one more batch of queries, and a loop between databases would never end.
 */
const MAX_ROLLUP_DEPTH = 3;

/** Postgres takes at most 65535 parameters per query. */
const ID_CHUNK = 10_000;

/**
 * Rows with their derived values filled in: every rollup, then every formula (formulas may use
 * rollups), each worked out once per row. Rows must already carry their stored and system values
 * (who and when). Formulas that show people or related rows get their names and titles from
 * `lookups`, loaded only when one needs them.
 */
export async function computeDerived<R extends { title: string; properties: Record<string, unknown> }>(
  rows: R[],
  properties: Property[],
  options: DerivedOptions,
): Promise<R[]> {
  if (!rows.length || !properties.some((p) => isDerived(p.type))) return rows;
  const withRollups = properties.some((p) => p.type === "rollup") ? await computeRollups(rows, properties, options) : rows;
  if (!properties.some((p) => p.type === "formula")) return withRollups;
  const lookups = formulasNeedLookups(properties) ? await options.lookups(properties) : {};
  const compiled = compileFormulas(properties);
  const context: FormulaContext = { now: options.now ?? new Date(), ...lookups };
  return withRollups.map((row) => ({
    ...row,
    properties: { ...row.properties, ...evaluateFormulas(properties, compiled, row, context) },
  }));
}

/**
 * The properties of these databases in order, formula result types filled in, by database id.
 * Deleted properties are left out: formulas and rollups that read one fail as for a missing one.
 */
export async function loadProperties(databaseIds: string[]): Promise<Map<string, Property[]>> {
  const out = new Map<string, Property[]>();
  if (!databaseIds.length) return out;
  const rows = await db
    .select()
    .from(databaseProperty)
    .where(and(inArray(databaseProperty.databaseId, databaseIds), isNull(databaseProperty.deletedAt)))
    .orderBy(asc(databaseProperty.position), asc(databaseProperty.createdAt));
  for (const prop of rows) out.set(prop.databaseId, [...(out.get(prop.databaseId) ?? []), prop]);
  for (const [id, props] of out) out.set(id, withFormulaTypes(props));
  return out;
}

const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Every rollup of every row. The related rows of all rows and rollups load at once (plus the
 * related databases and their properties): a fixed number of queries whatever the row count.
 * Only related rows the viewer may see count; rows of a database they can't see don't either.
 */
async function computeRollups<R extends { title: string; properties: Record<string, unknown> }>(
  rows: R[],
  properties: Property[],
  options: DerivedOptions,
): Promise<R[]> {
  const rollups = properties.filter((p) => p.type === "rollup");
  const { viewerId } = options;
  // Published pages show no relations, so no rollups either.
  if (!viewerId) return rows;
  const depth = options.depth ?? 0;
  if (depth >= MAX_ROLLUP_DEPTH) {
    const error = rollupError("rollupDepth", "Rollups of rollups go too deep here");
    const errors = Object.fromEntries(rollups.map((r) => [r.id, error]));
    return rows.map((row) => ({ ...row, properties: { ...row.properties, ...errors } }));
  }

  const relations = new Map<string, Property>();
  for (const rollup of rollups) {
    const relation = rollupRelation(rollup, properties);
    if (relation) relations.set(relation.id, relation as Property);
  }
  const databaseIds = [...new Set([...relations.values()].map((r) => r.options.relation!.databaseId))];
  const relatedIds = [...new Set(rows.flatMap((row) => [...relations.keys()].flatMap((id) => asIds(row.properties[id]))))];

  const [visibleDatabases, targetProperties, relatedRows] = databaseIds.length
    ? await Promise.all([
        db
          .select({ id: page.id })
          .from(page)
          .where(and(inArray(page.id, databaseIds), eq(page.kind, "database"), isNull(page.archivedAt), pageVisibleTo(viewerId))),
        loadProperties(databaseIds),
        loadRelatedRows(viewerId, databaseIds, relatedIds),
      ])
    : [[], new Map<string, Property[]>(), []];
  const visible = new Set(visibleDatabases.map((d) => d.id));

  // The related rows of each database, with their values worked out as far as the rollups need.
  const related = new Map<string, Map<string, RelatedRow>>();
  const contexts = new Map<string, FormulaContext>();
  // Rollups over a property the viewer may not see the values of show nothing.
  const blocked = new Set<string>();
  const now = options.now ?? new Date();
  for (const databaseId of visible) {
    const props = targetProperties.get(databaseId) ?? [];
    const readers = rollups.filter(
      (r) => relations.get(r.options.rollup!.relationPropertyId)?.options.relation?.databaseId === databaseId,
    );
    const targets = readers.flatMap((r) => props.filter((p) => p.id === r.options.rollup!.targetPropertyId));
    // System values (who and when) too: a target may be one, or a formula using one.
    const system = props.some((p) => isComputed(p.type));
    const access = options.accessFor ? await options.accessFor(databaseId, props) : null;
    for (const t of targets) if (access && !["view", "edit_values", "edit"].includes(access.levelOf(t.id))) blocked.add(t.id);
    let own = relatedRows
      .filter((row) => row.parentId === databaseId)
      .map(({ createdBy, updatedBy, ...row }) =>
        system ? { ...row, properties: { ...row.properties, ...computedValues(props, { createdBy, updatedBy, ...row }) } } : row,
      );
    if (access) own = access.strip(own);
    if (targets.some((t) => isDerived(t.type))) {
      own = await computeDerived(own, props, { ...options, now, depth: depth + 1 });
    }
    if (access) own = access.finish(own);
    related.set(databaseId, new Map(own.map((row) => [row.id, row])));
    // Showing people or linked rows by name needs their names, as the viewer may see them.
    const named = readers.some(
      (r) => r.options.rollup!.function === "show_original" && targets.some((t) => t.type === "relation" || holdsPeople(t.type)),
    );
    contexts.set(databaseId, { now, ...(named ? await options.lookups(props) : {}) });
  }

  const resolved = rollups.map((rollup) => {
    const databaseId = relations.get(rollup.options.rollup?.relationPropertyId ?? "")?.options.relation?.databaseId;
    const props = databaseId && visible.has(databaseId) ? targetProperties.get(databaseId) ?? [] : undefined;
    return { rollup, databaseId, run: resolveRollup(rollup, properties, props) };
  });
  const none = new Map<string, RelatedRow>();
  return rows.map((row) => {
    const values: Record<string, unknown> = {};
    for (const { rollup, databaseId, run } of resolved) {
      if ("error" in run) {
        values[rollup.id] = run;
        continue;
      }
      if (blocked.has(rollup.options.rollup!.targetPropertyId)) continue;
      const rowsOf = (databaseId && related.get(databaseId)) || none;
      values[rollup.id] = rollupValue(run, row.properties[run.relation.id], rowsOf, contexts.get(databaseId ?? "") ?? { now });
    }
    return { ...row, properties: { ...row.properties, ...values } };
  });
}

/** Live rows among `ids` in these databases that the viewer may see, in chunks of ids. */
async function loadRelatedRows(viewerId: string, databaseIds: string[], ids: string[]) {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) =>
      db
        .select({
          id: page.id,
          parentId: page.parentId,
          title: page.title,
          properties: page.properties,
          createdBy: page.createdBy,
          updatedBy: page.updatedBy,
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
        })
        .from(page)
        .where(
          and(inArray(page.id, chunk), inArray(page.parentId, databaseIds), isNull(page.archivedAt), pageVisibleTo(viewerId)),
        ),
    ),
  );
  return results.flat();
}
