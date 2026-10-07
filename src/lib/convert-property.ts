import type { PropertyOptions, PropertyType, SelectOption, ViewConfig } from "@/db/schema/app";
import { aggregateFunctions } from "./aggregate";
import { isErrorValue, valueType } from "./derived";
import { asFiles } from "./files";
import { mapFilterRules } from "./filters";
import { detectDateFormat, parseChecklist, parseCheckbox, parseDate, parseNumber, splitList, type DateFormat } from "./import/csv";
import { asChecklist, isEmailAddress, isGroupable, isPhoneNumber, isSortable, SELECT_COLORS, sortStatusOptions } from "./properties";
import { holdsOptions, holdsPeople, holdsTimestamp, isDerived, isReadOnlyType } from "./property-types";

/**
 * Changing a property's type: what each value becomes. Pure, so the column menu counts the values
 * a change would lose on the rows it shows, and the server converts every row with the same code.
 *
 * A value is first read as text (option names, people's names, related rows' titles, a ticked box
 * as the viewer's "Yes"), then parsed the way CSV import reads cells. Values that already mean the
 * same thing skip the text: options keep their ids between select, multi-select and status, people
 * between person types, links between relations to the same database. Types Leafdesk works out
 * itself (formulas, rollups, created and edited by/time) keep no values.
 */

export type ConversionSide = { type: PropertyType; options: PropertyOptions };

export type ConversionContext = {
  /** People values can name: their names (and emails) read as text, and text finds them back. */
  people: { id: string; name: string; email?: string | null }[];
  /** A relation being converted: titles of the rows it links to; links to others are dropped. */
  sourceTitles?: Map<string, string>;
  /** Converting into a relation: the related database's rows, found by their exact title. */
  targetRows?: { id: string; title: string }[];
  /** A ticked checkbox as text, in the viewer's language (CSV import reads it back as ticked). */
  yes: string;
  newId?: () => string;
};

export type Conversion = {
  /** Select, multi-select and status targets: the options, carried over or made from the values. */
  options?: SelectOption[];
  /** One stored (or, for computed and derived types, worked-out) value in its new type; null for none. */
  convert: (value: unknown) => unknown;
};

/** Longest option name a converted value makes, as for CSV import. */
const MAX_OPTION_NAME = 200;

const isUrl = (s: string) => /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(s);
/** "example.com/path": a link without its scheme. */
const isBareDomain = (s: string) => /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) && !isEmailAddress(s);

export function isEmptyValue(value: unknown) {
  return value === null || value === undefined || value === "" || value === false || (Array.isArray(value) && !value.length);
}

/** Single values are read whole; list types are read as their items. */
function isListType(type: PropertyType) {
  return (
    type === "multi_select" || type === "checklist" || type === "files" || type === "relation" || holdsPeople(type)
  );
}

/** A value as the texts it shows: one for single values, one per item for lists. */
function texts(from: ConversionSide, value: unknown, ctx: ConversionContext): string[] {
  if (value === null || value === undefined || isErrorValue(value)) return [];
  const strings = (list: unknown[]) => list.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  const ids = Array.isArray(value) ? strings(value) : typeof value === "string" ? [value] : [];
  const optionName = (id: string) => from.options.options?.find((o) => o.id === id)?.name;
  switch (from.type) {
    case "select":
    case "status":
    case "multi_select":
      return ids.flatMap((id) => optionName(id) ?? []);
    case "checkbox":
      return value === true ? [ctx.yes] : [];
    case "checklist":
      return asChecklist(value).map((item) => item.text);
    case "files":
      return asFiles(value).map((file) => file.name);
    case "relation":
      return ids.flatMap((id) => ctx.sourceTitles?.get(id) ?? []);
    case "person":
    case "created_by":
    case "last_edited_by":
      return ids.flatMap((id) => ctx.people.find((p) => p.id === id)?.name ?? []);
    case "created_time":
    case "last_edited_time":
    case "date":
      return typeof value === "string" ? [value.slice(0, 10)] : [];
  }
  // Text-like values, numbers and what formulas and rollups work out.
  const one = (v: unknown): string[] =>
    v === true ? [ctx.yes] : typeof v === "number" ? [String(v)] : typeof v === "string" && v.trim() ? [v] : [];
  return Array.isArray(value) ? value.flatMap(one) : one(value);
}

/** The value as one text: list items joined by commas, checklists one item per line as exported. */
function joined(from: ConversionSide, value: unknown, ctx: ConversionContext) {
  if (from.type === "checklist") {
    return asChecklist(value)
      .map((item) => `[${item.checked ? "x" : " "}] ${item.text}`)
      .join("\n");
  }
  return texts(from, value, ctx).join(", ");
}

