import { formatDateValueIn } from "./date-value";
import type { ViewColumn } from "./mcp-view";
import { formatInFormat } from "./number-format";

/**
 * What a cell of show_database's view shows, from a value as query_database returns it: text, chips
 * (options in their colors; related rows, people and files by name) or a checkbox. Pure, so tests
 * and the view's bundle (src/mcp-app/) run the same code.
 */
export type ViewCell =
  | { kind: "text"; text: string; number?: boolean }
  | { kind: "chips"; chips: { text: string; color?: string }[] }
  | { kind: "check"; checked: boolean };

/** The reader's language and time zone, which numbers and dates show in. */
export type CellFormat = { locale: string; timeZone: string };

/** The cell `value` makes in `column`, or null when it shows nothing. */
export function viewCell(column: ViewColumn, value: unknown, f: CellFormat): ViewCell | null {
  if (value === null || value === undefined || value === "") return null;
  // A formula that fails on this row, as query_database writes it.
  if (isError(value)) return { kind: "text", text: "#ERROR" };
  switch (column.kind) {
    case "options": {
      const chips = list(value).map((name) => ({ text: name, color: column.colors?.[name] }));
      return chips.length ? { kind: "chips", chips } : null;
    }
    case "names": {
      const chips = list(value).map((text) => ({ text }));
      return chips.length ? { kind: "chips", chips } : null;
    }
    case "checkbox":
      return typeof value === "boolean" ? { kind: "check", checked: value } : text(value);
    case "checklist": {
      if (!Array.isArray(value)) return text(value);
      const done = value.filter((item) => (item as { checked?: unknown })?.checked === true).length;
      return { kind: "text", text: `${done}/${value.length}`, number: true };
    }
    case "date": {
      const shown = formatDateValueIn(value, f.locale, f.timeZone);
      return shown ? { kind: "text", text: shown } : text(value);
    }
    case "number":
      if (typeof value !== "number") return text(value);
      return { kind: "text", text: formatInFormat(value, column.format, (n, options) => numberFormat(f.locale, options).format(n)), number: true };
    default:
      return text(value);
  }
}

function isError(value: unknown): value is { error: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "error" in value;
}

/** A value's parts as names: option names, related rows' titles, people's and files' names. */
function list(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    const name = nameOf(item);
    return name ? [name] : [];
  });
}

function nameOf(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item !== "object") return String(item);
  const named = item as { title?: unknown; name?: unknown; address?: unknown };
  for (const key of [named.title, named.name, named.address]) if (typeof key === "string" && key) return key;
  return "";
}

/** Anything else as one line of text: a place by its name or address, lists joined. */
function text(value: unknown): ViewCell | null {
  const shown = Array.isArray(value) ? list(value).join(", ") : nameOf(value);
  return shown ? { kind: "text", text: shown } : null;
}

const formats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions) {
  const key = `${locale} ${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    formats.set(key, format);
  }
  return format;
}
