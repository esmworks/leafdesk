import type { PageKind, PropertyOptions, PropertyType, RowProperties, ViewConfig, ViewType } from "@/db/schema/app";
import { mapFilterRules } from "./filters";
import { rewriteReferences } from "./formula";
import { atLeast, type PropertyLevel, type PropertyRule } from "./property-access";
// Type only: property-access-rows imports this module.
import type { PropertyAccess } from "./property-access-rows";

/**
 * Pure planning for "Duplicate page": given the source subtree, decides every new id and rewrites
 * the references between copied things (row values, view configs, relations). No database access,
 * so it can be tested on its own; `src/server/duplicate.ts` loads the input and writes the plan.
 */

export type SourcePage = {
  id: string;
  parentId: string | null;
  kind: PageKind;
  title: string;
  position: number;
  properties: RowProperties;
};
export type SourceProperty = {
  id: string;
  databaseId: string;
  name: string;
  type: PropertyType;
  options: PropertyOptions;
  position: number;
};
export type SourceView = { id: string; databaseId: string; name: string; type: ViewType; config: ViewConfig; position: number };

export type DuplicateInput = {
  rootId: string;
  /** The root and every descendant to copy; each non-root page's parent must be in the list. */
  pages: SourcePage[];
  /** Properties and views of the databases among `pages`. */
  properties: SourceProperty[];
  views: SourceView[];
  rootTitle: string;
  rootPosition: number;
};

export type PlannedPage = Omit<SourcePage, "id"> & { id: string; sourceId: string };
export type DuplicatePlan = {
  rootId: string;
  /** Source page id → copy id. */
  pageIds: Map<string, string>;
  /** Source property id → copy id. */
  propertyIds: Map<string, string>;
  pages: PlannedPage[];
  properties: SourceProperty[];
  views: SourceView[];
};

/** Maps an id through `map`, keeping ids it doesn't know (special keys such as "title", stale ids). */
const through = (map: Map<string, string>) => (id: string) => map.get(id) ?? id;

const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function planDuplicate(input: DuplicateInput, newId: () => string = () => crypto.randomUUID()): DuplicatePlan {
  const pageIds = new Map(input.pages.map((p) => [p.id, newId()]));
  const propIds = new Map(input.properties.map((p) => [p.id, newId()]));
  const copiedDatabases = new Set(input.pages.filter((p) => p.kind === "database").map((p) => p.id));
  const propsById = new Map(input.properties.map((p) => [p.id, p]));

  /** Where a relation points after copying: the copy when its target database is copied too. */
  const relationInside = (prop: SourceProperty | undefined) => {
    const target = prop?.type === "relation" ? prop.options.relation?.databaseId : undefined;
    return !!target && copiedDatabases.has(target);
  };

  const properties = input.properties.map((prop): SourceProperty => {
    const options: PropertyOptions = structuredClone(prop.options);
    const relation = prop.type === "relation" ? prop.options.relation : undefined;
    if (relation) {
      options.relation = relationInside(prop)
        ? {
            databaseId: pageIds.get(relation.databaseId)!,
            pairedPropertyId: (relation.pairedPropertyId && propIds.get(relation.pairedPropertyId)) || null,
            // A copied database keeps its sub-items.
            ...(relation.role ? { role: relation.role } : {}),
          }
        : // The target stays the original database, one-way: its paired property keeps pairing with
          // the original, and mirroring into it from the copy would corrupt that pairing.
          { databaseId: relation.databaseId, pairedPropertyId: null };
    }
    // Formulas name the properties they use by id: point them at the copies.
    if (prop.type === "formula" && prop.options.formula) {
      options.formula = { expression: rewriteReferences(prop.options.formula.expression, (key) => propIds.get(key) ?? null) };
    }
    // Rollups read through a relation of their own database, which is copied with them; the
    // property they read is copied only when the related database is.
    if (prop.type === "rollup" && prop.options.rollup) {
      const rollup = prop.options.rollup;
      const inside = relationInside(propsById.get(rollup.relationPropertyId));
      options.rollup = {
        ...rollup,
        relationPropertyId: propIds.get(rollup.relationPropertyId) ?? rollup.relationPropertyId,
        targetPropertyId: inside ? (propIds.get(rollup.targetPropertyId) ?? rollup.targetPropertyId) : rollup.targetPropertyId,
      };
    }
    return { ...prop, id: propIds.get(prop.id)!, databaseId: pageIds.get(prop.databaseId)!, options };
  });

  const views = input.views.map(
    (view): SourceView => ({
      ...view,
      id: newId(),
      databaseId: pageIds.get(view.databaseId)!,
      config: remapViewConfig(view.config, propIds, (propertyId) =>
        relationInside(propsById.get(propertyId)) ? pageIds : null,
      ),
    }),
  );

  const pages = input.pages.map((p): PlannedPage => {
    const isRoot = p.id === input.rootId;
    // Row values are keyed by the parent database's properties; only rows of copied databases
    // change. The root keeps its values: its parent (if a database) is not copied.
    const rowOfCopy = !isRoot && !!p.parentId && copiedDatabases.has(p.parentId);
    return {
      sourceId: p.id,
      id: pageIds.get(p.id)!,
      parentId: isRoot ? p.parentId : pageIds.get(p.parentId!)!,
      kind: p.kind,
      title: isRoot ? input.rootTitle : p.title,
      position: isRoot ? input.rootPosition : p.position,
      properties: rowOfCopy
        ? remapRowProperties(p.properties, propIds, (propertyId) =>
            relationInside(propsById.get(propertyId)) ? pageIds : null,
          )
        : structuredClone(p.properties),
    };
  });

  return { rootId: pageIds.get(input.rootId)!, pageIds, propertyIds: propIds, pages, properties, views };
}

