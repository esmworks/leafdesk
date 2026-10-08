// Pure: how one viewer's property access applies to rows, views and writes (server/property-access
// loads the rules and the viewer; this works on them). No database access, so tests can run it.
import type { ViewConfig } from "@/db/schema";
import { dropPropertyReferences } from "./duplicate";
import { mapFilterRules } from "./filters";
import { PropertyValueError } from "./properties";
import {
  atLeast,
  dependsOnRow,
  formulaReferences,
  resolvePropertyLevel,
  type PropertyAccessInfo,
  type PropertyLevel,
  type PropertyRule,
  type PropertyViewer,
} from "./property-access";
import type { PropertyType } from "./property-types";

type Prop = { id: string; name: string; type: PropertyType; options: { formula?: { expression: string } } };

/** A row as far as access goes: its values, and who created it (for "created by" exceptions). */
export type AccessRow = { properties: Record<string, unknown>; createdBy?: string | null };

/** Rows as a restricted viewer gets them: values they may not see left out and listed. */
export type RedactedFields = {
  /** Properties whose values were left out of this row (the property shows, its value doesn't). */
  hidden?: string[];
  /** Properties whose values show in this row but that the viewer may not change here. */
  readOnly?: string[];
};

/**
 * One viewer's access to the properties of one database. `open` when the database has no rules:
 * then every method returns its input and nothing needs checking.
 */
export type PropertyAccess = {
  open: boolean;
  viewer: PropertyViewer | null;
  /** The viewer's level on a property, in a row when one is given (see resolvePropertyLevel). */
  levelOf(propertyId: string, row?: AccessRow | null): PropertyLevel;
  /** What the client is told about each restricted property; undefined when none is restricted. */
  info(): Record<string, PropertyAccessInfo> | undefined;
  /** The properties the viewer may know about. */
  visible<P extends { id: string }>(properties: P[]): P[];
  /** Before derived values are worked out: leaves out what the viewer may not see in each row. */
  strip<R extends AccessRow>(rows: R[]): (R & RedactedFields)[];
  /**
   * After: leaves out derived values that read something left out (a formula over a hidden
   * property shows nothing rather than a wrong result), and properties the viewer can't know of.
   */
  finish<R extends { properties: Record<string, unknown> } & RedactedFields>(rows: R[]): R[];
  /** Throws unless the viewer may change the values of these properties in this row. */
  requireValues(row: AccessRow | null, propertyIds: Iterable<string>): void;
  /** Throws unless the viewer may change the property itself (rename, retype, delete). */
  requireSchema(propertyId: string): void;
  /** A view's settings without references to properties the viewer can't know of. */
  viewConfig(config: ViewConfig): ViewConfig;
  /** Properties the viewer knows of but sees no value of in any row (form defaults hide for them). */
  valuesHidden(): ReadonlySet<string>;
};

export const OPEN_ACCESS: PropertyAccess = {
  open: true,
  viewer: null,
  levelOf: () => "edit",
  info: () => undefined,
  visible: (properties) => properties,
  strip: (rows) => rows,
  finish: (rows) => rows,
  requireValues: () => {},
  requireSchema: () => {},
  viewConfig: (config) => config,
  valuesHidden: () => new Set(),
};

