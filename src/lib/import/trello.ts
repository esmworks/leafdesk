import { SELECT_COLORS } from "../properties";
import { isTimeZone, zoneOffset } from "../time-zone";
import { CSV_MAX_ROWS } from "./csv";
import { ImportError } from "./result";

/**
 * Reading a Trello board's JSON export (Board menu → Print, export and share → Export as JSON) for
 * import as a database (see server/import/trello): one row per card, in list order and then card
 * order. Pure, so the import dialog checks a file with the same code the server imports it with.
 *
 * What a card becomes: its list a select option (options in list order), its labels options of a
 * multi-select (in the colors closest to Trello's), its members people (matched by the server),
 * its start and due dates one date (a range when it has both), its checklists one checklist, its
 * first linked attachment a URL, its custom fields properties of their own, and its description
 * the row's body, with its comments and other attachments below it. Archived lists and cards are
 * left out (and counted), and so are cards in an archived list.
 *
 * Nothing the export links to is fetched: images in descriptions become links, and uploaded
 * attachments stay links to Trello (which asks to sign in).
 */

export type LabelColor = (typeof SELECT_COLORS)[number];

export type TrelloField =
  | { id: string; name: string; type: "text" | "number" | "date" | "checkbox" }
  | { id: string; name: string; type: "select"; options: { id: string; name: string; color: LabelColor }[] };

export type TrelloComment = { author: string; date: string; text: string };

export type TrelloCard = {
  id: string;
  /** The 8 characters Trello's card links use (trello.com/c/<shortLink>). */
  shortLink: string | null;
  title: string;
  /** Index into the board's lists. */
  list: number;
  /** Indexes into the board's labels (one per option: labels of the same name are one). */
  labels: number[];
  /** Ids of the board's members. */
  members: string[];
  /** A date value (see lib/date-value): the due instant, or start/due when both are set. */
  dates: string | null;
  /** The due date is marked complete. */
  complete: boolean;
  checklist: { text: string; checked: boolean }[];
  /** The first attachment that is a link (not an upload). */
  link: string | null;
  /** Markdown, with images turned into links. */
  description: string;
  /** Oldest first. */
  comments: TrelloComment[];
  /** Attachments other than `link`, links and uploads alike, as links. */
  attachments: { name: string; url: string }[];
  /** Custom field values by field id: text, number, a date value, true, or an option id. */
  fields: Record<string, string | number | boolean>;
};

export type TrelloBoard = {
  title: string;
  /** The open lists, in board order. */
  lists: { id: string; name: string }[];
  /**
   * Label options in board order: the named ones, and the color-only ones (`name` null) that
   * imported cards have. Unused color-only labels are Trello's defaults for every board.
   */
  labels: { name: string | null; color: LabelColor }[];
  /** Members whose cards (among the imported ones) name them. */
  members: { id: string; fullName: string; username: string }[];
  customFields: TrelloField[];
  cards: TrelloCard[];
  /** The checklists' name when every imported checklist has the same one, else null. */
  checklistName: string | null;
  /** Archived lists, and archived cards (with those in archived lists), left out. */
  archived: { lists: number; cards: number };
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const array = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
const byPos = (a: Json, b: Json) => num(a.pos) - num(b.pos);

/** Whether parsed JSON looks like a Trello board export: a board with lists and cards. */
export function isTrelloBoard(json: unknown): json is Json {
  return isObject(json) && typeof json.name === "string" && Array.isArray(json.lists) && Array.isArray(json.cards);
}

/** Parses an export's text; throws ImportError("badTrello") when it isn't one. */
export function parseTrelloExport(text: string): Json {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new ImportError("The file isn't a Trello board export", "badTrello");
  }
  if (!isTrelloBoard(json)) throw new ImportError("The file isn't a Trello board export", "badTrello");
  return json;
}

/**
 * The Leafdesk color closest to a Trello color. Trello's newer shades (`green_dark`,
 * `red_light`) go to their base color, sky to blue, lime to green and black to gray.
 */
