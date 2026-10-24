import { DATE_UNITS } from "./dates";
import { FORMULA_FUNCTIONS, type FormulaFunctionGroup } from "./engine";
import { STYLE_COLORS } from "./styles";

/**
 * The formula language as a reference for a model writing formulas (server/formula-ai.ts): the
 * syntax, then every function of the engine by group, with its signature from the engine itself,
 * so a function added there is in here too. Notes say what a signature can't.
 */

const GROUP_ORDER: FormulaFunctionGroup[] = ["logic", "text", "number", "date", "list", "conversion", "style"];

/** What a signature doesn't say, by function name; every name must be one of FORMULA_FUNCTIONS (a test checks). */
export const FUNCTION_NOTES: Record<string, string> = {
  if: "both branches give the same type",
  ifs: "the first condition that holds picks its value; the last argument is the value otherwise",
  empty: "true for an empty text, list, date or number",
  contains: "a text contains a text, or a list holds an item",
  slice: "from start (0 is the first character) up to, not including, end",
  join: "a list's items as one text",
  format: "any value as text",
  style: `styles: "b" bold, "i" italic, "u" underline, "s" strikethrough, "c" code, a color (${STYLE_COLORS.join(", ")}) or a background ("red_background")`,
  unstyle: "takes those styles off again",
  map: "each item of a list through an expression, the item being `current`",
  filter: "the items for which the condition holds, the item being `current`",
  find: "the first item for which the condition holds",
  some: "whether the condition holds for any item",
  every: "whether the condition holds for every item",
  at: "the item at an index, 0 the first, -1 the last",
  average: "of the numbers given, or a list's; empty values don't count",
  mean: "the same as average",
  median: "the middle number, or the mean of the two middle ones for an even count; empty values don't count",
  round: "to `digits` decimals, 0 without",
  now: "the date and time now",
  today: "today's date, without a time",
  dateAdd: "unit is one of the units above, as text",
  dateSubtract: "unit is one of the units above, as text",
  dateBetween: "the first date minus the second in whole units, rounded toward zero: dateBetween(prop(\"Due\"), today(), \"days\") is the days left until Due",
  formatDate: "tokens YYYY YY, MMMM (January) MMM MM M, DD D, dddd (Monday) ddd, HH H, hh h with A (AM/PM), mm, ss; text in [brackets] stays as is",
  dateStart: "the start of a date range",
  dateEnd: "the end of a date range",
  weekday: "1 for Monday to 7 for Sunday",
  timestamp: "milliseconds since 1970",
  toNumber: "a text's number, a checkbox as 1 or 0, a date as milliseconds",
  parseDate: "a date from text such as 2026-10-24",
};

export function formulaReference(): string {
  const groups = GROUP_ORDER.map((group) => {
    const lines = FORMULA_FUNCTIONS.filter((f) => f.group === group).map((f) => {
      const note = FUNCTION_NOTES[f.name];
      return `- ${f.signature}${note ? `: ${note}` : ""}`;
    });
    return lines.length ? `${group[0].toUpperCase()}${group.slice(1)}:\n${lines.join("\n")}` : "";
  }).filter(Boolean);
  return [
    "Syntax:",
    '- prop("Name") reads a property of the row by its name; prop("title") is the row\'s title.',
    '- Literals: numbers (3, 2.5), text in double quotes ("late"; \\" for a quote), true, false.',
    '- Operators: + - * / % ^ for numbers ("+" also joins texts), == != < <= > >= (dates compare too), and, or, not, and parentheses.',
    '- How properties read: text, URL, email, phone, select and status as their text (an option\'s name); number; checkbox as true or false; date, created and edited time as dates; multi-select, person, files, created by and edited by as lists of texts; a checklist as the share of ticked items (0 to 1); a relation as its rows (their titles in text and lists); in map(), filter() and the like, prop(current, "Name") reads a property of the related row.',
    `- Date units: ${DATE_UNITS.join(", ")}. Dates work in UTC.`,
    "- An empty value: an empty text \"\", or empty(prop(\"Name\")) to test for one.",
    "",
    "Functions:",
    ...groups,
  ].join("\n");
}
