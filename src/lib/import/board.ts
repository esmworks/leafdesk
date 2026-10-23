import { checkDateInput } from "../date-value";
import { isEmailAddress, isPhoneNumber, SELECT_COLORS } from "../properties";
import type { StatusGroup } from "../property-types";
import { isTimeZone, zoneOffset } from "../time-zone";
import {
  CSV_MAX_COLUMNS,
  CSV_MAX_ROWS,
  detectDateFormat,
  guessColumn,
  INVALID,
  parseCheckbox,
  parseDate,
  parseNumber,
  splitList,
  type DateFormat,
} from "./csv";
import { ImportError } from "./result";

/**
 * A project board read from another app's export, for import as a database (see
 * server/import/board): Asana projects (lib/import/asana) and Monday.com boards (lib/import/monday)
 * come in as one of these. Pure, so the import dialog previews a file with the same code the server
 * imports it with.
 *
 * Items are rows; their group (Asana's section, Monday's group) a select the database's board view
 * is grouped by; their parent the row they are a sub-item of; the items they wait for its
 * dependencies; columns properties of their own. Nothing an export links to is fetched: links stay
 * links.
 */

/** What a column can become; the import dialog offers these (or leaving the column out). */
export const BOARD_COLUMN_TYPES = ["text", "number", "select", "multi_select", "status", "person", "date", "checkbox", "url", "email", "phone"] as const;
export type BoardColumnType = (typeof BOARD_COLUMN_TYPES)[number];

export type BoardColor = (typeof SELECT_COLORS)[number];
export type BoardOption = { name: string; color?: BoardColor; group?: StatusGroup };
export type BoardPerson = { name: string; email: string | null };

/** A cell: text as written, a list (tags, several people by name), or people the export names with their address. */
export type BoardCell = string | string[] | BoardPerson[];

export type BoardColumn = {
  /** The column's name in the export. */
  name: string;
  /** Columns every export of the app has, which the import names in the importer's language. */
  role?: "assignee" | "tags";
  /** What it becomes unless the importer picks otherwise (guessed when the export doesn't say). */
  type: BoardColumnType;
  /** Options of a select, multi-select or status, in order, when the export says what they are. */
  options?: BoardOption[];
};

export type BoardComment = { author: string; /** An ISO instant, or null when the export's time can't be read. */ date: string | null; text: string };

export type BoardItem = {
  /** The export's id of the item (Asana's task id, Monday's item id), or null. */
  id: string | null;
  title: string;
  /** Index into `groups`. */
  group: number | null;
  /** Index of the item this one is a sub-item of. */
  parent: number | null;
  /** Indexes of the items this one waits for. */
  blockedBy: number[];
  /** Asana: whether the task is completed. Null when the export doesn't say (Monday keeps it in a status column). */
  done: boolean | null;
  /** Asana: the start and due dates as one date value (see lib/date-value). */
  dates: string | null;
  /** By column, "" when empty. */
  cells: BoardCell[];
  /** Markdown. */
  body: string;
  /** Files and links attached to the item, as links. */
  attachments: { name: string; url: string }[];
  /** Oldest first. */
  comments: BoardComment[];
};

export type Board = {
  source: "asana" | "monday";
  title: string;
  /** Asana's sections, Monday's groups, in order. */
  groups: string[];
  columns: BoardColumn[];
  items: BoardItem[];
  /** Columns of the export that aren't imported (Leafdesk keeps its own creation and edit times). */
  leftOut: string[];
  /** Sheets of a workbook other than the board and its updates. */
  otherSheets: string[];
  /** Links between items that name no item of the export, or would close a loop, by the column naming them. */
  unlinked: { column: string; count: number }[];
  /** The id of the item an address of the app leads to, or null (links to items become links to their rows). */
  linkedId: (url: string) => string | null;
};

export const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** A cell as text: lists and people joined with commas. */
export function cellText(cell: BoardCell): string {
  if (typeof cell === "string") return cell;
  return cell.map((v) => (typeof v === "string" ? v : v.name || v.email || "")).filter(Boolean).join(", ");
}

/** A cell as a list of values: text split at commas. */
export function cellList(cell: BoardCell): string[] {
  if (typeof cell === "string") return splitList(cell);
  return cell.map((v) => (typeof v === "string" ? v : v.name || v.email || "")).filter(Boolean);
}

/** A cell as people: names split at commas, unless the export names them with their address. */
export function cellPeople(cell: BoardCell): BoardPerson[] {
  if (typeof cell === "string" || cell.every((v) => typeof v === "string")) return cellList(cell).map((name) => ({ name, email: null }));
  return cell as BoardPerson[];
}

