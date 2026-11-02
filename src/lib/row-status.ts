import type { SelectOption } from "@/db/schema/app";
import { SELECT_COLORS, statusGroupOf } from "./properties";

/**
 * A row's status as a mention of the row shows it (server/mentions.ts resolvePageRefs): the
 * option its database's first status property holds, its color (one of SELECT_COLORS) and whether
 * it is in the "done" group.
 */
export type RowStatus = { name: string; color: (typeof SELECT_COLORS)[number]; done: boolean };

/** The status a stored option (read as JSON, so checked) gives; null for no option or a broken one. */
export function rowStatusOf(option: unknown): RowStatus | null {
  if (!option || typeof option !== "object" || Array.isArray(option)) return null;
  const { name, color, group } = option as Partial<Record<keyof SelectOption, unknown>>;
  if (typeof name !== "string" || !name.trim()) return null;
  const known = SELECT_COLORS.find((c) => c === color) ?? "gray";
  return { name, color: known, done: statusGroupOf({ group: group as SelectOption["group"] }) === "done" };
}
