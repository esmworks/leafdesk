import { eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseView } from "@/db/schema";
import { WarningList, type ImportResult } from "@/lib/import/result";
import { cardBody, readTrelloBoard, type LabelColor, type TrelloBoard, type TrelloCard } from "@/lib/import/trello";
import { pagePath } from "@/lib/mentions";
import type { PropertyType } from "@/lib/property-types";
import { getMembership, isGuest } from "@/server/access";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { addProperty, addView, type DatabaseProperty } from "@/server/databases";
import { createPage, type DatabaseSeedNames } from "@/server/pages";
import { workspacePeople } from "@/server/workspaces";
import { recolor, writeIds } from "./board";
import { checkRows, discardDatabase, recordImport, reportInvalid, writeRows } from "./csv";

/**
 * Imports a Trello board (its JSON export, read by lib/import/trello) as a new database: a row per
 * card with its list, labels, members, dates, checklist, link and custom fields as properties, its
 * description, other attachments and comments as the row's body, and a board view grouped by
 * list, which opens first.
 *
 * Members become people when exactly one person in the workspace has their name (the export has
 * no email addresses); the others are written as text. Guests can't look people up, so for them
 * every member is text. Imported assignments aren't announced: nobody is assigned anything new.
 * Comments can only be written by the person commenting, now, so they go in the body under their
 * author and time.
 *
 * All or nothing, like CSV imports: a failure takes back the database with its rows.
 */

/** Names of the properties, view and headings an import creates, in the importer's language. */
export type TrelloNames = {
  list: string;
  labels: string;
  members: string;
  otherMembers: string;
  dates: string;
  complete: string;
  checklist: string;
  link: string;
  attachments: string;
  comments: string;
  board: string;
  colors: Record<LabelColor, string>;
};

export const ENGLISH_TRELLO_NAMES: TrelloNames = {
  list: "List",
  labels: "Labels",
  members: "Members",
  otherMembers: "Other members",
  dates: "Dates",
  complete: "Complete",
  checklist: "Checklist",
  link: "Link",
  attachments: "Attachments",
  comments: "Comments",
  board: "Board",
  colors: { gray: "Gray", brown: "Brown", orange: "Orange", yellow: "Yellow", green: "Green", blue: "Blue", purple: "Purple", pink: "Pink", red: "Red" },
};

export type TrelloImportInput = {
  workspaceId: string;
  /** The page the database goes under; null for the top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for a private database, undefined for the default teamspace. */
  teamspaceId?: string | null;
  /** The database's name; the board's when empty. */
  title?: string;
  /** The parsed export (see lib/import/trello parseTrelloExport). */
  board: Record<string, unknown>;
  seedNames?: DatabaseSeedNames;
  names?: TrelloNames;
  /** The importing person's time zone, for the comments' times. */
  timeZone?: string;
};