/**
 * The status group an option belongs in, by its name: done words (Done, Complete, Approved,
 * Tamamlandı, Erledigt…) done, words for work under way (Working on it, In progress, Stuck,
 * Review…) in progress, anything else to do.
 */
export function statusGroupFor(name: string): StatusGroup {
  const s = name.trim().toLocaleLowerCase();
  if (DONE_WORDS.some((w) => s === w || s.startsWith(`${w} `))) return "done";
  // "Not started", "Not done yet".
  if (/^not\b/.test(s)) return "todo";
  if (PROGRESS_WORDS.some((w) => s.includes(w))) return "in_progress";
  return "todo";
}

const DONE_WORDS = [
  ...["done", "complete", "completed", "finished", "closed", "resolved", "approved", "shipped", "delivered", "live", "won"],
  ...["tamamlandı", "bitti", "erledigt", "fertig", "hecho", "terminado", "terminé", "fait", "fatto", "completato", "concluído", "feito"],
  ...["gotowe", "zrobione", "готово", "выполнено", "виконано", "完了", "完成", "완료"],
];
const PROGRESS_WORDS = [
  ...["working", "progress", "doing", "stuck", "review", "waiting", "blocked", "testing", "started", "ongoing", "on hold"],
  ...["devam", "sürüyor", "bearbeitung", "curso", "cours", "corso", "andamento", "trakcie", "работ", "робот", "進行", "进行", "진행"],
];

/** An app's color name as the nearest of Leafdesk's (Asana's "dark-teal", "light-orange", "hot-pink"…). */
export function boardColor(color: unknown): BoardColor | undefined {
  const name = typeof color === "string" ? color.toLowerCase() : "";
  if (!name || name === "none") return undefined;
  if (/red|crimson/.test(name)) return "red";
  if (/pink|magenta|fuchsia/.test(name)) return "pink";
  if (/purple|violet|indigo/.test(name)) return "purple";
  if (/blue|teal|aqua|cyan|navy/.test(name)) return "blue";
  if (/green|lime|olive/.test(name)) return "green";
  if (/yellow|gold/.test(name)) return "yellow";
  if (/orange/.test(name)) return "orange";
  if (/brown|sand/.test(name)) return "brown";
  return "gray";
}

/** The sides of a date cell written as a range: "a - b" (Monday's timelines), "a → b", or the stored "a/b". */
function dateSides(raw: string): string[] {
  const s = raw.trim();
  const iso = /^(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?)\/(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?)$/.exec(s);
  if (iso) return [iso[1], iso[2]];
  return s.split(/\s+(?:-|–|→|->)\s+/).map((side) => side.trim());
}

/** How a date column writes its dates, both sides of ranges counted; null when some cell isn't a date. */
export function boardDateFormat(values: string[]): DateFormat | null {
  return detectDateFormat(values.flatMap((v) => (v.trim() ? dateSides(v) : [])));
}

/** A date cell as a date value: a day or a time, or a range of either; null when it isn't one. */
export function boardDate(raw: string, format: DateFormat, timeZone = "UTC"): string | null {
  const [first, second, ...rest] = dateSides(raw);
  if (!first || rest.length) return null;
  const start = parseDate(first, format, timeZone);
  if (!start || !second) return start;
  const end = parseDate(second, format, timeZone);
  if (!end) return null;
  return dateRange(start, end);
}

/** Start and end as one date value: a range when they fit together (the end not first), else the end. */
export function dateRange(start: string | null, end: string | null): string | null {
  if (!start || !end) return end ?? start;
  if (start === end) return start;
  const checked = checkDateInput({ start, end }, "");
  return checked.ok ? checked.value : end;
}

