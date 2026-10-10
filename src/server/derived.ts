import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, page } from "@/db/schema";
import {
  compileFormulas,
  evaluateRow,
  formulasNeedLookups,
  mergeResults,
  relatedDatabases,
  relatedReadsOf,
  withFormulaTypes,
  type CompiledFormula,
  type FormulaContext,
  type RelatedDatabase,
  type RelatedSchemas,
  type WithResults,
} from "@/lib/derived";
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
  /**
   * Leaves out formulas that read related rows' properties: set when working out the related rows
   * such a formula reads (a formula reads one step away, never two).
   */
  skipRelated?: boolean;
};

/** What rollups and formulas need of a viewer's access to a related database's properties. */
export type RelatedAccess = {
  visible<P extends { id: string }>(properties: P[]): P[];
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
): Promise<(R & WithResults)[]> {
  if (!rows.length || !properties.some((p) => isDerived(p.type))) return rows;
  const withRollups = properties.some((p) => p.type === "rollup") ? await computeRollups(rows, properties, options) : rows;
  if (!properties.some((p) => p.type === "formula")) return withRollups;
  const now = options.now ?? new Date();
  const [lookups, relatedProps] = await Promise.all([
    formulasNeedLookups(properties) ? options.lookups(properties) : Promise.resolve({}),
    options.skipRelated ? Promise.resolve(new Map<string, Property[]>()) : loadProperties(relatedDatabases(properties)),
  ]);
  const compiled = compileFormulas(properties, (id) => relatedProps.get(id));
  // Without `related`, formulas reading related rows are left out (see evaluateRow).
  const related = options.skipRelated ? undefined : await loadRelated(withRollups, properties, compiled, relatedProps, { ...options, now });
  const context: FormulaContext = { now, ...lookups, ...(related ? { related } : {}) };
  return withRollups.map((row) => mergeResults(row, evaluateRow(properties, compiled, row, context), compiled));
}

/**
 * Properties of these databases in order, as stored (formula types not filled in), by database id.
 * Deleted properties are left out: formulas and rollups that read one fail as for a missing one.
 */
async function storedProperties(databaseIds: string[]): Promise<Map<string, Property[]>> {
  const out = new Map<string, Property[]>();
  if (!databaseIds.length) return out;
  const rows = await db
    .select()
    .from(databaseProperty)
    .where(and(inArray(databaseProperty.databaseId, databaseIds), isNull(databaseProperty.deletedAt)))
    .orderBy(asc(databaseProperty.position), asc(databaseProperty.createdAt));
  for (const prop of rows) out.set(prop.databaseId, [...(out.get(prop.databaseId) ?? []), prop]);
  return out;
}

/**
 * The schemas of the databases formulas of these properties read related rows of (see
 * lib/derived relatedDatabases): what checking and storing those formulas needs. `known`: schemas
 * already loaded.
 */
export async function relatedSchemasFor(lists: Property[][], known: Map<string, Property[]> = new Map()): Promise<RelatedSchemas> {
  const wanted = [...new Set(lists.flatMap((props) => relatedDatabases(props)))].filter((id) => !known.has(id));
  const loaded = await storedProperties(wanted);
  return (id) => known.get(id) ?? loaded.get(id);
}

/** Properties with formula result types filled in, formulas reading related rows typed from them too. */
export async function withAllFormulaTypes(properties: Property[]): Promise<Property[]> {
  if (!properties.some((p) => p.type === "formula")) return properties;
  return withFormulaTypes(properties, await relatedSchemasFor([properties]));
}

/** The properties of these databases in order, formula result types filled in, by database id. */
export async function loadProperties(databaseIds: string[]): Promise<Map<string, Property[]>> {
  const out = await storedProperties(databaseIds);
  if (!out.size) return out;
  const related = await relatedSchemasFor([...out.values()], out);
  for (const [id, props] of out) out.set(id, withFormulaTypes(props, related));
  return out;
}

/**
 * The related rows formulas read properties of (`prop(row, "…")`), by database: rows linked from
 * `rows` that the viewer may see, in databases they may see, with the values they may see there.
 * Values left out by that database's property access are listed per row (and formulas reading
 * them hide, see lib/derived); values of derived properties read are worked out first. A fixed
 * number of queries per related database, whatever the row count.
 */
async function loadRelated(
  rows: { properties: Record<string, unknown> }[],
  properties: Property[],
  compiled: Map<string, CompiledFormula>,
  relatedProps: Map<string, Property[]>,
  options: DerivedOptions & { now: Date },
): Promise<Map<string, RelatedDatabase>> {
  const out = new Map<string, RelatedDatabase>();
  const reads = relatedReadsOf(compiled);
  const { viewerId } = options;
  // Published pages show no relations: formulas have no related rows to read there.
  if (!reads.size || !viewerId) return out;
  const databaseIds = [...reads.keys()];
  const relations = properties.filter((p) => p.type === "relation" && reads.has(p.options.relation?.databaseId ?? ""));
  const linked = [...new Set(rows.flatMap((row) => relations.flatMap((r) => asIds(row.properties[r.id]))))];
  const [visibleDatabases, loaded] = await Promise.all([
    db
      .select({ id: page.id })
      .from(page)
      .where(and(inArray(page.id, databaseIds), eq(page.kind, "database"), isNull(page.archivedAt), pageVisibleTo(viewerId))),
    linked.length ? loadRelatedRows(viewerId, databaseIds, linked) : Promise.resolve([]),
  ]);
  for (const { id: databaseId } of visibleDatabases) {
    const props = relatedProps.get(databaseId) ?? [];
    const read = props.filter((p) => reads.get(databaseId)!.has(p.id));
    const system = props.some((p) => isComputed(p.type));
    const access = options.accessFor ? await options.accessFor(databaseId, props) : null;
    let own = loaded
      .filter((row) => row.parentId === databaseId)
      .map(({ createdBy, updatedBy, ...row }) =>
        system ? { ...row, properties: { ...row.properties, ...computedValues(props, { createdBy, updatedBy, ...row }) } } : row,
      );
    // As for the row itself: values the viewer may not see go before anything is worked out from them.
    if (access) own = access.strip(own);
    if (read.some((p) => isDerived(p.type))) {
      own = await computeDerived(own, props, { ...options, depth: (options.depth ?? 0) + 1, skipRelated: true });
    }
    if (access) own = access.finish(own);
    const known = new Set((access ? access.visible(props) : props).map((p) => p.id));
    const named = read.some((p) => p.type === "relation" || holdsPeople(p.type));
    out.set(databaseId, {
      props,
      rows: new Map(own.map((row) => [row.id, row as { properties: Record<string, unknown>; hidden?: string[] }])),
      unknown: new Set(props.filter((p) => !known.has(p.id)).map((p) => p.id)),
      context: { now: options.now, ...(named ? await options.lookups(props) : {}) },
    });
  }
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