/** The same, for rules already loaded (tests, and reads that load several databases at once). */
export function makeAccess(rules: Map<string, PropertyRule[]>, viewer: PropertyViewer, properties: Prop[]): PropertyAccess {
  const restricted = properties.filter((p) => rules.get(p.id)?.length);
  if (!restricted.length || viewer.databaseLevel === "full") return { ...OPEN_ACCESS, viewer };

  const rulesOf = (id: string) => rules.get(id) ?? [];
  const byId = new Map(properties.map((p) => [p.id, p]));
  // With a created-by exception the row's creator counts as named by it.
  const subject = (row: AccessRow) => {
    const createdBy = properties.find((p) => p.type === "created_by");
    return createdBy && row.createdBy !== undefined
      ? { ...row.properties, [createdBy.id]: row.createdBy ? [row.createdBy] : null }
      : row.properties;
  };
  const schemaLevel = new Map(restricted.map((p) => [p.id, resolvePropertyLevel(rulesOf(p.id), viewer)]));
  const perRow = new Set(restricted.filter((p) => dependsOnRow(rulesOf(p.id), viewer)).map((p) => p.id));
  const levelOf = (id: string, row?: AccessRow | null): PropertyLevel => {
    if (!schemaLevel.has(id)) return resolvePropertyLevel([], viewer);
    if (!row || !perRow.has(id)) return perRow.has(id) ? resolvePropertyLevel(rulesOf(id), viewer, null) : schemaLevel.get(id)!;
    return resolvePropertyLevel(rulesOf(id), viewer, subject(row));
  };
  const unknown = new Set([...schemaLevel].filter(([, level]) => level === "none").map(([id]) => id));
  const valuesHidden = new Set([...schemaLevel].filter(([id, level]) => !unknown.has(id) && !atLeast(level, "view")).map(([id]) => id));

  // Formulas read other properties; rollups read another database (restricted there on its own).
  const formulaRefs = new Map(
    properties
      .filter((p) => p.type === "formula")
      .map((p) => [p.id, formulaReferences(p.options.formula?.expression ?? "")] as const),
  );

  return {
    open: false,
    viewer,
    levelOf,
    info: () =>
      Object.fromEntries(restricted.filter((p) => !unknown.has(p.id)).map((p) => [p.id, { level: schemaLevel.get(p.id)!, perRow: perRow.has(p.id) }])),
    visible: (list) => list.filter((p) => !unknown.has(p.id)),
    strip: (rows) =>
      rows.map((row) => {
        const hidden: string[] = [];
        const readOnly: string[] = [];
        const values = { ...row.properties };
        for (const p of restricted) {
          const level = levelOf(p.id, row);
          if (!atLeast(level, "view")) {
            delete values[p.id];
            if (!unknown.has(p.id)) hidden.push(p.id);
          } else if (!atLeast(level, "edit_values")) readOnly.push(p.id);
        }
        // Formulas over hidden values are left out after they are worked out (see finish).
        for (const id of unknown) hidden.push(id);
        return {
          ...row,
          properties: values,
          ...(hidden.length ? { hidden } : {}),
          ...(readOnly.length ? { readOnly } : {}),
        };
      }),
    finish: (rows) =>
      rows.map((row) => {
        const hidden = new Set(row.hidden ?? []);
        if (!hidden.size) return row;
        // Every formula that reads something hidden, directly or through another formula.
        let grew = true;
        while (grew) {
          grew = false;
          for (const [id, refs] of formulaRefs) {
            if (!hidden.has(id) && refs.some((r) => hidden.has(r))) {
              hidden.add(id);
              grew = true;
            }
          }
        }
        const values = { ...row.properties };
        for (const id of hidden) delete values[id];
        const shown = [...hidden].filter((id) => byId.has(id) && !unknown.has(id));
        const { hidden: _, ...rest } = row;
        return { ...rest, properties: values, ...(shown.length ? { hidden: shown } : {}) } as typeof row;
      }),
    requireValues: (row, ids) => {
      for (const id of ids) {
        if (!schemaLevel.has(id)) continue;
        const level = levelOf(id, row);
        if (atLeast(level, "edit_values")) continue;
        const prop = byId.get(id)!;
        // A property they can't know of is refused like one that doesn't exist.
        if (unknown.has(id)) throw new PropertyValueError(`Unknown property "${id}"`, "unknownProperty", { property: id });
        throw new PropertyValueError(`You can't change "${prop.name}"`, "propertyRestricted", { property: prop.name });
      }
    },
    requireSchema: (id) => {
      if (!schemaLevel.has(id) || atLeast(schemaLevel.get(id)!, "edit")) return;
      if (unknown.has(id)) throw new PropertyValueError(`Unknown property "${id}"`, "unknownProperty", { property: id });
      const prop = byId.get(id)!;
      throw new PropertyValueError(`You can't change "${prop.name}"`, "propertyRestricted", { property: prop.name });
    },
    viewConfig: (config) => withoutDefaults(hideReferences(config, unknown), valuesHidden),
    valuesHidden: () => valuesHidden,
  };
}

