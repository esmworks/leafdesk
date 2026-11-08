/**
 * Slack workspace exports (the ZIP Slack's "Export data" writes): `users.json`, `channels.json`
 * (public channels), `groups.json` (private ones, in exports that have them), and a folder per
 * channel, named as the channel, with one JSON file of messages per day (`2024-03-01.json`).
 * Replies carry their thread's first message's `thread_ts`; reactions are names (`thumbsup`,
 * `+1::skin-tone-3`) with the people who gave them; files are addresses on Slack's servers.
 * Direct conversations (`dms.json`, `mpims.json`) are counted, not read: the usual export has none,
 * and Leafdesk's conversations between the same people are one and the same.
 *
 * Pure: the server (server/messages/import.ts) unpacks the ZIP, matches people by email, writes
 * the channels and turns each message's text into a body with `slackBody`. The files come from
 * anyone's export of up to 100 MB on the one process: everything here scans by hand or with
 * patterns that never retry a run against what follows.
 */
import { refLink } from "@/lib/message-text";
import { ImportError } from "./result";
import { SLACK_EMOJI } from "./slack-emoji";

export type SlackUser = { id: string; name: string; email: string | null; bot: boolean };

export type SlackFile = {
  name: string;
  /** The file itself (an address that may carry a token: never shown, only fetched). */
  download: string | null;
  /** Its page on Slack, which people signed in there may open: what a body links to. */
  permalink: string | null;
  contentType: string | null;
  size: number | null;
};

export type SlackReaction = { name: string; users: string[] };

export type SlackMessage = {
  ts: string;
  /** Milliseconds since 1970. */
  time: number;
  user: string | null;
  /** The name Slack showed for it when no user of the export wrote it (a bot, an integration). */
  name: string | null;
  text: string;
  /** The `ts` of the thread's first message, for a reply whose first message is in the export. */
  threadTs: string | null;
  /** A reply also sent to the channel. */
  broadcast: boolean;
  edited: number | null;
  /** A thread's first message deleted on Slack, kept so its replies stay under it. */
  deleted: boolean;
  reactions: SlackReaction[];
  files: SlackFile[];
};

export type SlackChannel = {
  id: string;
  name: string;
  kind: "public" | "private";
  topic: string;
  purpose: string;
  created: number | null;
  creator: string | null;
  archived: boolean;
  members: string[];
  /** In the order they were written (by `ts`), replies among them. */
  messages: SlackMessage[];
};

export type SlackExport = {
  users: Map<string, SlackUser>;
  channels: SlackChannel[];
  /** Direct and group conversations the export lists, which are not imported. */
  directConversations: number;
  /** Replies whose thread's first message the export doesn't have: imported as messages of their own. */
  repliesWithoutThread: number;
};

/** Message subtypes that say what happened in a channel (joined, topic changed …): Leafdesk writes its own. */
const EVENTS = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "channel_convert_to_private",
  "channel_convert_to_public",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "pinned_item",
  "unpinned_item",
  "bot_add",
  "bot_remove",
  "reminder_add",
  "sh_room_created",
]);

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
const TS = /^(\d{1,12})(?:\.(\d{1,9}))?$/;

const decoder = new TextDecoder("utf-8");

function parse(bytes: Uint8Array | undefined): unknown {
  if (!bytes) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes).replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** A `ts` as [seconds, microseconds], or null when it isn't one. */
export function tsParts(ts: unknown): [number, number] | null {
  if (typeof ts !== "string") return null;
  const match = TS.exec(ts);
  if (!match) return null;
  return [Number(match[1]), Number((match[2] ?? "").padEnd(6, "0").slice(0, 6))];
}

/** Orders two `ts` by time; ms precision isn't enough, so both parts are compared. */
export function compareTs(a: string, b: string): number {
  const [as, au] = tsParts(a) ?? [0, 0];
  const [bs, bu] = tsParts(b) ?? [0, 0];
  return as - bs || au - bu;
}