/** The pieces a value splits into for a multi-value target: list items, or text split at commas. */
function pieces(from: ConversionSide, value: unknown, ctx: ConversionContext) {
  const list = texts(from, value, ctx);
  return isListType(from.type) ? list : list.flatMap(splitList);
}

/** Where options come from: the source's own (ids kept) or the values' distinct texts. */
function targetOptions(from: ConversionSide, toType: PropertyType, names: string[], newId: () => string): SelectOption[] {
  if (holdsOptions(from.type)) {
    const carried = (from.options.options ?? []).map(({ group, ...o }) => (toType === "status" ? { ...o, group } : o));
    return toType === "status" ? sortStatusOptions(carried) : carried;
  }
  const seen = new Map<string, string>();
  for (const name of names) {
    const clean = name.trim().slice(0, MAX_OPTION_NAME);
    if (clean && !seen.has(clean.toLowerCase())) seen.set(clean.toLowerCase(), clean);
  }
  return [...seen.values()].map((name, i) =>
    toType === "status"
      ? { id: newId(), name, color: "gray", group: "todo" as const }
      : { id: newId(), name, color: SELECT_COLORS[i % SELECT_COLORS.length] },
  );
}

/**
 * How values of `from` become values of type `to`. `values` are the column's values in every row
 * (to make options from and to tell how its dates are written).
 */
export function planConversion(
  from: ConversionSide,
  to: { type: PropertyType },
  values: unknown[],
  ctx: ConversionContext,
): Conversion {
  const newId = ctx.newId ?? (() => crypto.randomUUID());
  const type = to.type;
  if (isReadOnlyType(type)) return { convert: () => null };

  if (holdsOptions(type)) {
    const list = type === "multi_select";
    const names = values.flatMap((v) => (list ? pieces(from, v, ctx) : texts(from, v, ctx).slice(0, 1)));
    let options = targetOptions(from, type, names, newId);
    // A status property always has options to move rows between.
    if (type === "status" && !options.length) {
      options = sortStatusOptions([
        { id: newId(), name: "Not started", color: "gray", group: "todo" },
        { id: newId(), name: "In progress", color: "blue", group: "in_progress" },
        { id: newId(), name: "Done", color: "green", group: "done" },
      ]);
    }
    const byName = (name: string) => options.find((o) => o.name.toLowerCase() === name.trim().slice(0, MAX_OPTION_NAME).toLowerCase())?.id;
    const carried = holdsOptions(from.type);
    return {
      options,
      convert: (value) => {
        const ids = carried
          ? (Array.isArray(value) ? value : [value]).filter((id): id is string => options.some((o) => o.id === id))
          : (list ? pieces(from, value, ctx) : texts(from, value, ctx)).flatMap((name) => byName(name) ?? []);
        const unique = [...new Set(ids)];
        if (!unique.length) return null;
        return list ? unique : unique[0];
      },
    };
  }

  const text = (value: unknown) => joined(from, value, ctx).trim();
  /** The value as one text to parse: a lone item, or (when a list has several) all of them. */
  const single = (value: unknown) => {
    const list = texts(from, value, ctx);
    return (list.length === 1 ? list[0] : list.join(", ")).trim();
  };

  switch (type) {
    case "text":
      return { convert: (value) => text(value) || null };
    case "number":
      return {
        convert: (value) => {
          if (typeof value === "number") return Number.isFinite(value) ? value : null;
          if (from.type === "checkbox") return null;
          return parseNumber(single(value));
        },
      };
    case "checkbox":
      return {
        convert: (value) => {
          if (typeof value === "boolean") return value;
          const s = single(value);
          return s ? parseCheckbox(s) : null;
        },
      };
    case "date": {
      const days = from.type === "date" || from.type === "created_time" || from.type === "last_edited_time";
      // One format for the column, read from the values that are dates at all.
      const format: DateFormat | null = days
        ? null
        : detectDateFormat(values.map(single).filter((s) => s && detectDateFormat([s])));
      return {
        convert: (value) => {
          const s = single(value);
          if (!s) return null;
          if (days) return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
          const cell = format ?? detectDateFormat([s]);
          return (cell && parseDate(s, cell)) || null;
        },
      };
    }
    case "url":
      return {
        convert: (value) => {
          if (from.type === "email" && typeof value === "string" && isEmailAddress(value)) return `mailto:${value}`;
          const s = single(value);
          if (isUrl(s)) return s;
          return isBareDomain(s) ? `https://${s}` : null;
        },
      };
    case "email":
      return {
        convert: (value) => {
          // People are written to by their email.
          if (holdsPeople(from.type)) {
            const ids = Array.isArray(value) ? value : [];
            const email = ctx.people.find((p) => p.id === ids[0])?.email;
            return email && isEmailAddress(email) ? email : null;
          }
          const s = single(value).replace(/^mailto:/i, "");
          return isEmailAddress(s) ? s : null;
        },
      };
    case "phone":
      return {
        convert: (value) => {
          const s = single(value).replace(/^tel:/i, "").replace(/\s+/g, " ");
          return isPhoneNumber(s) ? s : null;
        },
      };
    case "checklist":
      return {
        convert: (value) => {
          const items = isListType(from.type)
            ? texts(from, value, ctx).map((t) => ({ text: t, checked: false }))
            : parseChecklist(text(value));
          const out = items
            .map((item) => ({ id: newId(), text: item.text.replace(/\s+/g, " ").trim().slice(0, 1000), checked: item.checked }))
            .filter((item) => item.text);
          return out.length ? out : null;
        },
      };
    case "files":
      return { convert: (value) => (from.type === "files" && asFiles(value).length ? asFiles(value) : null) };
    case "relation": {
      const rows = ctx.targetRows ?? [];
      const find = (title: string) => {
        const matches = rows.filter((r) => r.title.trim().toLowerCase() === title.trim().toLowerCase());
        return matches.length === 1 ? matches[0].id : undefined;
      };
      return {
        convert: (value) => {
          const ids = pieces(from, value, ctx).flatMap((title) => find(title) ?? []);
          const unique = [...new Set(ids)];
          return unique.length ? unique : null;
        },
      };
    }
    case "person": {
      const find = (text: string) => {
        const needle = text.trim().toLowerCase();
        const byEmail = ctx.people.find((p) => p.email?.toLowerCase() === needle);
        const byName = ctx.people.filter((p) => p.name.trim().toLowerCase() === needle);
        return byEmail?.id ?? (byName.length === 1 ? byName[0].id : undefined);
      };
      return {
        convert: (value) => {
          const ids = holdsPeople(from.type)
            ? (Array.isArray(value) ? value : []).filter((id): id is string => typeof id === "string")
            : pieces(from, value, ctx).flatMap((t) => find(t) ?? []);
          const unique = [...new Set(ids)];
          return unique.length ? unique : null;
        },
      };
    }
  }
  return { convert: () => null };
}