/**
 * What two viewers may both do: someone acting for another person (an agent run started by a
 * member) sees and changes only what both of them may. Each side redacts the rows on its own, so a
 * value one side hides never changes how the other side's per-row rules read the row.
 */
export function intersectAccess(a: PropertyAccess, b: PropertyAccess): PropertyAccess {
  if (a.open) return b;
  if (b.open) return a;
  const knows = (access: PropertyAccess, id: string) => access.visible([{ id }]).length > 0;
  const knownToBoth = (id: string) => knows(a, id) && knows(b, id);
  const merge = (...lists: (string[] | undefined)[]) => [...new Set(lists.flatMap((list) => list ?? []))];
  const minLevel = (x: PropertyLevel, y: PropertyLevel) => (atLeast(x, y) ? y : x);

  return {
    open: false,
    viewer: a.viewer,
    levelOf: (id, row) => minLevel(a.levelOf(id, row), b.levelOf(id, row)),
    info: () => {
      const infoA = a.info() ?? {};
      const infoB = b.info() ?? {};
      const ids = [...new Set([...Object.keys(infoA), ...Object.keys(infoB)])].filter(knownToBoth);
      if (!ids.length) return undefined;
      return Object.fromEntries(
        ids.map((id) => {
          const level = minLevel(infoA[id]?.level ?? a.levelOf(id), infoB[id]?.level ?? b.levelOf(id));
          return [id, { level, perRow: Boolean(infoA[id]?.perRow || infoB[id]?.perRow) }];
        }),
      );
    },
    visible: (list) => b.visible(a.visible(list)),
    strip: (rows) => {
      const byA = a.strip(rows);
      const byB = b.strip(rows);
      return byA.map((row, i) => {
        const other = byB[i];
        const properties = Object.fromEntries(Object.entries(row.properties).filter(([id]) => id in other.properties));
        const hidden = merge(row.hidden, other.hidden);
        const readOnly = merge(row.readOnly, other.readOnly).filter((id) => !hidden.includes(id));
        const { hidden: _h, readOnly: _r, ...rest } = row;
        return { ...rest, properties, ...(hidden.length ? { hidden } : {}), ...(readOnly.length ? { readOnly } : {}) } as (typeof byA)[number];
      });
    },
    finish: (rows) => a.finish(b.finish(rows)),
    requireValues: (row, ids) => {
      const list = [...ids];
      // A property one side can't know of is refused as unknown, whatever the other side may do.
      for (const id of list) if (!knownToBoth(id)) throw unknownProperty(id);
      a.requireValues(row, list);
      b.requireValues(row, list);
    },
    requireSchema: (id) => {
      if (!knownToBoth(id)) throw unknownProperty(id);
      a.requireSchema(id);
      b.requireSchema(id);
    },
    viewConfig: (config) => b.viewConfig(a.viewConfig(config)),
    valuesHidden: () => new Set([...a.valuesHidden(), ...b.valuesHidden()].filter(knownToBoth)),
  };
}

const unknownProperty = (id: string) => new PropertyValueError(`Unknown property "${id}"`, "unknownProperty", { property: id });

/** A form's default values without those of properties whose values the viewer can't see. */
function withoutDefaults(config: ViewConfig, hidden: ReadonlySet<string>): ViewConfig {
  const defaults = config.form?.defaults;
  if (!defaults || !hidden.size || !Object.keys(defaults).some((id) => hidden.has(id))) return config;
  return { ...config, form: { ...config.form, defaults: Object.fromEntries(Object.entries(defaults).filter(([id]) => !hidden.has(id))) } };
}

/**
 * A view's settings without what refers to properties in `gone`. Filter groups that mention one go
 * whole, so `restoreReferences` can put them back as they were.
 */