// ---------------------------------------------------------------------------------------------
// Property access and copies
//
// Whoever copies a database sees the copy through their own access to it, and the copy starts
// without anything they couldn't see: nobody learns a value, or that a property exists, by
// copying it. So a copy leaves out the properties the copier can't know of (schema, values, the
// views' references to them) and the values they can't view, row by row. What does come along
// keeps its rules (planPropertyRules), so the copy is no more open to anyone else than the source.

/** A row as a copy reads it: its values, and who created it (for "created by" exceptions). */
export type CopyRow = { properties: RowProperties; createdBy?: string | null };

/** What a copy of one database's rows carries for the person copying (see copyAccess). */
export type CopyAccess = {
  /** Properties left out entirely: the copier can't know of them. */
  gone: ReadonlySet<string>;
  /** Properties whose values the copier sees in no row: their form defaults stay behind too. */
  unseen: ReadonlySet<string>;
  /** The values of a row that come along. */
  values(row: CopyRow): RowProperties;
};

/**
 * What a copy carries from one database for someone with `access` to it; null when it carries
 * everything (no rules, or full access). `properties`: all of the database's properties.
 *
 * - Rows copied with their database keep the values the copier may view (`view` and up).
 * - `write`: the row lands in the same database, where its rules still hold (duplicating a row,
 *   saving it as a row template, a row made from a template). It then keeps only the values the
 *   copier could have set themselves in the new row they create: anything else would write around
 *   the rules (a "view" level property copied from an approved row, say).
 * - `gone`: properties to leave out beyond the ones `access` hides (anonymous visitors, see
 *   server/publication publicAccess).
 */
export function copyAccess(
  access: Pick<PropertyAccess, "open" | "levelOf" | "visible" | "valuesHidden">,
  properties: { id: string }[],
  options: { gone?: ReadonlySet<string>; write?: { createdBy: string | null } } = {},
): CopyAccess | null {
  if (access.open && !options.gone?.size) return null;
  const known = new Set(access.visible(properties).map((p) => p.id));
  const gone = new Set([...properties.filter((p) => !known.has(p.id)).map((p) => p.id), ...(options.gone ?? [])]);
  const keep = (row: CopyRow, needed: PropertyLevel) =>
    Object.fromEntries(Object.entries(row.properties).filter(([id]) => !gone.has(id) && atLeast(access.levelOf(id, row), needed)));
  const unseen = access.valuesHidden();
  const write = options.write;
  if (!write) return { gone, unseen, values: (row) => keep(row, "view") };
  return {
    gone,
    unseen,
    values: (row) => {
      // Person property exceptions read the row's own values; leaving one out may take away the
      // level that kept another, so check again until nothing more goes.
      let values = Object.fromEntries(Object.entries(row.properties).filter(([id]) => !gone.has(id)));
      for (;;) {
        const next = keep({ properties: values, createdBy: write.createdBy }, "edit_values");
        if (Object.keys(next).length === Object.keys(values).length) return next;
        values = next;
      }
    },
  };
}

/**
 * The input of a copy without what the copier may not carry: `databases` maps a database id to
 * what its rows (copied with it, or a copied row of it) carry; databases missing from it carry
 * everything. `createdBy` holds who created each row, for "created by" exceptions.
 */
