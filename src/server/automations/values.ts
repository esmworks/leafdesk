import { idsOf, textOf } from "@/lib/automation-templates";
import { holdsPeople, type PropertyType } from "@/lib/property-types";

/**
 * A value a step writes (templates already written in) made fit for the property it goes into,
 * for automations (run.ts) and buttons (server/buttons.ts) alike. The row write checks the rest.
 */
export function coerceValue(prop: { type: PropertyType }, value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (prop.type === "relation" || holdsPeople(prop.type) || prop.type === "multi_select" || prop.type === "files") {
    if (prop.type === "files") return value;
    return idsOf(value);
  }
  if (prop.type === "number") {
    if (typeof value === "number") return value;
    const n = Number(textOf(value).trim());
    return Number.isFinite(n) && textOf(value).trim() !== "" ? n : textOf(value);
  }
  if (prop.type === "checkbox") {
    if (typeof value === "boolean") return value;
    const text = textOf(value).trim().toLowerCase();
    return text === "true" || text === "yes" || text === "1";
  }
  if (prop.type === "checklist") return value;
  // A place from another row stays one; text is looked up as an address when the row is written.
  if (prop.type === "place" && value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "object") return textOf(value);
  return value;
}