const tsTime = (ts: unknown): number | null => {
  const parts = tsParts(ts);
  return parts ? parts[0] * 1000 + Math.floor(parts[1] / 1000) : null;
};

function readUsers(json: unknown): Map<string, SlackUser> {
  const users = new Map<string, SlackUser>();
  if (!Array.isArray(json)) return users;
  for (const u of json) {
    if (!isRecord(u) || typeof u.id !== "string") continue;
    const profile = isRecord(u.profile) ? u.profile : {};
    const name = str(profile.display_name).trim() || str(profile.real_name).trim() || str(u.real_name).trim() || str(u.name).trim() || u.id;
    const email = str(profile.email).trim().toLowerCase() || null;
    users.set(u.id, { id: u.id, name: name.slice(0, 200), email, bot: u.is_bot === true || u.id === "USLACKBOT" });
  }
  return users;
}

function readFiles(value: unknown): SlackFile[] {
  if (!Array.isArray(value)) return [];
  const files: SlackFile[] = [];
  for (const f of value) {
    if (!isRecord(f) || f.mode === "tombstone" || f.mode === "hidden_by_limit") continue;
    const download = strOrNull(f.url_private_download) ?? strOrNull(f.url_private);
    const permalink = strOrNull(f.permalink);
    if (!download && !permalink) continue;
    files.push({
      name: (str(f.name) || str(f.title) || "file").slice(0, 255),
      download,
      permalink,
      contentType: strOrNull(f.mimetype),
      size: typeof f.size === "number" && f.size >= 0 ? f.size : null,
    });
  }
  return files;
}

function readReactions(value: unknown): SlackReaction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r) => {
    if (!isRecord(r) || typeof r.name !== "string" || !Array.isArray(r.users)) return [];
    return [{ name: r.name, users: r.users.filter((u): u is string => typeof u === "string") }];
  });
}

/** What a message's attachments say, for a bot's message that has no text of its own. */
function attachmentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((a) => (isRecord(a) ? [str(a.fallback) || [str(a.title), str(a.text)].filter(Boolean).join("\n")] : []))
    .filter(Boolean)
    .join("\n\n");
}

function readMessage(m: unknown): SlackMessage | null {
  if (!isRecord(m) || (m.type !== undefined && m.type !== "message")) return null;
  const subtype = str(m.subtype);
  if (EVENTS.has(subtype)) return null;
  const ts = str(m.ts);
  const time = tsTime(ts);
  if (time === null) return null;
  const deleted = subtype === "tombstone";
  const files = deleted ? [] : readFiles(m.files);
  const text = deleted ? "" : str(m.text) || attachmentText(m.attachments);
  if (!deleted && !text.trim() && !files.length) return null;
  const profile = isRecord(m.user_profile) ? m.user_profile : isRecord(m.bot_profile) ? m.bot_profile : {};
  const threadTs = str(m.thread_ts);
  const edited = isRecord(m.edited) ? tsTime(m.edited.ts) : null;
  return {
    ts,
    time,
    user: strOrNull(m.user),
    name: (strOrNull(m.username) ?? strOrNull(profile.display_name) ?? strOrNull(profile.real_name) ?? strOrNull(profile.name))?.slice(0, 200) ?? null,
    text,
    threadTs: threadTs && threadTs !== ts && tsParts(threadTs) ? threadTs : null,
    broadcast: subtype === "thread_broadcast",
    edited: edited !== null && edited > time ? edited : null,
    deleted,
    reactions: deleted ? [] : readReactions(m.reactions),
    files,
  };
}

/**
 * Reads an export's files (by path inside the ZIP; a folder around them all is fine). Throws
 * ImportError `badSlack` when there is no `channels.json` or `groups.json`.
 */