export function labelColor(color: unknown): LabelColor {
  const base = str(color).replace(/_(dark|light)$/, "");
  if (base === "sky") return "blue";
  if (base === "lime") return "green";
  return (SELECT_COLORS as readonly string[]).includes(base) ? (base as LabelColor) : "gray";
}

/** An http(s) URL, else null. */
function webUrl(value: unknown): string | null {
  const url = str(value).trim();
  return /^https?:\/\/\S+$/i.test(url) ? url : null;
}

/** A Trello date (an ISO instant) as stored by date properties, else null. */
function instant(value: unknown): string | null {
  const text = str(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A card's date value: start/due when both are set (and the start isn't after the due date), else either. */
function cardDates(start: string | null, due: string | null): string | null {
  if (start && due) return start <= due ? `${start}/${due}` : due;
  return due ?? start;
}

/**
 * Markdown from Trello: images become links (nothing is loaded from elsewhere), the `"smartCard-…"`
 * titles Trello gives links it shows as previews are dropped, and links to cards go through
 * `cardLink` (a card's short link to the address of its row, or null to leave the link).
 */
export function trelloMarkdown(markdown: string, cardLink: (shortLink: string) => string | null = () => null): string {
  const card = (url: string) => {
    const short = CARD_URL.exec(url)?.[1];
    return short ? cardLink(short) : null;
  };
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/!\[([^\]\n]*)\]\(/g, (_, alt: string) => `[${alt || "image"}](`)
    .replace(TRELLO_LINKS, (match, text?: string, target?: string, title?: string, angled?: string, bare?: string) => {
      if (target !== undefined) {
        const to = card(target);
        if (to) return `[${text}](${to})`;
        return title && /^"smartCard-[a-z]+"$/.test(title) ? `[${text}](${target})` : match;
      }
      const url = angled ?? bare!;
      const to = card(url);
      return to ? `[${url}](${to})` : match;
    });
}