export function redactCopy(
  input: DuplicateInput,
  databases: ReadonlyMap<string, CopyAccess>,
  createdBy: ReadonlyMap<string, string | null> = new Map(),
): DuplicateInput {
  if (!databases.size) return input;
  const goneIn = (databaseId: string) => databases.get(databaseId)?.gone ?? new Set<string>();
  return {
    ...input,
    properties: input.properties.filter((p) => !goneIn(p.databaseId).has(p.id)),
    views: input.views.map((view) => {
      const gone = goneIn(view.databaseId);
      const unseen = databases.get(view.databaseId)?.unseen;
      const defaults = view.config.form?.defaults;
      // A form's default is a value like any other: it stays behind where the copier sees none.
      if (defaults && unseen && Object.keys(defaults).some((id) => unseen.has(id))) {
        const kept = Object.fromEntries(Object.entries(defaults).filter(([id]) => !unseen.has(id)));
        view = { ...view, config: { ...view.config, form: { ...view.config.form, defaults: kept } } };
      }
      if (!gone.size) return view;
      // As the copier saw the view: filter groups that mention a property left out go whole.
      const filters = view.config.filters?.filter((entry) => {
        let found = false;
        mapFilterRules([entry], (rule) => {
          if (gone.has(rule.propertyId)) found = true;
          return rule;
        });
        return !found;
      });
      return { ...view, config: dropPropertyReferences({ ...view.config, filters }, (id) => gone.has(id)) };
    }),
    pages: input.pages.map((p) => {
      const access = p.parentId ? databases.get(p.parentId) : undefined;
      if (!access || p.kind === "database") return p;
      return { ...p, properties: access.values({ properties: p.properties, createdBy: createdBy.get(p.id) }) };
    }),
  };
}

/** One rule of a copied database's property access (see server/property-access). */
export type SourceRule = PropertyRule & { databaseId: string };

/**
 * The rules of the copied databases, pointed at the copies: the property, its database and a
 * person property exception's property. Rules of properties the copy left out go with them, and so
 * do exceptions for a person property it left out (they only ever raise a level).
 */
export function planPropertyRules(rules: SourceRule[], plan: Pick<DuplicatePlan, "pageIds" | "propertyIds" | "properties">): SourceRule[] {
  const copied = new Set(plan.properties.map((p) => p.id));
  const copyOf = (id: string) => {
    const next = plan.propertyIds.get(id);
    return next && copied.has(next) ? next : null;
  };
  return rules.flatMap((rule): SourceRule[] => {
    const propertyId = copyOf(rule.propertyId);
    const databaseId = plan.pageIds.get(rule.databaseId);
    if (!propertyId || !databaseId) return [];
    const personPropertyId = rule.personPropertyId ? copyOf(rule.personPropertyId) : null;
    if (rule.personPropertyId && !personPropertyId) return [];
    return [{ ...rule, propertyId, databaseId, personPropertyId }];
  });
}

/**
 * Rekeys a row's values to the copied properties. `rowIdsFor(sourcePropertyId)` returns the row id
 * map for relations whose target database was copied (links then point at the copied rows, and
 * links to rows that weren't copied are dropped); null keeps the values as they are.
 */
export function remapRowProperties(
  properties: RowProperties,
  propIds: Map<string, string>,
  rowIdsFor: (sourcePropertyId: string) => Map<string, string> | null,
): RowProperties {
  const out: RowProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    const rowIds = rowIdsFor(key);
    if (!rowIds) {
      out[through(propIds)(key)] = structuredClone(value);
      continue;
    }
    const linked = asIds(value).flatMap((id) => (rowIds.has(id) ? [rowIds.get(id)!] : []));
    if (linked.length) out[through(propIds)(key)] = linked;
  }
  return out;
}

/**
 * Points a view config at the copied properties. Option ids (`groupOrder`, `hiddenGroups`, filter
 * values of selects) stay: options keep their ids when copied. Relation filter values are row ids
 * and follow `rowIdsFor` like row values do, and so do group keys of a view grouped by a relation.
 */