export function hideReferences(config: ViewConfig, gone: ReadonlySet<string>): ViewConfig {
  if (!gone.size) return config;
  const dropped = dropPropertyReferences(
    { ...config, filters: config.filters?.filter((f) => !mentions(f, gone)) },
    (id) => gone.has(id),
  );
  return dropped;
}

type FilterEntry = NonNullable<ViewConfig["filters"]>[number];

function mentions(entry: FilterEntry, gone: ReadonlySet<string>) {
  let found = false;
  mapFilterRules([entry], (rule) => {
    if (gone.has(rule.propertyId)) found = true;
    return rule;
  });
  return found;
}

/**
 * A view's new settings from someone who couldn't see some properties, with what the stored
 * settings said about those properties put back: saving a view never drops someone else's filter
 * on a column the saver can't see.
 */
export function restoreReferences(stored: ViewConfig, next: ViewConfig, gone: ReadonlySet<string>): ViewConfig {
  if (!gone.size) return next;
  const out: ViewConfig = { ...next };
  const keep = (id: string | undefined) => id !== undefined && gone.has(id);
  for (const key of ["groupBy", "dateBy", "endDateBy", "stackBy", "frozenThrough"] as const) {
    if (keep(stored[key])) out[key] = stored[key];
  }
  if (stored.cover?.source === "property" && gone.has(stored.cover.propertyId)) out.cover = stored.cover;
  if (stored.chartAggregate && gone.has(stored.chartAggregate.propertyId)) out.chartAggregate = stored.chartAggregate;
  const hiddenSorts = stored.sorts?.filter((s) => gone.has(s.propertyId)) ?? [];
  if (hiddenSorts.length) out.sorts = [...(next.sorts ?? []), ...hiddenSorts];
  const hiddenFilters = stored.filters?.filter((f) => mentions(f, gone)) ?? [];
  if (hiddenFilters.length) out.filters = [...(next.filters ?? []), ...hiddenFilters];
  for (const key of ["hidden", "shown", "wrapped"] as const) {
    const ids = stored[key]?.filter((id) => gone.has(id)) ?? [];
    if (ids.length) out[key] = [...(next[key] ?? []), ...ids];
  }
  if (stored.propertyOrder?.some((id) => gone.has(id))) {
    // Each column the saver couldn't see goes back right after the one it followed before.
    const order = (next.propertyOrder ?? stored.propertyOrder.filter((id) => !gone.has(id))).filter((id) => !gone.has(id));
    stored.propertyOrder.forEach((id, i) => {
      if (!gone.has(id)) return;
      const before = stored.propertyOrder!.slice(0, i).findLast((prev) => order.includes(prev));
      order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
    });
    out.propertyOrder = order;
  }
  const calcs = Object.entries(stored.calculations ?? {}).filter(([id]) => gone.has(id));
  if (calcs.length) out.calculations = { ...next.calculations, ...Object.fromEntries(calcs) };
  const widths = Object.entries(stored.columnWidths ?? {}).filter(([id]) => gone.has(id));
  if (widths.length) out.columnWidths = { ...next.columnWidths, ...Object.fromEntries(widths) };
  if (stored.form) {
    const questions = stored.form.questions?.filter((q) => gone.has(q.propertyId)) ?? [];
    const defaults = Object.entries(stored.form.defaults ?? {}).filter(([id]) => gone.has(id));
    if (questions.length || defaults.length) {
      out.form = {
        ...next.form,
        ...(questions.length ? { questions: [...(next.form?.questions ?? []), ...questions] } : {}),
        ...(defaults.length ? { defaults: { ...next.form?.defaults, ...Object.fromEntries(defaults) } } : {}),
      };
    }
  }
  return out;
}

/** The ids of properties the viewer can't know of (level `none`). */
export function unknownProperties(access: PropertyAccess, properties: { id: string }[]): Set<string> {
  if (access.open) return new Set();
  const visible = new Set(access.visible(properties).map((p) => p.id));
  return new Set(properties.filter((p) => !visible.has(p.id)).map((p) => p.id));
}

