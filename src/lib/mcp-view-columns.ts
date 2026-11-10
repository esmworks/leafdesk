import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import { derivedType, rollupFormat } from "./derived";
import type { ViewColumn } from "./mcp-view";
import { valueFormat, type NumberFormat } from "./number-format";
import { holdsPeople, isAction } from "./property-types";

/** How show_database's view shows each property's values (lib/mcp-view.ts). */

type Prop = { name: string; type: PropertyType; options: PropertyOptions };

/** How `prop`'s values show as a column, or null for a type that has no values to show (buttons). */
export function viewColumn(prop: Prop): ViewColumn | null {
  const { name, type, options } = prop;
  if (isAction(type)) return null;
  if (type === "select" || type === "status" || type === "multi_select") {
    return { name, kind: "options", colors: Object.fromEntries((options.options ?? []).map((o) => [o.name, o.color])) };
  }
  if (holdsPeople(type) || type === "relation" || type === "files") return { name, kind: "names" };
  if (type === "date" || type === "created_time" || type === "last_edited_time") return { name, kind: "date" };
  if (type === "checkbox") return { name, kind: "checkbox" };
  if (type === "checklist") return { name, kind: "checklist" };
  if (type === "number") return numberColumn(name, valueFormat(prop));
  if (type === "rollup") {
    const shown = rollupFormat(options.rollup?.function);
    if (shown === "list") return { name, kind: "names" };
    if (shown === "date") return { name, kind: "date" };
    return numberColumn(name, shown === "percent" ? { format: "percent" } : undefined);
  }
  if (type === "formula") {
    const result = derivedType(prop);
    if (result === "number") return numberColumn(name, valueFormat(prop));
    if (result === "date") return { name, kind: "date" };
    if (result === "checkbox") return { name, kind: "checkbox" };
  }
  return { name, kind: "text" };
}

const numberColumn = (name: string, format: NumberFormat | undefined): ViewColumn => ({ name, kind: "number", ...(format ? { format } : {}) });