export function readSlackExport(files: Map<string, Uint8Array>): SlackExport {
  // The export's own folder: where channels.json (or groups.json) is, the shallowest one.
  let root: string | null = null;
  for (const path of files.keys()) {
    const slash = path.lastIndexOf("/");
    const name = path.slice(slash + 1);
    if (name !== "channels.json" && name !== "groups.json") continue;
    const folder = path.slice(0, slash + 1);
    if (root === null || folder.length < root.length) root = folder;
  }
  if (root === null) throw new ImportError("The upload isn't a Slack export", "badSlack");
  const at = (name: string) => files.get(`${root}${name}`);

  // Each channel folder's day files.
  const days = new Map<string, string[]>();
  for (const path of files.keys()) {
    if (!path.startsWith(root)) continue;
    const rest = path.slice(root.length);
    const slash = rest.indexOf("/");
    if (slash < 0 || rest.indexOf("/", slash + 1) >= 0) continue;
    if (!DAY_FILE.test(rest.slice(slash + 1))) continue;
    const folder = rest.slice(0, slash);
    days.set(folder, [...(days.get(folder) ?? []), path]);
  }

  const users = readUsers(parse(at("users.json")));
  const channels: SlackChannel[] = [];
  const seen = new Set<string>();
  let repliesWithoutThread = 0;
  const lists: [unknown, "public" | "private"][] = [
    [parse(at("channels.json")), "public"],
    [parse(at("groups.json")), "private"],
  ];
  for (const [list, kind] of lists) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!isRecord(c) || typeof c.id !== "string" || typeof c.name !== "string" || !c.name || seen.has(c.id)) continue;
      seen.add(c.id);
      const byTs = new Map<string, SlackMessage>();
      for (const path of days.get(c.name) ?? []) {
        const day = parse(files.get(path));
        if (!Array.isArray(day)) continue;
        for (const raw of day) {
          const message = readMessage(raw);
          if (message && !byTs.has(message.ts)) byTs.set(message.ts, message);
        }
      }
      const messages = [...byTs.values()].sort((a, b) => compareTs(a.ts, b.ts));
      for (const m of messages) {
        if (!m.threadTs) continue;
        const root = byTs.get(m.threadTs);
        // A reply to a reply, or to a message the export lacks: a message of its own.
        if (!root || root.threadTs) {
          m.threadTs = null;
          m.broadcast = false;
          repliesWithoutThread++;
        }
      }
      const field = (value: unknown) => (isRecord(value) ? str(value.value).trim() : "");
      channels.push({
        id: c.id,
        name: c.name,
        kind: kind === "private" || c.is_private === true ? "private" : "public",
        topic: field(c.topic),
        purpose: field(c.purpose),
        created: typeof c.created === "number" && c.created > 0 ? c.created * 1000 : null,
        creator: strOrNull(c.creator),
        archived: c.is_archived === true,
        members: Array.isArray(c.members) ? c.members.filter((u): u is string => typeof u === "string") : [],
        messages,
      });
    }
  }
  const count = (json: unknown) => (Array.isArray(json) ? json.length : 0);
  return { users, channels, directConversations: count(parse(at("dms.json"))) + count(parse(at("mpims.json"))), repliesWithoutThread };
}

/** The emoji a reaction's name stands for (`thumbsup`, `+1::skin-tone-3`), or null for a custom one. */
export function slackEmoji(name: string): string | null {
  const [base, tone] = name.split("::");
  const emoji = SLACK_EMOJI[base];
  if (!emoji) return null;
  const level = /^skin-tone-([2-6])$/.exec(tone ?? "")?.[1];
  if (!level) return emoji;
  // The tone modifier goes after the first character, in place of its variation selector.
  const first = String.fromCodePoint(emoji.codePointAt(0)!);
  const rest = emoji.slice(first.length).replace(/^️/, "");
  return first + String.fromCodePoint(0x1f3fb + Number(level) - 2) + rest;
}

/** How a message's text names people and channels: the server's matches. */
export type SlackNames = {
  /** A user of the export: their Leafdesk id when one matched, and the name to show. */
  user: (id: string) => { userId: string | null; name: string };
  /** A channel of the export by id: its name in Leafdesk (it may have been renamed on import). */
  channel: (id: string) => string | null;
};

