import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, databaseView, page, type SelectOption } from "@/db/schema";
import {
  BOARD_COLUMN_TYPES,
  boardDateFormat,
  boardValue,
  cellPeople,
  cellText,
  columnOptions,
  itemBody,
  type Board,
  type BoardColumnType,
  type BoardOption,
  type BoardPerson,
} from "@/lib/import/board";
import { INVALID, percentColumn } from "@/lib/import/csv";
import { WarningList, type ImportResult } from "@/lib/import/result";
import { pagePath } from "@/lib/mentions";
import type { PropertyType } from "@/lib/property-types";
import { getMembership, isGuest } from "@/server/access";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { addProperty, addView, setDependencies, setSubItems, type DatabaseProperty, type OptionInput } from "@/server/databases";
import { createPage, type DatabaseSeedNames } from "@/server/pages";
import { workspacePeople } from "@/server/workspaces";
import { checkRows, discardDatabase, recordImport, reportInvalid, writeRows } from "./csv";

/**
 * Imports a project board read from another app's export (lib/import/board: Asana projects,
 * Monday.com boards) as a new database: a row per item, its group (section) a select the board
 * view that opens first is grouped by, Asana's completion a status and start and due dates one
 * date, each column a property of the type it was read as (or the importer picked), sub-items and
 * dependencies through the database's own sub-items and dependencies, and the item's description,
 * attachments and comments its row's body.
 *
 * People are matched to the workspace's: by email address when the export gives one, else by name,
 * when exactly one person has it; the others are written as text, as are all of them for a guest,
 * who can't look people up. Imported assignments aren't announced, and comments go in the body
 * under their author and time (they can only be posted by the person commenting).
 *
 * All or nothing, like CSV imports: a failure takes back the database with its rows.
 */

/** Names of the properties, view and headings an import creates, in the importer's language. */
export type BoardNames = {
  section: string;
  group: string;
  status: string;
  toDo: string;
  done: string;
  assignee: string;
  tags: string;
  dates: string;
  /** The text property beside a person property, for the people nobody in the workspace is. */
  others: (column: string) => string;
  parentItem: string;
  subItems: string;
  blockedBy: string;
  blocking: string;
  attachments: string;
  comments: string;
  board: string;
};

export const ENGLISH_BOARD_NAMES: BoardNames = {
  section: "Section",
  group: "Group",
  status: "Status",
  toDo: "To do",
  done: "Done",
  assignee: "Assignee",
  tags: "Tags",
  dates: "Dates",
  others: (column) => `${column} (others)`,
  parentItem: "Parent item",
  subItems: "Sub-items",
  blockedBy: "Blocked by",
  blocking: "Blocking",
  attachments: "Attachments",
  comments: "Comments",
  board: "Board",
};

export type BoardImportInput = {
  workspaceId: string;
  /** The page the database goes under; null for the top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for a private database, undefined for the default teamspace. */
  teamspaceId?: string | null;
  /** The database's name; the board's when empty. */
  title?: string;
  board: Board;
  /** What each of the board's columns becomes, null to leave it out; as read when not given. */
  types?: unknown[];
  seedNames?: DatabaseSeedNames;
  names?: BoardNames;
  /** The importing person's time zone, for times written without one and the comments' times. */
  timeZone?: string;
};

/** Values written per statement. */
const CHUNK = 500;

type ColumnTarget =
  | { kind: "value"; prop: DatabaseProperty; type: BoardColumnType; dateFormat: ReturnType<typeof boardDateFormat> }
  | { kind: "people"; person: DatabaseProperty | null; text: DatabaseProperty | null };