/** How many of `values` hold something that converts to nothing (an unticked box is something). */
export function lostValues(values: unknown[], { convert }: Conversion) {
  return values.filter((v) => {
    if (isEmptyValue(v) || isErrorValue(v)) return false;
    const converted = convert(v);
    return converted !== false && isEmptyValue(converted);
  }).length;
}

/**
 * A view's settings once property `id` has its new type (`to`): what was set up for the old type
 * goes. Filters on it compared old values; sorts, groups, covers, chart measures, footer
 * calculations and form questions go when the new type can't have them, and a form's default for
 * it, an old-type value, always. Calendars and charts already fall back when their date or stack
 * property can't be one, so those stay for a later change back.
 */
export function retypeViewConfig(
  config: ViewConfig,
  id: string,
  from: PropertyType,
  to: { type: PropertyType; options: PropertyOptions },
): ViewConfig {
  const c = config;
  const type = valueType(to);
  // Group keys (option ids, days, people) meant the old values, unless options kept their ids.
  const regrouped = c.groupBy === id && !(holdsOptions(from) && holdsOptions(to.type));
  const dates = type === "date" || holdsTimestamp(type) || isDerived(to.type);
  const fn = c.calculations?.[id];
  return {
    ...c,
    filters: c.filters && mapFilterRules(c.filters, (f) => (f.propertyId === id ? null : f)),
    sorts: isSortable(type) ? c.sorts : c.sorts?.filter((s) => s.propertyId !== id),
    groupBy: c.groupBy === id && !isGroupable(type) ? undefined : c.groupBy,
    groupOrder: regrouped ? undefined : c.groupOrder,
    hiddenGroups: regrouped ? undefined : c.hiddenGroups,
    collapsedGroups: regrouped ? undefined : c.collapsedGroups,
    dateBy: c.dateBy === id && !dates ? undefined : c.dateBy,
    endDateBy: c.endDateBy === id && !dates ? undefined : c.endDateBy,
    cover: c.cover?.source === "property" && c.cover.propertyId === id && type !== "files" ? undefined : c.cover,
    chartAggregate: c.chartAggregate?.propertyId === id ? undefined : c.chartAggregate,
    calculations:
      fn && !aggregateFunctions(type).includes(fn as never)
        ? Object.fromEntries(Object.entries(c.calculations!).filter(([k]) => k !== id))
        : c.calculations,
    form: c.form && {
      ...c.form,
      questions: isReadOnlyType(to.type) ? c.form.questions?.filter((q) => q.propertyId !== id) : c.form.questions,
      defaults: c.form.defaults && Object.fromEntries(Object.entries(c.form.defaults).filter(([k]) => k !== id)),
    },
  };
}