export function remapViewConfig(
  config: ViewConfig,
  propIds: Map<string, string>,
  rowIdsFor: (sourcePropertyId: string) => Map<string, string> | null,
): ViewConfig {
  const map = through(propIds);
  const out: ViewConfig = structuredClone(config);
  if (config.groupBy !== undefined) {
    out.groupBy = map(config.groupBy);
    // Grouped by a relation, group keys are linked row ids and follow the copied rows.
    const rowIds = rowIdsFor(config.groupBy);
    if (rowIds) {
      const remapKeys = (keys: string[] | undefined) => keys?.map((key) => rowIds.get(key) ?? key);
      if (config.groupOrder) out.groupOrder = remapKeys(config.groupOrder);
      if (config.hiddenGroups) out.hiddenGroups = remapKeys(config.hiddenGroups);
      if (config.collapsedGroups) out.collapsedGroups = remapKeys(config.collapsedGroups);
    }
  }
  if (config.dateBy !== undefined) out.dateBy = map(config.dateBy);
  if (config.endDateBy !== undefined) out.endDateBy = map(config.endDateBy);
  if (config.stackBy !== undefined) out.stackBy = map(config.stackBy);
  if (config.frozenThrough !== undefined) out.frozenThrough = map(config.frozenThrough);
  if (config.chartAggregate) out.chartAggregate = { ...config.chartAggregate, propertyId: map(config.chartAggregate.propertyId) };
  if (config.sorts) out.sorts = config.sorts.map((s) => ({ ...s, propertyId: map(s.propertyId) }));
  if (config.filters) {
    out.filters = mapFilterRules(config.filters, (f) => {
      const rowIds = rowIdsFor(f.propertyId);
      const value = rowIds && typeof f.value === "string" ? (rowIds.get(f.value) ?? f.value) : structuredClone(f.value);
      return { ...f, propertyId: map(f.propertyId), ...(f.value !== undefined ? { value } : {}) };
    });
  }
  if (config.hidden) out.hidden = config.hidden.map(map);
  if (config.shown) out.shown = config.shown.map(map);
  if (config.propertyOrder) out.propertyOrder = config.propertyOrder.map(map);
  if (config.wrapped) out.wrapped = config.wrapped.map(map);
  if (config.calculations) {
    out.calculations = Object.fromEntries(Object.entries(config.calculations).map(([key, fn]) => [map(key), fn]));
  }
  if (config.columnWidths) {
    out.columnWidths = Object.fromEntries(Object.entries(config.columnWidths).map(([key, width]) => [map(key), width]));
  }
  // A form's questions follow the copied properties, and its default values are row values. Whether
  // it is open to the web isn't part of the config: a copy starts closed.
  if (config.form?.questions) out.form!.questions = config.form.questions.map((q) => ({ ...q, propertyId: map(q.propertyId) }));
  if (config.form?.defaults) out.form!.defaults = remapRowProperties(config.form.defaults, propIds, rowIdsFor);
  return out;
}

/**
 * A view config without references to the properties `gone` holds: what deleting a property does
 * to its database's views, and what a copy that leaves properties behind does to the copied views.
 */
export function dropPropertyReferences(config: ViewConfig, gone: (propertyId: string) => boolean): ViewConfig {
  const c = config;
  return {
    ...c,
    groupBy: c.groupBy !== undefined && gone(c.groupBy) ? undefined : c.groupBy,
    dateBy: c.dateBy !== undefined && gone(c.dateBy) ? undefined : c.dateBy,
    endDateBy: c.endDateBy !== undefined && gone(c.endDateBy) ? undefined : c.endDateBy,
    stackBy: c.stackBy !== undefined && gone(c.stackBy) ? undefined : c.stackBy,
    frozenThrough: c.frozenThrough !== undefined && gone(c.frozenThrough) ? undefined : c.frozenThrough,
    // A gallery that took covers from the property goes back to the default.
    cover: c.cover?.source === "property" && gone(c.cover.propertyId) ? undefined : c.cover,
    chartAggregate: c.chartAggregate && gone(c.chartAggregate.propertyId) ? undefined : c.chartAggregate,
    sorts: c.sorts?.filter((s) => !gone(s.propertyId)),
    filters: c.filters && mapFilterRules(c.filters, (f) => (gone(f.propertyId) ? null : f)),
    hidden: c.hidden?.filter((h) => !gone(h)),
    shown: c.shown?.filter((h) => !gone(h)),
    propertyOrder: c.propertyOrder?.filter((id) => !gone(id)),
    wrapped: c.wrapped?.filter((id) => !gone(id)),
    calculations: c.calculations && Object.fromEntries(Object.entries(c.calculations).filter(([k]) => !gone(k))),
    columnWidths: c.columnWidths && Object.fromEntries(Object.entries(c.columnWidths).filter(([k]) => !gone(k))),
    form: c.form && {
      ...c.form,
      questions: c.form.questions?.filter((q) => !gone(q.propertyId)),
      defaults: c.form.defaults && Object.fromEntries(Object.entries(c.form.defaults).filter(([k]) => !gone(k))),
    },
  };
}
