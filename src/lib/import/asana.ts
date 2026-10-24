import { csvTable, decodeText, detectDateFormat, parseDate, splitList, type CsvTable } from "./csv";
import { cleanTitle } from "./markdown";
import { ImportError } from "./result";
import {
  boardColor,
  breakLoops,
  checkBoardSize,
  dateRange,
  exportInstant,
  findItems,
  guessBoardColumn,
  inheritGroups,
  itemFinder,
  oneLine,
  webUrl,
  type Board,
  type BoardCell,
  type BoardColumn,
  type BoardComment,
  type BoardItem,
  type BoardOption,
  type BoardPerson,
} from "./board";

/**
 * Reading an Asana project's export for import as a database (see lib/import/board): the CSV of
 * the project's *Export → CSV*, or the JSON of *Export → JSON*.
 *
 * The CSV's columns: Task ID, Created At, Completed At, Last Modified, Name, Section/Column,
 * Assignee, Assignee Email, Start Date, Due Date, Tags, Notes, Projects, Parent task, Blocked By
 * (Dependencies), Blocking (Dependencies), then one per custom field (typed by its values, as CSV
 * imports guess). A task becomes a row: its section a select option (in the order sections first
 * appear), Completed At a status (to do or done), its assignee a person (matched by email by the
 * importer), start and due dates one date (a range when both are set), its tags a multi-select,
 * its notes the row's body, its parent task the row it is a sub-item of, and the tasks it is
 * blocked by and blocking its dependencies. Parents and dependencies are found by task id, else by
 * name when exactly one task has it. Created At, Last Modified and Projects are left out.
 *
 * The JSON (`{ "data": [task, …] }`, tasks as Asana's API writes them, subtasks nested in their
 * task's `subtasks`) gives the same, with its custom fields' own types and colors, comments
 * (`stories`) and attachments (as links).
 */

const CSV_COLUMNS = {
  id: ["taskid", "id", "gid"],
  createdAt: ["createdat"],
  completedAt: ["completedat"],
  modifiedAt: ["lastmodified", "modifiedat"],
  name: ["name", "taskname"],
  section: ["sectioncolumn", "section", "column"],
  assignee: ["assignee"],
  email: ["assigneeemail"],
  start: ["startdate", "starton"],
  due: ["duedate", "dueon"],
  tags: ["tags"],
  notes: ["notes", "description"],
  projects: ["projects", "project"],
  parent: ["parenttask", "parent"],
  blockedBy: ["blockedbydependencies", "blockedby", "dependencies"],
  blocking: ["blockingdependencies", "blocking", "dependents"],
} as const;
type CsvColumn = keyof typeof CSV_COLUMNS;