export async function importBoard(actor: WriteActor, input: BoardImportInput): Promise<ImportResult> {
  const { userId } = actor;
  const { board } = input;
  const names = input.names ?? ENGLISH_BOARD_NAMES;
  const types = board.columns.map((column, i): BoardColumnType | null => {
    const chosen = input.types?.[i];
    if (chosen === undefined || !input.types || input.types.length !== board.columns.length) return column.type;
    return BOARD_COLUMN_TYPES.includes(chosen as BoardColumnType) ? (chosen as BoardColumnType) : null;
  });
  const warnings = new WarningList();

  // Recorded once the import has gone through (recordImport), not as a database of its own.
  const database = await createPage(
    actor,
    {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      teamspaceId: input.teamspaceId,
      kind: "database",
      title: (input.title?.trim() || board.title).slice(0, 200),
      seedNames: input.seedNames,
      seedProperties: false,
    },
    { audit: false },
  );
  try {
    const taken = new Set<string>();
    /** A property name no earlier property has (custom fields may be called "Tags" too). */
    const unique = (name: string) => {
      let out = name;
      for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${name} ${n}`;
      taken.add(out.toLowerCase());
      return out;
    };
    const props: DatabaseProperty[] = [];
    const add = async (name: string, type: PropertyType, options?: BoardOption[], extra: { number?: { format: "percent" } } = {}) => {
      const optionInput = options?.map((o): OptionInput => (type === "status" ? { name: o.name, group: o.group } : o.name));
      let prop = await addProperty(userId, database.id, { ...extra, name: unique(name), type, options: optionInput });
      // addProperty colors options in turn; these keep the colors they had. Status options go by their group.
      if (type !== "status" && options?.some((o) => o.color)) prop = await recolor(prop, options.map((o) => o.color ?? ""));
      props.push(prop);
      return prop;
    };
    const has = (test: (i: number) => unknown) => board.items.some((_, i) => test(i));

    const groupProp = board.groups.length
      ? await add(board.source === "asana" ? names.section : names.group, "select", board.groups.map((name) => ({ name })))
      : null;
    const groupOptions = groupProp?.options.options ?? [];
    const statusProp = has((i) => board.items[i].done !== null)
      ? await add(names.status, "status", [
          { name: names.toDo, group: "todo" },
          { name: names.done, group: "done" },
        ])
      : null;
    const datesProp = has((i) => board.items[i].dates) ? await add(names.dates, "date") : null;

    const people = await matcher(userId, database.workspaceId);
    const targets: (ColumnTarget | null)[] = [];
    for (const [i, column] of board.columns.entries()) {
      const type = types[i];
      const cells = board.items.map((item) => item.cells[i] ?? "");
      const name = column.role ? names[column.role] : column.name;
      if (!type || !cells.some((c) => cellText(c).trim())) {
        targets.push(null);
        continue;
      }
      if (type === "person") {
        const all = cells.flatMap(cellPeople);
        const matched = all.some((p) => people(p));
        const person = matched ? await add(name, "person") : null;
        const text = all.some((p) => !people(p)) ? await add(matched ? names.others(name) : name, "text") : null;
        targets.push({ kind: "people", person, text });
        continue;
      }
      const texts = cells.map(cellText);
      const options = type === "select" || type === "multi_select" || type === "status" ? columnOptions(column, type, cells) : undefined;
      // A column of percentages ("15%") shows them as such; its values are the fractions.
      const extra = type === "number" && percentColumn(texts) ? { number: { format: "percent" as const } } : {};
      const prop = await add(name, type, options, extra);
      targets.push({ kind: "value", prop, type, dateFormat: type === "date" ? boardDateFormat(texts) : null });
    }

    const invalid = new Map<string, number>();
    const assigned = new Map<string, { id: number; ids: string[] }[]>();
    const pending = board.items.map((item, r) => {
      const values: Record<string, unknown> = {};
      if (groupProp && item.group !== null && groupOptions[item.group]) values[groupProp.id] = groupOptions[item.group].id;
      if (statusProp && item.done !== null) values[statusProp.id] = item.done ? names.done : names.toDo;
      if (datesProp && item.dates) values[datesProp.id] = item.dates;
      targets.forEach((target, i) => {
        if (!target) return;
        const cell = item.cells[i] ?? "";
        if (target.kind === "people") {
          const persons = cellPeople(cell);
          const ids = [...new Set(persons.flatMap((p) => people(p) ?? []))];
          if (target.person && ids.length) assigned.set(target.person.id, [...(assigned.get(target.person.id) ?? []), { id: r, ids }]);
          const others = persons.filter((p) => !target.person || !people(p)).map((p) => p.name);
          if (target.text && others.length) values[target.text.id] = others.join(", ");
          return;
        }
        const value = boardValue(target.type, cell, { dateFormat: target.dateFormat, timeZone: input.timeZone });
        if (value === INVALID) invalid.set(target.prop.id, (invalid.get(target.prop.id) ?? 0) + 1);
        else if (value !== null) values[target.prop.id] = value;
      });
      return { title: item.title, values };
    });
    const rows = await writeRows(database, userId, await checkRows(userId, database.id, pending, props, invalid));

    let linked = false;
    for (const [propertyId, values] of assigned) {
      await writeIds(propertyId, values.map((v) => ({ id: rows[v.id].id, ids: v.ids })));
      linked = true;
    }
    if (has((i) => board.items[i].parent !== null)) {
      const parent = await setSubItems(userId, database.id, { on: true, names: { parent: unique(names.parentItem), subItems: unique(names.subItems) } });
      const children = board.items.flatMap((item, i) => (item.parent !== null ? [{ child: i, parent: item.parent }] : []));
      await writeIds(parent!.id, children.map((c) => ({ id: rows[c.child].id, ids: [rows[c.parent].id] })));
      await writeIds(
        parent!.options.relation!.pairedPropertyId!,
        [...new Set(children.map((c) => c.parent))].map((p) => ({ id: rows[p].id, ids: children.filter((c) => c.parent === p).map((c) => rows[c.child].id) })),
      );
      linked = true;
    }
    if (has((i) => board.items[i].blockedBy.length)) {
      const by = await setDependencies(userId, database.id, { on: true, names: { blockedBy: unique(names.blockedBy), blocking: unique(names.blocking) } });
      const waiting = board.items.flatMap((item, i) => (item.blockedBy.length ? [{ id: rows[i].id, ids: item.blockedBy.map((b) => rows[b].id) }] : []));
      await writeIds(by!.id, waiting);
      const blocking = new Map<string, string[]>();
      board.items.forEach((item, i) => item.blockedBy.forEach((b) => blocking.set(rows[b].id, [...(blocking.get(rows[b].id) ?? []), rows[i].id])));
      await writeIds(by!.options.relation!.pairedPropertyId!, [...blocking].map(([id, ids]) => ({ id, ids })));
      linked = true;
    }
    if (linked) getCollab().broadcast(`db:${database.id}`, "rows");

    // Bodies once every row exists, so links between items can point at their rows.
    const rowOf = new Map(board.items.flatMap((item, i) => (item.id ? [[item.id, rows[i].id] as const] : [])));
    const itemLink = (url: string) => {
      const id = board.linkedId(url);
      return id && rowOf.has(id) ? pagePath(database.workspaceId, rowOf.get(id)!) : null;
    };
    for (const [i, item] of board.items.entries()) {
      const body = itemBody(item, names, { timeZone: input.timeZone, itemLink });
      if (body.trim()) await getCollab().replaceContent(rows[i].id, body, actor, false, { wikilinks: false });
    }

    // The board opens first: before the table every new database has.
    if (groupProp) {
      const view = await addView(userId, database.id, { name: names.board, type: "board", config: { groupBy: groupProp.id } });
      await db.update(databaseView).set({ position: 0 }).where(eq(databaseView.id, view.id));
    }

    reportInvalid(warnings, invalid, props);
    for (const { column, count } of board.unlinked) warnings.add({ code: "invalidValues", column, count });
    for (const column of board.leftOut) warnings.add({ code: "leftOutColumn", column });
    for (const sheet of board.otherSheets) warnings.add({ code: "skipped", path: sheet, reason: "otherSheet" });
    const result: ImportResult = {
      pages: [{ id: database.id, title: database.title, kind: "database" }],
      created: { pages: 0, databases: 1, rows: rows.length, templates: 0, files: 0 },
      warnings: warnings.list,
      moreWarnings: warnings.more,
    };
    await recordImport(userId, database.workspaceId, result, board.source);
    return result;
  } catch (error) {
    await discardDatabase(database);
    throw error;
  }
}

/**
 * Finds the person of the workspace someone of the export is: by email address when the export
 * gives one, else by name, when exactly one person has it. Finds no one for a guest, who can't
 * look people up.
 */
async function matcher(userId: string, workspaceId: string): Promise<(person: BoardPerson) => string | undefined> {
  const membership = await getMembership(userId, workspaceId);
  if (!membership || isGuest(membership.role)) return () => undefined;
  const byName = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  for (const person of await workspacePeople(workspaceId)) {
    const name = person.name.trim().toLowerCase();
    const email = person.email.trim().toLowerCase();
    if (name) byName.set(name, [...(byName.get(name) ?? []), person.id]);
    if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), person.id]);
  }
  const one = (map: Map<string, string[]>, key: string) => {
    const ids = key ? map.get(key.trim().toLowerCase()) : undefined;
    return ids?.length === 1 ? ids[0] : undefined;
  };
  return (person) => (person.email ? one(byEmail, person.email) : one(byName, person.name));
}

/** Gives a new property's options these colors, in order ("" keeps an option's own). */
export async function recolor(prop: DatabaseProperty, colors: string[]): Promise<DatabaseProperty> {
  const options: SelectOption[] = (prop.options.options ?? []).map((o, i) => (colors[i] ? { ...o, color: colors[i] } : o));
  const [updated] = await db
    .update(databaseProperty)
    .set({ options: { ...prop.options, options } })
    .where(eq(databaseProperty.id, prop.id))
    .returning();
  return { ...prop, options: updated.options };
}

/**
 * Writes lists of ids (people, linked rows) straight to the rows an import just created: the
 * people are the workspace's and the rows the import's, so there is nothing to check, and going
 * around afterRowWrites keeps a board's worth of old assignments from notifying everyone.
 */
export async function writeIds(propertyId: string, values: { id: string; ids: string[] }[]) {
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    await db.execute(sql`
      update ${page} set properties = ${page.properties} || jsonb_build_object(${propertyId}::text, v.ids)
      from (values ${sql.join(
        chunk.map((v) => sql`(${v.id}::text, ${JSON.stringify(v.ids)}::jsonb)`),
        sql`, `,
      )}) as v(id, ids)
      where ${page.id} = v.id
    `);
  }
}
