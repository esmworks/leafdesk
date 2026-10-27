import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import { valueType } from "./derived";
import { isGroupable } from "./properties";

// What a pivot's rows and columns can stand for, apart from lib/pivot so that modules checking a
// property against a view's settings (convert-property) don't bring the calculations along.

/** Text a pivot groups by its value: one group per distinct text. */
const TEXT_TYPES = new Set<PropertyType>(["text", "url", "email", "phone"]);

/** Whether a pivot groups the property's values as text (text formulas and rollups too). */
export function groupsByText(prop: { type: PropertyType; options: PropertyOptions }) {
  return TEXT_TYPES.has(valueType(prop));
}

/** Whether a pivot can group by the property: what other views group by, and text. */
export function isPivotGroupable(prop: { type: PropertyType; options: PropertyOptions }) {
  return isGroupable(prop.type) || groupsByText(prop);
}
