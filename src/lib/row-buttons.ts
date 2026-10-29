// Client-safe: a button property's settings, shared by its cell, the property menu and the server.

/**
 * A button property puts a button on every row of a database. It holds no value: clicking it on a
 * row starts the database's automations whose trigger is that button (lib/automations
 * `button_clicked`), on that row, as row triggers run (the automation's person's access, with
 * whoever clicked as `{{trigger.actor}}`). Clicking takes edit access to the row and to the
 * property (server/row-buttons.ts). Its options say how it looks: a label (the property's name
 * when missing) and a color of the option palette.
 */

/** The palette a button's color is one of: the option colors (`.opt-*` in globals.css). */
export const ROW_BUTTON_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type RowButtonColor = (typeof ROW_BUTTON_COLORS)[number];

export type RowButtonOptions = { label?: string; color?: RowButtonColor };

/** The longest label a button shows. */
export const MAX_ROW_BUTTON_LABEL = 60;

/** The most clicks of one row's button by one person a minute (server/row-buttons.ts). */
export const ROW_BUTTON_CLICKS_PER_MINUTE = 10;

/**
 * A button's options as kept: a label of one line (none when empty) and a known color (none for
 * the plain button). Anything else is dropped.
 */
export function cleanRowButtonOptions(input: unknown): RowButtonOptions {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  const label = typeof raw.label === "string" ? raw.label.replace(/\s+/g, " ").trim().slice(0, MAX_ROW_BUTTON_LABEL) : "";
  const color = ROW_BUTTON_COLORS.find((c) => c === raw.color);
  return { ...(label ? { label } : {}), ...(color ? { color } : {}) };
}

/** What a button says on rows: its label, or the property's name. */
export const rowButtonLabel = (prop: { name: string; options: { button?: RowButtonOptions } }) =>
  prop.options.button?.label || prop.name;

/** A button's color, or null for the plain one. */
export const rowButtonColor = (prop: { options: { button?: RowButtonOptions } }): RowButtonColor | null =>
  ROW_BUTTON_COLORS.find((c) => c === prop.options.button?.color) ?? null;