export async function importTrello(actor: WriteActor, input: TrelloImportInput): Promise<ImportResult> {
  const { userId } = actor;
  const names = input.names ?? ENGLISH_TRELLO_NAMES;
  const board = readTrelloBoard(input.board);
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
    /** A property name no earlier property has (custom fields may be called "Labels" too). */
    const unique = (name: string) => {
      let out = name;
      for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${name} ${n}`;
      taken.add(out.toLowerCase());
      return out;
    };
    const props: DatabaseProperty[] = [];
    const add = async (name: string, type: PropertyType, options?: { name: string; color: string }[]) => {
      let prop = await addProperty(userId, database.id, { name: unique(name), type, options: options?.map((o) => o.name) });
      // addProperty colors options in turn; these keep the colors they had.
      if (options?.some((o) => o.color)) prop = await recolor(prop, options.map((o) => o.color));
      props.push(prop);
      return prop;
    };
    const optionIds = (prop: DatabaseProperty) => (prop.options.options ?? []).map((o) => o.id);
    const has = (test: (card: TrelloCard) => unknown) => board.cards.some(test);

    const listProp = await add(
      names.list,
      "select",
      board.lists.map((l, i) => ({ name: l.name || `${names.list} ${i + 1}`, color: "" })),
    );
    const listOptions = optionIds(listProp);

    const labelProp = board.labels.length ? await add(names.labels, "multi_select", labelOptions(board, names)) : null;
    const labelOptionIds = labelProp ? optionIds(labelProp) : [];

    const people = await memberPeople(userId, database.workspaceId, board);
    const personProp = people.size && has((c) => c.members.some((m) => people.has(m))) ? await add(names.members, "person") : null;
    const unmatched = (card: TrelloCard) => card.members.filter((m) => !personProp || !people.has(m));
    const memberText = has((c) => unmatched(c).length) ? await add(personProp ? names.otherMembers : names.members, "text") : null;
    const memberName = new Map(board.members.map((m) => [m.id, m.fullName || m.username]));

    const datesProp = has((c) => c.dates) ? await add(names.dates, "date") : null;
    const completeProp = has((c) => c.complete) ? await add(names.complete, "checkbox") : null;
    const checklistProp = has((c) => c.checklist.length) ? await add(board.checklistName ?? names.checklist, "checklist") : null;
    const linkProp = has((c) => c.link) ? await add(names.link, "url") : null;

    const fieldProps = new Map<string, { prop: DatabaseProperty; options: Map<string, string> }>();
    for (const field of board.customFields) {
      if (field.type === "select") {
        const prop = await add(field.name, "select", field.options);
        const ids = optionIds(prop);
        fieldProps.set(field.id, { prop, options: new Map(field.options.map((o, i) => [o.id, ids[i]])) });
      } else fieldProps.set(field.id, { prop: await add(field.name, field.type), options: new Map() });
    }

    const pending = board.cards.map((card) => {
      const values: Record<string, unknown> = { [listProp.id]: listOptions[card.list] };
      if (labelProp && card.labels.length) values[labelProp.id] = card.labels.map((i) => labelOptionIds[i]);
      if (memberText && unmatched(card).length) values[memberText.id] = unmatched(card).map((m) => memberName.get(m)).join(", ");
      if (datesProp && card.dates) values[datesProp.id] = card.dates;
      if (completeProp && card.complete) values[completeProp.id] = true;
      if (checklistProp && card.checklist.length) values[checklistProp.id] = card.checklist;
      if (linkProp && card.link) values[linkProp.id] = card.link;
      for (const [fieldId, value] of Object.entries(card.fields)) {
        const target = fieldProps.get(fieldId);
        const stored = target?.prop.type === "select" ? target.options.get(String(value)) : value;
        if (target && stored !== undefined) values[target.prop.id] = stored;
      }
      return { title: card.title, values };
    });
    const invalid = new Map<string, number>();
    const rows = await writeRows(database, userId, await checkRows(userId, database.id, pending, props, invalid));

    if (personProp) {
      const assigned = board.cards.flatMap((card, i) => {
        const ids = [...new Set(card.members.flatMap((m) => people.get(m) ?? []))];
        return ids.length ? [{ id: rows[i].id, ids }] : [];
      });
      await writeIds(personProp.id, assigned);
      getCollab().broadcast(`db:${database.id}`, "rows");
    }

    // Bodies once every row exists, so links between cards can point at their rows.
    const rowOf = new Map(board.cards.flatMap((card, i) => (card.shortLink ? [[card.shortLink, rows[i].id] as const] : [])));
    const cardLink = (short: string) => (rowOf.has(short) ? pagePath(database.workspaceId, rowOf.get(short)!) : null);
    for (const [i, card] of board.cards.entries()) {
      const body = cardBody(card, names, { timeZone: input.timeZone, cardLink });
      if (body.trim()) await getCollab().replaceContent(rows[i].id, body, actor, false, { wikilinks: false });
    }

    // The board opens first: before the table every new database has.
    const view = await addView(userId, database.id, { name: names.board, type: "board", config: { groupBy: listProp.id } });
    await db.update(databaseView).set({ position: 0 }).where(eq(databaseView.id, view.id));

    reportInvalid(warnings, invalid, props);
    const result: ImportResult = {
      pages: [{ id: database.id, title: database.title, kind: "database" }],
      created: { pages: 0, databases: 1, rows: rows.length, templates: 0, files: 0 },
      warnings: warnings.list,
      moreWarnings: warnings.more,
    };
    await recordImport(userId, database.workspaceId, result, "trello");
    return result;
  } catch (error) {
    await discardDatabase(database);
    throw error;
  }
}

/**
 * The label options: named labels by name, color-only ones by their color's name, numbered when
 * that name is taken.
 */
function labelOptions(board: TrelloBoard, names: TrelloNames) {
  const taken = new Set(board.labels.flatMap((l) => (l.name ? [l.name.toLowerCase()] : [])));
  return board.labels.map((label) => {
    if (label.name) return { name: label.name, color: label.color };
    const base = names.colors[label.color];
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    taken.add(name.toLowerCase());
    return { name, color: label.color };
  });
}

/**
 * Board members as people of the workspace: by full name, else by username, when exactly one
 * person has it. Empty for guests, who can't look people up.
 */
async function memberPeople(userId: string, workspaceId: string, board: TrelloBoard): Promise<Map<string, string>> {
  const membership = await getMembership(userId, workspaceId);
  if (!membership || isGuest(membership.role) || !board.members.length) return new Map();
  const byName = new Map<string, string[]>();
  for (const person of await workspacePeople(workspaceId)) {
    const key = person.name.trim().toLowerCase();
    if (key) byName.set(key, [...(byName.get(key) ?? []), person.id]);
  }
  const one = (name: string) => {
    const ids = name ? byName.get(name.toLowerCase()) : undefined;
    return ids?.length === 1 ? ids[0] : undefined;
  };
  const out = new Map<string, string>();
  for (const member of board.members) {
    const id = one(member.fullName) ?? one(member.username);
    if (id) out.set(member.id, id);
  }
  return out;
}