const unescape = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const linkText = (text: string) => text.replace(/[[\]\\]/g, "").replace(/\s+/g, " ").trim();
const SAFE_LINK = /^(?:https?:|mailto:)/i;

/** A `<…>` token of Slack's text, as Markdown (`code`: inside code, where it is only words). */
function token(inner: string, names: SlackNames, code: boolean): string {
  const bar = inner.indexOf("|");
  const target = bar < 0 ? inner : inner.slice(0, bar);
  const label = bar < 0 ? "" : unescape(inner.slice(bar + 1));
  if (target.startsWith("@")) {
    const person = names.user(target.slice(1));
    const name = label.replace(/^@/, "") || person.name;
    return person.userId && !code ? refLink({ kind: "user", id: person.userId }, `@${name}`) : `@${name}`;
  }
  if (target.startsWith("#")) return `#${names.channel(target.slice(1)) ?? (label || target.slice(1))}`;
  if (target.startsWith("!")) {
    const word = target.slice(1);
    if (word === "channel" || word === "here" || word === "everyone") return `@${word}`;
    // `!subteam^S1|@design`, `!date^1700000000^{date}|Nov 14`: what Slack showed.
    return label || "";
  }
  const url = unescape(target);
  if (code || !SAFE_LINK.test(url)) return label || url;
  if (!label || label === url) return url.toLowerCase().startsWith("mailto:") ? url.slice(7) : `<${url}>`;
  return `[${linkText(label) || url}](${url.replace(/[()\s]/g, encodeURIComponent)})`;
}

/** `:name:` and `:name::skin-tone-3:` in text, made into the emoji (custom ones stay as written). */
function emojiWords(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const colon = text.indexOf(":", i);
    if (colon < 0) break;
    let end = text.indexOf(":", colon + 1);
    // A name is short and has no spaces; `:+1::skin-tone-2:` continues past its second colon.
    if (end > colon && end - colon <= 64 && /^[a-z0-9_+'-]+$/.test(text.slice(colon + 1, end))) {
      if (text.startsWith("::skin-tone-", end) && text.charAt(end + 13) === ":") end += 13;
      const emoji = slackEmoji(text.slice(colon + 1, end));
      if (emoji) {
        out += text.slice(i, colon) + emoji;
        i = end + 1;
        continue;
      }
    }
    out += text.slice(i, colon + 1);
    i = colon + 1;
  }
  return out + text.slice(i);
}

const isSpace = (ch: string) => ch === "" || /\s/.test(ch);
const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
/** How far ahead a closing `*` or `~` is looked for (a line of them can't make this quadratic). */
const MARK_REACH = 1000;

