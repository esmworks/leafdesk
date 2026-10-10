import { isErrorValue } from "./derived";
import { asFiles } from "./files";
import { asChecklist, type RowLike } from "./properties";
import { holdsPeople, type PropertyType } from "./property-types";

/**
 * The search box of a database view: narrows the rows the view shows to those whose title or
 * values hold every word typed, in any order. Values are what the row shows, not what it stores:
 * option names, people's names, the titles of linked rows, checklist items and file names, plus
 * text, numbers, links and formula or rollup results. Dates and checkboxes aren't searched.
 *
 * It only reads the rows the viewer already has: values hidden from them (property access) are
 * left out on the server, so a search can't find a row by a value they can't see.
 */

type Prop = { id: string; type: PropertyType; options: { options?: { id: string; name: string }[] } };

export type RowSearchContext = {
  /** People person properties can show, for their names. */
  people?: { id: string; name: string }[];
  /** For each relation property, the rows it can link to, for their titles. */
  relations?: Record<string, { rows: { id: string; title: string }[] } | undefined>;
};

/** Lowercase, without accents, and with Turkish dotless ı read as i: "Işık" finds "isik". */
export function foldSearchText(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ı/g, "i");
}

/** The words of a query, folded; none for an empty or blank query. */
export function searchWords(query: string): string[] {
  return foldSearchText(query).split(/\s+/).filter(Boolean);
}

/** Strings and numbers anywhere in a formula or rollup result (a list of texts, say). */
function looseTexts(value: unknown, out: string[]) {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" && Number.isFinite(value)) out.push(String(value));
  else if (Array.isArray(value)) for (const item of value) looseTexts(item, out);
}

function valueTexts(prop: Prop, value: unknown, names: Map<string, string>, context: RowSearchContext, out: string[]) {
  if (value === null || value === undefined || isErrorValue(value)) return;
  const option = (id: unknown) => prop.options.options?.find((o) => o.id === id)?.name;
  switch (prop.type) {
    case "text":
    case "url":
    case "email":
    case "phone":
      if (typeof value === "string") out.push(value);
      return;
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) out.push(String(value));
      return;
    case "select":
    case "status": {
      const name = option(value);
      if (name) out.push(name);
      return;
    }
    case "multi_select":
      for (const id of Array.isArray(value) ? value : []) {
        const name = option(id);
        if (name) out.push(name);
      }
      return;
    case "checklist":
      for (const item of asChecklist(value)) out.push(item.text);
      return;
    case "files":
      for (const file of asFiles(value)) out.push(file.name);
      return;
    case "relation": {
      const rows = context.relations?.[prop.id]?.rows ?? [];
      for (const id of Array.isArray(value) ? value : []) {
        const row = rows.find((r) => r.id === id);
        if (row) out.push(row.title);
      }
      return;
    }
    case "formula":
    case "rollup":
      looseTexts(value, out);
      return;
    default:
      if (holdsPeople(prop.type)) {
        for (const id of Array.isArray(value) ? value : []) {
          const name = typeof id === "string" ? names.get(id) : undefined;
          if (name) out.push(name);
        }
      }
  }
}

/** Everything a search looks through in a row, folded and joined. */
export function rowSearchText(row: RowLike, props: Prop[], context: RowSearchContext = {}): string {
  const names = new Map((context.people ?? []).map((p) => [p.id, p.name]));
  const texts = [row.title];
  for (const prop of props) valueTexts(prop, row.properties[prop.id], names, context, texts);
  return foldSearchText(texts.join("\n"));
}

/** The rows holding every word of `query`, in their order; all of them for an empty query. */
export function searchRows<T extends RowLike>(rows: T[], query: string, props: Prop[], context: RowSearchContext = {}): T[] {
  const words = searchWords(query);
  if (!words.length) return rows;
  return rows.filter((row) => {
    const text = rowSearchText(row, props, context);
    return words.every((word) => text.includes(word));
  });
}