/** A link to a Trello card; the short link is group 1. */
const CARD_URL = /^https?:\/\/trello\.com\/c\/([A-Za-z0-9]{8})(?:[/?#]|$)/;

/**
 * Links in Markdown: `[text](target "title")` (groups 1–3), `<address>` (4), or a bare address of
 * a Trello card (5). Taking whole links first keeps an address in a link's text from being
 * rewritten on its own.
 */
const TRELLO_LINKS =
  /\[([^\]\n]*)\]\(([^()\s]+)(?:\s+("[^"\n]*"))?\)|<(https?:\/\/[^<>\s]+)>|(https?:\/\/trello\.com\/c\/[A-Za-z0-9]{8}(?:\/[^\s()<>\]]*)?)/g;

/**
 * The board's cards and what their properties need. Throws ImportError when there are more cards
 * than an import takes.
 */
export function readTrelloBoard(json: Json): TrelloBoard {
  const allLists = array(json.lists).sort(byPos);
  const lists = allLists.filter((l) => l.closed !== true);
  const listIndex = new Map(lists.map((l, i) => [str(l.id), i]));
  const closedLists = new Set(allLists.filter((l) => l.closed === true).map((l) => str(l.id)));

  const allCards = array(json.cards);
  const cards = allCards
    .filter((c) => c.closed !== true && listIndex.has(str(c.idList)))
    .sort((a, b) => listIndex.get(str(a.idList))! - listIndex.get(str(b.idList))! || byPos(a, b));
  if (cards.length > CSV_MAX_ROWS) {
    throw new ImportError(`A board can have at most ${CSV_MAX_ROWS} cards`, "tooManyRows", { limit: CSV_MAX_ROWS });
  }
  const archived = {
    lists: closedLists.size,
    // Cards of lists the export doesn't have aren't archived; they're left out without a count.
    cards: allCards.filter((c) => c.closed === true || closedLists.has(str(c.idList))).length,
  };

  // Labels: the board's, and any a card has that the board's list lacks. Named labels of the same
  // name are one option; a label with only a color is one of its own.
  const labels: TrelloBoard["labels"] = [];
  const labelOf = new Map<string, number>();
  const byName = new Map<string, number>();
  const addLabel = (label: Json) => {
    const id = str(label.id);
    if (!id || labelOf.has(id)) return;
    const name = oneLine(str(label.name)).slice(0, 200) || null;
    const same = name ? byName.get(name.toLowerCase()) : undefined;
    if (same !== undefined) return labelOf.set(id, same);
    labelOf.set(id, labels.length);
    if (name) byName.set(name.toLowerCase(), labels.length);
    labels.push({ name, color: labelColor(label.color) });
  };
  array(json.labels).forEach(addLabel);
  for (const card of cards) array(card.labels).forEach(addLabel);

  const memberById = new Map(array(json.members).map((m) => [str(m.id), m]));
  const usedMembers = new Set<string>();

  const checklistsOf = new Map<string, Json[]>();
  for (const list of array(json.checklists)) {
    const card = str(list.idCard);
    checklistsOf.set(card, [...(checklistsOf.get(card) ?? []), list]);
  }
  const checklistNames = new Set<string>();

  // Comments come newest first.
  const commentsOf = new Map<string, TrelloComment[]>();
  for (const action of array(json.actions)) {
    if (action.type !== "commentCard" || !isObject(action.data) || !isObject(action.data.card)) continue;
    const text = str(action.data.text).trim();
    const date = instant(action.date);
    if (!text || !date) continue;
    const creator = isObject(action.memberCreator) ? action.memberCreator : (memberById.get(str(action.idMemberCreator)) ?? {});
    const author = oneLine(str(creator.fullName)) || oneLine(str(creator.username)) || "?";
    const card = str(action.data.card.id);
    commentsOf.set(card, [{ author, date, text }, ...(commentsOf.get(card) ?? [])]);
  }
  for (const list of commentsOf.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const customFields: TrelloField[] = [];
  for (const field of array(json.customFields).sort(byPos)) {
    const id = str(field.id);
    const name = oneLine(str(field.name)).slice(0, 200);
    if (!id || !name) continue;
    if (field.type === "list") {
      const options = array(field.options)
        .sort(byPos)
        .map((o) => ({ id: str(o.id), name: oneLine(str(isObject(o.value) ? o.value.text : "")).slice(0, 200), color: labelColor(o.color) }))
        .filter((o) => o.id && o.name);
      customFields.push({ id, name, type: "select", options });
    } else if (field.type === "text" || field.type === "number" || field.type === "date" || field.type === "checkbox") {
      customFields.push({ id, name, type: field.type });
    }
  }
  const fieldById = new Map(customFields.map((f) => [f.id, f]));

  const read = cards.map((card): TrelloCard => {
    const id = str(card.id);
    const members = (Array.isArray(card.idMembers) ? card.idMembers : []).map(str).filter((m) => memberById.has(m));
    members.forEach((m) => usedMembers.add(m));

    const checklists = (checklistsOf.get(id) ?? []).sort(byPos);
    for (const list of checklists) checklistNames.add(oneLine(str(list.name)));
    const checklist = checklists.flatMap((list) =>
      array(list.checkItems)
        .sort(byPos)
        .filter((item) => oneLine(str(item.name)))
        .map((item) => ({
          text: checklists.length > 1 && oneLine(str(list.name)) ? `${oneLine(str(list.name))}: ${oneLine(str(item.name))}` : oneLine(str(item.name)),
          checked: item.state === "complete",
        })),
    );

    let link: string | null = null;
    const attachments: TrelloCard["attachments"] = [];
    for (const file of array(card.attachments)) {
      const url = webUrl(file.url);
      if (!url) continue;
      if (!link && file.isUpload !== true) link = url;
      else attachments.push({ name: oneLine(str(file.name)) || url, url });
    }

    const fields: TrelloCard["fields"] = {};
    for (const item of array(card.customFieldItems)) {
      const field = fieldById.get(str(item.idCustomField));
      const value = isObject(item.value) ? item.value : {};
      if (!field) continue;
      if (field.type === "select") {
        if (field.options.some((o) => o.id === str(item.idValue))) fields[field.id] = str(item.idValue);
      } else if (field.type === "text" && str(value.text).trim()) fields[field.id] = str(value.text).trim();
      else if (field.type === "number" && Number.isFinite(Number.parseFloat(str(value.number)))) fields[field.id] = Number(value.number);
      else if (field.type === "date" && instant(value.date)) fields[field.id] = instant(value.date)!;
      else if (field.type === "checkbox" && value.checked === "true") fields[field.id] = true;
    }

    const labelIds = [
      ...(Array.isArray(card.idLabels) ? card.idLabels.map(str) : []),
      ...array(card.labels).map((l) => str(l.id)),
    ];
    return {
      id,
      shortLink: /^[A-Za-z0-9]{8}$/.test(str(card.shortLink)) ? str(card.shortLink) : null,
      title: oneLine(str(card.name)),
      list: listIndex.get(str(card.idList))!,
      labels: [...new Set(labelIds.flatMap((l) => (labelOf.has(l) ? [labelOf.get(l)!] : [])))],
      members,
      dates: cardDates(instant(card.start), instant(card.due)),
      complete: card.dueComplete === true,
      checklist,
      link,
      description: str(card.desc).trim(),
      comments: commentsOf.get(id) ?? [],
      attachments,
      fields,
    };
  });

  // Color-only labels no imported card has are left out, and the cards' indexes follow.
  const used = new Set(read.flatMap((c) => c.labels));
  const kept = labels.flatMap((label, i) => (label.name || used.has(i) ? [i] : []));
  const index = new Map(kept.map((old, i) => [old, i]));
  for (const c of read) c.labels = c.labels.map((i) => index.get(i)!);

  return {
    title: oneLine(str(json.name)),
    lists: lists.map((l) => ({ id: str(l.id), name: oneLine(str(l.name)).slice(0, 200) })),
    labels: kept.map((i) => labels[i]),
    members: [...usedMembers].map((id) => {
      const m = memberById.get(id)!;
      return { id, fullName: oneLine(str(m.fullName)), username: oneLine(str(m.username)) };
    }),
    customFields,
    cards: read,
    checklistName: checklistNames.size === 1 ? [...checklistNames][0] || null : null,
    archived,
  };
}

/** A comment's time as `YYYY-MM-DD HH:mm` in `timeZone`. */
function commentTime(iso: string, timeZone: string) {
  const ms = Date.parse(iso);
  const offset = isTimeZone(timeZone) ? zoneOffset(ms, timeZone) : 0;
  return new Date(ms + offset).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * A card's row body: its description, then its other attachments and its comments (oldest first,
 * each under its author and time) under headings named by `headings`.
 */
export function cardBody(
  card: Pick<TrelloCard, "description" | "attachments" | "comments">,
  headings: { attachments: string; comments: string },
  { timeZone = "UTC", cardLink }: { timeZone?: string; cardLink?: (shortLink: string) => string | null } = {},
): string {
  const parts: string[] = [];
  if (card.description) parts.push(trelloMarkdown(card.description, cardLink));
  if (card.attachments.length) {
    parts.push(`### ${headings.attachments}`, card.attachments.map((a) => `- [${escapeLinkText(a.name)}](<${a.url}>)`).join("\n"));
  }
  if (card.comments.length) {
    parts.push(`### ${headings.comments}`);
    for (const comment of card.comments) {
      parts.push(`**${escapeLinkText(comment.author)}** · ${commentTime(comment.date, timeZone)}`, trelloMarkdown(comment.text, cardLink));
    }
  }
  return parts.join("\n\n");
}

function escapeLinkText(text: string) {
  return text.replace(/([\\[\]*_`])/g, "\\$1");
}