const headerKey = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A link to an Asana task (app.asana.com/0/<project>/<task>, …/project/<p>/task/<task>); the task's id. */
export function asanaTaskId(url: string): string | null {
  const m = /^https?:\/\/app\.asana\.com\/(?:0\/\d+\/(\d+)(?:\/f)?|\d+\/\d+\/(?:project\/\d+\/)?task\/(\d+))(?:[/?#]|$)/i.exec(url);
  return m ? (m[1] ?? m[2]) : null;
}

/** Whether a CSV table is an Asana export: it has a Task ID and a Name column. */
export function isAsanaCsv(table: CsvTable) {
  const keys = table.headers.map(headerKey);
  return keys.includes("taskid") && keys.includes("name");
}

/** Whether parsed JSON is an Asana export: `{ data: [task…] }`, tasks with a gid and a name. */
export function isAsanaJson(json: unknown): json is { data: Json[] } {
  if (!isObject(json) || !Array.isArray(json.data)) return false;
  return json.data.every((t) => isObject(t) && (typeof t.gid === "string" || typeof t.id === "number") && typeof t.name === "string");
}

/**
 * Reads an export, CSV or JSON by its content. Throws ImportError("badAsana") when it is neither,
 * or a size error when it has more tasks or fields than an import takes.
 */
export function readAsanaExport(fileName: string, bytes: Uint8Array): Board {
  const text = decodeText(bytes).replace(/^﻿/, "");
  if (/^\s*[{[]/.test(text)) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw notAsana();
    }
    if (!isAsanaJson(json)) throw notAsana();
    return readAsanaJson(json, fileName);
  }
  const table = csvTable(text);
  if (!isAsanaCsv(table)) throw notAsana();
  return readAsanaCsv(table, fileName);
}

const notAsana = () => new ImportError("The file isn't an Asana project export", "badAsana");

/** The project most tasks are in: the database's name. */
function mainProject(lists: string[][], fileName: string) {
  const counts = new Map<string, number>();
  for (const list of lists) for (const name of new Set(list)) counts.set(name, (counts.get(name) ?? 0) + 1);
  let best = "";
  for (const [name, count] of counts) if (count > (counts.get(best) ?? 0)) best = name;
  return best || cleanTitle(fileName);
}

/** A CSV export's tasks. */
export function readAsanaCsv(table: CsvTable, fileName = ""): Board {
  const keys = table.headers.map(headerKey);
  const at = Object.fromEntries(
    (Object.keys(CSV_COLUMNS) as CsvColumn[]).map((name) => [name, keys.findIndex((k) => (CSV_COLUMNS[name] as readonly string[]).includes(k))]),
  ) as Record<CsvColumn, number>;
  const known = new Set(Object.values(at).filter((i) => i !== -1));
  const custom = table.headers.flatMap((_, i) => (known.has(i) ? [] : [i]));
  checkBoardSize(table.rows.length, custom.length + 5);
  const cell = (row: string[], name: CsvColumn) => (at[name] === -1 ? "" : (row[at[name]] ?? "").trim());
  const column = (name: CsvColumn) => table.rows.map((row) => cell(row, name));

  const groups: string[] = [];
  const groupOf = (name: string) => {
    const s = oneLine(name).slice(0, 200);
    if (!s) return null;
    const i = groups.findIndex((g) => g.toLowerCase() === s.toLowerCase());
    return i === -1 ? groups.push(s) - 1 : i;
  };
  const startFormat = detectDateFormat(column("start"));
  const dueFormat = detectDateFormat(column("due"));

  const columns: BoardColumn[] = [];
  const hasAssignee = column("assignee").some(Boolean) || column("email").some(Boolean);
  if (hasAssignee) columns.push({ name: table.headers[at.assignee] ?? table.headers[at.email], role: "assignee", type: "person" });
  const tagCells = column("tags").map(splitList);
  if (tagCells.some((t) => t.length)) columns.push({ name: table.headers[at.tags], role: "tags", type: "multi_select" });
  for (const i of custom) {
    const values = table.rows.map((row) => row[i] ?? "");
    columns.push({ name: table.headers[i], ...guessBoardColumn(values) });
  }

  const items: BoardItem[] = table.rows.map((row, r) => {
    const cells: BoardCell[] = [];
    if (hasAssignee) {
      const name = oneLine(cell(row, "assignee"));
      const email = cell(row, "email") || null;
      cells.push(name || email ? [{ name: name || email!, email }] : "");
    }
    if (tagCells.some((t) => t.length)) cells.push(tagCells[r]);
    for (const i of custom) cells.push(row[i] ?? "");
    const start = startFormat ? parseDate(cell(row, "start"), startFormat) : null;
    const due = dueFormat ? parseDate(cell(row, "due"), dueFormat) : null;
    return {
      id: cell(row, "id") || null,
      title: oneLine(cell(row, "name")),
      group: groupOf(cell(row, "section")),
      parent: null,
      blockedBy: [],
      done: at.completedAt === -1 ? null : Boolean(cell(row, "completedAt")),
      dates: dateRange(start, due),
      cells,
      body: at.notes === -1 ? "" : (row[at.notes] ?? "").trim(),
      attachments: [],
      comments: [],
    };
  });

  // Parents and dependencies, once every task is known.
  const find = itemFinder(items);
  const missing = { parent: { count: 0 }, blockedBy: { count: 0 }, blocking: { count: 0 } };
  table.rows.forEach((row, i) => {
    const [parent] = findItems(find, cell(row, "parent"), missing.parent);
    if (parent !== undefined && parent !== i) items[i].parent = parent;
    for (const b of findItems(find, cell(row, "blockedBy"), missing.blockedBy)) if (b !== i && !items[i].blockedBy.includes(b)) items[i].blockedBy.push(b);
    for (const w of findItems(find, cell(row, "blocking"), missing.blocking)) if (w !== i && !items[w].blockedBy.includes(i)) items[w].blockedBy.push(i);
  });
  const loops = breakLoops(items);
  inheritGroups(items);

  const title = mainProject(column("projects").map(splitList), fileName);
  const leftOut = (["createdAt", "modifiedAt"] as const).filter((name) => column(name).some(Boolean)).map((name) => table.headers[at[name]]);
  if (column("projects").some((p) => splitList(p).some((name) => name !== title))) leftOut.push(table.headers[at.projects]);
  const unlinked = [
    { column: table.headers[at.parent], count: missing.parent.count + loops.parents },
    { column: table.headers[at.blockedBy] ?? table.headers[at.blocking], count: missing.blockedBy.count + loops.dependencies },
    { column: table.headers[at.blocking], count: missing.blocking.count },
  ].filter((u) => u.count > 0 && u.column);

  return { source: "asana", title, groups, columns, items, leftOut, otherSheets: [], unlinked, linkedId: asanaTaskId };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const array = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);
const str = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const gidOf = (value: unknown) => (isObject(value) ? str(value.gid) || str(value.id) : "");

/** A JSON task's day or instant (`due_on` / `due_at`). */
function jsonDate(day: unknown, instant: unknown): string | null {
  const at = exportInstant(instant);
  if (at) return at;
  const s = str(day);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** A custom field's type: Asana's own, else text (formulas and the like as they show). */
function fieldType(field: Json): BoardColumn["type"] {
  switch (str(field.resource_subtype) || str(field.type)) {
    case "number":
      return "number";
    case "enum":
      return "select";
    case "multi_enum":
      return "multi_select";
    case "date":
      return "date";
    case "people":
      return "person";
    default:
      return "text";
  }
}

/** A custom field's value on a task, as a cell of its type. */
function fieldCell(field: Json, type: BoardColumn["type"]): BoardCell {
  switch (type) {
    case "number":
      return typeof field.number_value === "number" ? String(field.number_value) : str(field.display_value);
    case "select":
      return isObject(field.enum_value) ? oneLine(str(field.enum_value.name)) : "";
    case "multi_select":
      return array(field.multi_enum_values).map((o) => oneLine(str(o.name))).filter(Boolean);
    case "date": {
      const value = isObject(field.date_value) ? field.date_value : {};
      return jsonDate(value.date, value.date_time) ?? "";
    }
    case "person":
      return array(field.people_value).map((p): BoardPerson => ({ name: oneLine(str(p.name)), email: str(p.email) || null })).filter((p) => p.name || p.email);
    default:
      return str(field.text_value) || str(field.display_value);
  }
}

/** A JSON export's tasks, each followed by its subtasks. */
export function readAsanaJson(json: { data: Json[] }, fileName = ""): Board {
  const tasks: { task: Json; parent: number | null }[] = [];
  const walk = (list: Json[], parent: number | null, depth: number) => {
    for (const task of list) {
      const index = tasks.push({ task, parent }) - 1;
      if (depth < 20) walk(array(task.subtasks), index, depth + 1);
    }
  };
  walk(json.data, null, 0);

  // The project most tasks belong to; its sections are the groups.
  const projectsOf = (task: Json) => [
    ...array(task.projects).map((p) => [gidOf(p), oneLine(str(p.name))] as const),
    ...array(task.memberships).flatMap((m) => (isObject(m.project) ? [[gidOf(m.project), oneLine(str(m.project.name))] as const] : [])),
  ];
  const names = new Map<string, string>();
  for (const { task } of tasks) for (const [gid, name] of projectsOf(task)) if (gid && name) names.set(gid, name);
  const main = mainProject(tasks.map(({ task }) => [...new Set(projectsOf(task).map(([gid]) => gid))]), "");
  const title = names.get(main) ?? cleanTitle(fileName);

  const groups: string[] = [];
  const sectionOf = (task: Json) => {
    const membership = array(task.memberships).find((m) => !main || gidOf(m.project) === main) ?? array(task.memberships)[0];
    const name = isObject(membership?.section) ? oneLine(str(membership.section.name)).slice(0, 200) : "";
    if (!name) return null;
    const i = groups.findIndex((g) => g.toLowerCase() === name.toLowerCase());
    return i === -1 ? groups.push(name) - 1 : i;
  };

  // Custom fields by gid, in the order they first appear; options from the field's own list.
  const fields: { gid: string; column: BoardColumn }[] = [];
  for (const { task } of tasks) {
    for (const field of array(task.custom_fields)) {
      const gid = gidOf(field);
      const name = oneLine(str(field.name)).slice(0, 200);
      if (!gid || !name || fields.some((f) => f.gid === gid)) continue;
      const type = fieldType(field);
      const options: BoardOption[] = array(field.enum_options)
        .filter((o) => o.enabled !== false && oneLine(str(o.name)))
        .map((o) => ({ name: oneLine(str(o.name)).slice(0, 200), color: boardColor(o.color) }));
      fields.push({ gid, column: { name, type, ...(options.length ? { options } : {}) } });
    }
  }
  // Colors of options the field lists only on the tasks that have them.
  for (const { task } of tasks) {
    for (const field of array(task.custom_fields)) {
      const column = fields.find((f) => f.gid === gidOf(field))?.column;
      if (!column || (column.type !== "select" && column.type !== "multi_select")) continue;
      for (const o of [...(isObject(field.enum_value) ? [field.enum_value] : []), ...array(field.multi_enum_values)]) {
        const name = oneLine(str(o.name)).slice(0, 200);
        if (name && !column.options?.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
          column.options = [...(column.options ?? []), { name, color: boardColor(o.color) }];
        }
      }
    }
  }
  checkBoardSize(tasks.length, fields.length + 5);

  const hasAssignee = tasks.some(({ task }) => isObject(task.assignee));
  const tagOptions: BoardOption[] = [];
  for (const { task } of tasks) {
    for (const tag of array(task.tags)) {
      const name = oneLine(str(tag.name)).slice(0, 200);
      if (name && !tagOptions.some((o) => o.name.toLowerCase() === name.toLowerCase())) tagOptions.push({ name, color: boardColor(tag.color) });
    }
  }
  const columns: BoardColumn[] = [
    ...(hasAssignee ? [{ name: "Assignee", role: "assignee" as const, type: "person" as const }] : []),
    ...(tagOptions.length ? [{ name: "Tags", role: "tags" as const, type: "multi_select" as const, options: tagOptions }] : []),
    ...fields.map((f) => f.column),
  ];

  const items: BoardItem[] = tasks.map(({ task, parent }) => {
    const cells: BoardCell[] = [];
    if (hasAssignee) {
      const a = isObject(task.assignee) ? task.assignee : null;
      const name = a ? oneLine(str(a.name)) : "";
      const email = a ? str(a.email) || null : null;
      cells.push(name || email ? [{ name: name || email!, email }] : "");
    }
    if (tagOptions.length) cells.push(array(task.tags).map((t) => oneLine(str(t.name))).filter(Boolean));
    const values = new Map(array(task.custom_fields).map((f) => [gidOf(f), f]));
    for (const { gid, column } of fields) {
      const field = values.get(gid);
      cells.push(field ? fieldCell(field, column.type) : "");
    }
    const comments: BoardComment[] = array(task.stories)
      .filter((s) => s.resource_subtype === "comment_added" || s.type === "comment")
      .map((s) => ({
        author: oneLine(str(isObject(s.created_by) ? s.created_by.name : "")) || "?",
        date: exportInstant(s.created_at),
        text: str(s.text).trim(),
      }))
      .filter((c) => c.text)
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    const attachments = array(task.attachments).flatMap((file) => {
      const url = webUrl(file.permanent_url) ?? webUrl(file.view_url) ?? webUrl(file.download_url);
      return url ? [{ name: oneLine(str(file.name)) || url, url }] : [];
    });
    return {
      id: gidOf(task) || null,
      title: oneLine(str(task.name)),
      group: sectionOf(task),
      parent,
      blockedBy: [],
      done: typeof task.completed === "boolean" ? task.completed : null,
      dates: dateRange(jsonDate(task.start_on, task.start_at), jsonDate(task.due_on, task.due_at)),
      cells,
      body: str(task.notes).trim(),
      attachments,
      comments,
    };
  });

  // A task that names its parent instead of being nested under it.
  const find = itemFinder(items);
  const missing = { parent: { count: 0 }, dependencies: { count: 0 } };
  tasks.forEach(({ task }, i) => {
    if (items[i].parent === null && isObject(task.parent)) {
      const parent = find(gidOf(task.parent)) ?? find(str(task.parent.name));
      if (parent === null) missing.parent.count++;
      else if (parent !== i) items[i].parent = parent;
    }
    for (const dep of array(task.dependencies)) {
      const b = find(gidOf(dep));
      if (b === null) missing.dependencies.count++;
      else if (b !== i && !items[i].blockedBy.includes(b)) items[i].blockedBy.push(b);
    }
    for (const dep of array(task.dependents)) {
      const w = find(gidOf(dep));
      if (w === null) missing.dependencies.count++;
      else if (w !== i && !items[w].blockedBy.includes(i)) items[w].blockedBy.push(i);
    }
  });
  const loops = breakLoops(items);
  inheritGroups(items);

  const leftOut = [
    ...(tasks.some(({ task }) => task.created_at) ? ["created_at"] : []),
    ...(tasks.some(({ task }) => task.modified_at) ? ["modified_at"] : []),
  ];
  const unlinked = [
    { column: "parent", count: missing.parent.count + loops.parents },
    { column: "dependencies", count: missing.dependencies.count + loops.dependencies },
  ].filter((u) => u.count > 0);
  return { source: "asana", title, groups, columns, items, leftOut, otherSheets: [], unlinked, linkedId: asanaTaskId };
}