/** The first web address in a cell ("Docs - https://…", Monday's links with their text). */
function webAddress(raw: string): string | null {
  return /https?:\/\/[^\s<>"]+/i.exec(raw)?.[0] ?? null;
}

/** An email address in a cell ("Ada - ada@example.com", "mailto:ada@example.com"). */
function emailAddress(raw: string): string | null {
  const found = /[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+/.exec(raw.replace(/^mailto:/i, ""))?.[0];
  return found && isEmailAddress(found) ? found : null;
}

/** Checkbox cells: Monday writes a checked one as "v". */
function boardCheckbox(raw: string): boolean | null {
  return /^v$/i.test(raw.trim()) ? true : parseCheckbox(raw);
}

/**
 * The type a column's values suggest, as the CSV import guesses (lib/import/csv guessColumn), and
 * date ranges, web addresses and email addresses written with a label, and Monday's "v" checkboxes.
 */
export function guessBoardColumn(values: string[]): { type: BoardColumnType; options?: BoardOption[] } {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (!filled.length) return { type: "text" };
  if (filled.every((v) => /^v$/i.test(v))) return { type: "checkbox" };
  const guess = guessColumn(filled);
  if (guess.type !== "text") {
    const type = guess.type;
    return guess.options ? { type, options: guess.options.map((name) => ({ name: name.slice(0, 200) })) } : { type };
  }
  if (boardDateFormat(filled)) return { type: "date" };
  if (filled.every((v) => webAddress(v) && / - https?:\/\/\S+$/i.test(v))) return { type: "url" };
  if (filled.every((v) => emailAddress(v) && / - \S+@\S+$/.test(v))) return { type: "email" };
  return { type: "text" };
}

/**
 * A cell as a value of a property of `type`, in the form row writes take (option names): null for
 * an empty cell, INVALID for one that can't be a value (a word in a number column). People are
 * matched by the importer (see cellPeople).
 */
export function boardValue(type: BoardColumnType, cell: BoardCell, { dateFormat, timeZone }: { dateFormat?: DateFormat | null; timeZone?: string } = {}): unknown {
  const text = cellText(cell).trim();
  if (!text) return null;
  switch (type) {
    case "text":
      return cellText(cell);
    case "number":
      return parseNumber(text) ?? INVALID;
    case "checkbox":
      return boardCheckbox(text) ?? INVALID;
    case "date": {
      const format = dateFormat ?? boardDateFormat([text]);
      return (format && boardDate(text, format, timeZone)) || INVALID;
    }
    case "url":
      return webAddress(text) ?? INVALID;
    case "email":
      return emailAddress(text) ?? INVALID;
    case "phone": {
      const phone = text.replace(/^tel:/i, "");
      return isPhoneNumber(phone) ? phone : INVALID;
    }
    case "select":
    case "status":
      return text.slice(0, 200);
    case "multi_select":
      return cellList(cell).map((v) => v.slice(0, 200));
    case "person":
      return cellPeople(cell);
  }
}

/** A column's options for `type`: the export's when it gave them for that type, else its values in order of first appearance. */
export function columnOptions(column: BoardColumn, type: BoardColumnType, cells: BoardCell[]): BoardOption[] {
  const given = column.type === type && column.options?.length ? column.options : null;
  const names = new Map<string, string>();
  for (const option of given ?? []) if (!names.has(option.name.toLowerCase())) names.set(option.name.toLowerCase(), option.name);
  for (const cell of cells) {
    const values = type === "multi_select" ? cellList(cell) : [cellText(cell).trim()];
    for (const raw of values) {
      const name = raw.slice(0, 200);
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
  }
  const byName = new Map((given ?? []).map((o) => [o.name.toLowerCase(), o]));
  return [...names.values()].map((name) => {
    const option = byName.get(name.toLowerCase()) ?? { name };
    return type === "status" ? { ...option, group: option.group ?? statusGroupFor(name) } : option;
  });
}

/** Refuses a board with more items or columns than an import takes. */
export function checkBoardSize(items: number, columns: number) {
  if (items > CSV_MAX_ROWS) throw new ImportError(`A board can have at most ${CSV_MAX_ROWS} items`, "tooManyRows", { limit: CSV_MAX_ROWS });
  if (columns > CSV_MAX_COLUMNS) {
    throw new ImportError(`A board can have at most ${CSV_MAX_COLUMNS} columns`, "tooManyColumns", { limit: CSV_MAX_COLUMNS });
  }
}

/**
 * Finds items by what an export writes to name one: its id, else its title when exactly one item
 * has it (titles compared without case).
 */
export function itemFinder(items: Pick<BoardItem, "id" | "title">[]) {
  const byId = new Map<string, number>();
  const byTitle = new Map<string, number[]>();
  items.forEach((item, i) => {
    if (item.id) byId.set(item.id, i);
    const key = item.title.toLowerCase();
    if (key) byTitle.set(key, [...(byTitle.get(key) ?? []), i]);
  });
  return (ref: string): number | null => {
    const s = oneLine(ref);
    if (!s) return null;
    if (byId.has(s)) return byId.get(s)!;
    const same = byTitle.get(s.toLowerCase());
    return same?.length === 1 ? same[0] : null;
  };
}

/**
 * The items a cell names, one per comma-separated entry, or the whole cell when it names one (a
 * title with a comma in it). Entries that name nothing are counted in `missing`.
 */
export function findItems(find: (ref: string) => number | null, cell: string, missing: { count: number }): number[] {
  if (!cell.trim()) return [];
  const whole = find(cell);
  if (whole !== null) return [whole];
  const found: number[] = [];
  for (const ref of splitList(cell)) {
    const i = find(ref);
    if (i === null) missing.count++;
    else if (!found.includes(i)) found.push(i);
  }
  return found;
}

/**
 * Leaves out parents that would make an item its own ancestor (only from a file made by hand) and
 * dependencies that would make an item wait for itself; returns how many of each were left out.
 */
export function breakLoops(items: Pick<BoardItem, "parent" | "blockedBy">[]): { parents: number; dependencies: number } {
  let parents = 0;
  items.forEach((item, i) => {
    const seen = new Set<number>([i]);
    for (let at = item.parent; at !== null; at = items[at].parent) {
      if (seen.has(at)) {
        item.parent = null;
        parents++;
        break;
      }
      seen.add(at);
    }
  });
  let dependencies = 0;
  const blockers = new Map<number, number[]>();
  const waitsFor = (from: number, target: number) => {
    const seen = new Set<number>();
    const stack = [from];
    while (stack.length) {
      const at = stack.pop()!;
      if (at === target) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(blockers.get(at) ?? []));
    }
    return false;
  };
  items.forEach((item, i) => {
    item.blockedBy = item.blockedBy.filter((b) => {
      if (waitsFor(b, i)) {
        dependencies++;
        return false;
      }
      blockers.set(i, [...(blockers.get(i) ?? []), b]);
      return true;
    });
  });
  return { parents, dependencies };
}

/** Sub-items without a group of their own go in their parent's. */
export function inheritGroups(items: Pick<BoardItem, "parent" | "group">[]) {
  for (const item of items) {
    const seen = new Set<number>();
    for (let at = item.parent; item.group === null && at !== null && !seen.has(at); at = items[at].parent) {
      seen.add(at);
      item.group = items[at].group;
    }
  }
}

/** A comment's time as `YYYY-MM-DD HH:mm` in `timeZone`. */
function commentTime(iso: string, timeZone: string) {
  const ms = Date.parse(iso);
  const offset = isTimeZone(timeZone) ? zoneOffset(ms, timeZone) : 0;
  return new Date(ms + offset).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Links in Markdown: `[text](target)` (groups 1–2), `<address>` (3), or a bare address (4). Taking
 * whole links first keeps an address in a link's text from being rewritten on its own.
 */
const LINKS = /\[([^\]\n]*)\]\(([^()\s]+)(?:\s+"[^"\n]*")?\)|<(https?:\/\/[^<>\s]+)>|(https?:\/\/[^\s()<>\]]+)/g;

/**
 * Markdown with its links to items sent through `itemLink` (an address to the address of the
 * item's row, or null to leave it), and images made links (nothing is loaded from elsewhere).
 */
export function boardMarkdown(markdown: string, itemLink: (url: string) => string | null = () => null): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/!\[([^\]\n]*)\]\(/g, (_, alt: string) => `[${alt || "image"}](`)
    .replace(LINKS, (match, text?: string, target?: string, angled?: string, bare?: string) => {
      const url = target ?? angled ?? bare!;
      const to = itemLink(url);
      if (!to) return match;
      return target !== undefined ? `[${text}](${to})` : `[${url}](${to})`;
    });
}

/**
 * An item's row body: its description, then its attachments and its comments (oldest first, each
 * under its author and time) under headings named by `headings`.
 */
export function itemBody(
  item: Pick<BoardItem, "body" | "attachments" | "comments">,
  headings: { attachments: string; comments: string },
  { timeZone = "UTC", itemLink }: { timeZone?: string; itemLink?: (url: string) => string | null } = {},
): string {
  const parts: string[] = [];
  if (item.body.trim()) parts.push(boardMarkdown(item.body.trim(), itemLink));
  if (item.attachments.length) {
    parts.push(`### ${headings.attachments}`, item.attachments.map((a) => `- [${escapeLinkText(a.name)}](<${a.url}>)`).join("\n"));
  }
  if (item.comments.length) {
    parts.push(`### ${headings.comments}`);
    for (const comment of item.comments) {
      const time = comment.date ? ` · ${commentTime(comment.date, timeZone)}` : "";
      parts.push(`**${escapeLinkText(comment.author)}**${time}`, boardMarkdown(comment.text.trim(), itemLink));
    }
  }
  return parts.join("\n\n");
}

function escapeLinkText(text: string) {
  return text.replace(/([\\[\]*_`])/g, "\\$1");
}

/** An http(s) address, else null. */
export function webUrl(value: unknown): string | null {
  const url = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\/\S+$/i.test(url) ? url : null;
}

/** An instant an export wrote (with its zone, or UTC without one), as an ISO string; null when it isn't one. */
export function exportInstant(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(text)) return null;
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text.replace(" ", "T") : `${text.replace(" ", "T")}Z`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