/** Slack's `*bold*` and `~strike~` in plain text as Markdown's `**bold**` and `~~strike~~`; `_italic_` is the same in both. */
function marks(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if ((ch === "*" || ch === "~") && !isWordChar(text[i - 1] ?? "") && !isSpace(text[i + 1] ?? "") && text[i + 1] !== ch) {
      let close = -1;
      const limit = Math.min(text.length, i + 1 + MARK_REACH);
      for (let j = i + 2; j < limit; j++) {
        if (text[j] === "\n") break;
        if (text[j] === ch && !isSpace(text[j - 1]) && !isWordChar(text[j + 1] ?? "")) {
          close = j;
          break;
        }
      }
      if (close > 0) {
        const mark = ch + ch;
        out += mark + text.slice(i + 1, close) + mark;
        i = close + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** The longest `<…>` token read; past it a `<` is a character. */
const TOKEN_REACH = 4000;

/**
 * Splits text at its `<…>` tokens: `words` gets the text between them, `tokens` each token's
 * inside. Scans by hand and stops at the next `<` or line end, so no stretch is read twice.
 */
function splitTokens(text: string, words: (text: string) => string, tokens: (inner: string) => string): string {
  let out = "";
  let from = 0;
  let i = text.indexOf("<");
  while (i >= 0) {
    let close = -1;
    let next = -1;
    const limit = Math.min(text.length, i + 1 + TOKEN_REACH);
    for (let j = i + 1; j < limit; j++) {
      const ch = text[j];
      if (ch === ">") {
        close = j;
        break;
      }
      if (ch === "<") {
        next = j;
        break;
      }
      if (ch === "\n") break;
    }
    if (close > i + 1) {
      out += words(text.slice(from, i)) + tokens(text.slice(i + 1, close));
      from = close + 1;
      i = text.indexOf("<", from);
    } else i = next >= 0 ? next : text.indexOf("<", i + 1);
  }
  return out + words(text.slice(from));
}

/** Text outside code: tokens, then entities, emoji names and marks. */
const prose = (text: string, names: SlackNames) =>
  splitTokens(
    text,
    (words) => marks(emojiWords(unescape(words))),
    (inner) => token(inner, names, false),
  );

/** Text inside code: tokens become their words, entities their characters, nothing else changes. */
const codeText = (text: string, names: SlackNames) =>
  splitTokens(text, unescape, (inner) => token(inner, names, true));

/**
 * A message's Slack text as a Leafdesk body: people who matched become mentions (never notified:
 * the importer writes no mention rows), the others their names; channels their names; `@channel`
 * and `@here` stay words; links Markdown links; emoji names emoji; bold and strikethrough Markdown's.
 * Code blocks and spans keep their text.
 */
export function slackBody(text: string, names: SlackNames): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf("`", i);
    if (tick < 0) break;
    out += prose(text.slice(i, tick), names);
    if (text.startsWith("```", tick)) {
      const end = text.indexOf("```", tick + 3);
      if (end < 0) {
        out += prose(text.slice(tick), names);
        i = text.length;
        break;
      }
      let inner = codeText(text.slice(tick + 3, end), names);
      // Slack writes ```code``` on one line too; Markdown's fence needs its own lines.
      if (!inner.startsWith("\n")) inner = `\n${inner}`;
      if (!inner.endsWith("\n")) inner += "\n";
      out += `\`\`\`${inner}\`\`\``;
      i = end + 3;
      continue;
    }
    const end = text.indexOf("`", tick + 1);
    const newline = text.indexOf("\n", tick + 1);
    if (end < 0 || (newline >= 0 && newline < end)) {
      out += "`";
      i = tick + 1;
      continue;
    }
    out += `\`${codeText(text.slice(tick + 1, end), names)}\``;
    i = end + 1;
  }
  return out + prose(text.slice(i), names);
}

/** Slack text as plain words (a channel's topic and purpose): tokens their names, entities their characters. */
export const slackPlainText = (text: string, names: SlackNames) => codeText(text, names);

/** What an import of a Slack export left out or changed, for the dialog to say in the person's language. */
export type SlackImportWarning =
  /** A channel's name was taken in the workspace: it was imported as `to`. */
  | { code: "renamed"; from: string; to: string }
  /** The channel was imported before (and is still here): left as it is. */
  | { code: "alreadyImported"; name: string }
  /** People of the export whose email matched no member: their messages show their name (some of them in `names`). */
  | { code: "unmatchedPeople"; count: number; names: string[] }
  /** Reactions with a custom emoji or by someone who matched no member. */
  | { code: "reactionsLeftOut"; count: number }
  /** Direct and group conversations of the export, which are not imported. */
  | { code: "directLeftOut"; count: number }
  /** Replies whose thread's first message the export lacks: imported as messages of their own. */
  | { code: "repliesWithoutThread"; count: number }
  /** Files that couldn't be downloaded (or weren't asked for): linked to their page on Slack instead. */
  | { code: "filesAsLinks"; count: number };

export type SlackImportResult = {
  channels: { id: string; name: string; kind: "public" | "private"; messages: number }[];
  created: { channels: number; messages: number; reactions: number; files: number };
  people: { matched: number; unmatched: number };
  warnings: SlackImportWarning[];
};
