/**
 * A Logseq graph in a Markdown import (see server/import/markdown.ts). A graph is a folder holding
 * `logseq/config.edn` (its settings), `pages/` (a Markdown file per page; a namespace's `/` is
 * written `___` in the file name, older graphs encode it as `%2F`), `journals/` (a file per day,
 * `2024_01_15.md` by default) and `assets/` (pictures and files the pages show).
 *
 * Each graph's pages and journals become Markdown files the import reads as an Obsidian-like vault
 * (lib/import/obsidian): pages at the top of the graph's folder (`A/B` as `A/B.md`, a subpage of
 * `A`), journal days in `journals/` as `2024-01-15.md`, titled as the graph titles them (its
 * `:journal/page-title-format`), so `[[Jan 15th, 2024]]` finds them. Front matter carries each
 * page's title and the names a link may use for it (its full name, `title::` and `alias::`).
 *
 * The outline is written as Markdown: blocks stay bulleted lists, except headings (and code,
 * tables and quotes) whose blocks above are all headings too, which come out of the list.
 * TODO/DOING/LATER/NOW are to-dos, DONE ticked ones, CANCELED struck through; a SCHEDULED or
 * DEADLINE day becomes a date mention on the to-do. A link to a page the graph has no file for
 * (Logseq makes those pages on the fly) is its text; `#[[two words]]` a `#two-words` tag. Block
 * references `((uuid))` and block embeds are the referenced block's text, page embeds a link to
 * the page on a line of its own. Macros the editor has nothing for (`{{query …}}`) stay as code;
 * internal block properties (`id::`, `collapsed::` …) and logbooks are left out, other properties
 * stay as `key: value` lines in their block. Settings, drawings, whiteboards and backups go.
 *
 * Pure: only file names and text. Read by hand where a regex would retry: these are untrusted files.
 */

import { decodeText } from "./csv-parse";
import { rewriteLinks } from "./markdown";

const CONFIG = "logseq/config.edn";
/** Folders of a graph that hold no pages. */
const LEFT_OUT = ["logseq/", "draws/", "whiteboards/", "version-files/", "bak/"];

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isMarkdown = (path: string) => /\.(?:md|markdown)$/i.test(path);
const stem = (name: string) => name.replace(/\.(?:md|markdown)$/i, "");

/** The graph folders of an upload (`""` for one at its top), found by their `logseq/config.edn`. */
export function logseqRoots(paths: Iterable<string>): string[] {
  const roots: string[] = [];
  for (const path of paths) {
    if (path === CONFIG) roots.push("");
    else if (path.endsWith(`/${CONFIG}`)) roots.push(path.slice(0, -CONFIG.length));
  }
  return roots;
}

/** A string setting of config.edn (`:journal/page-title-format "MMM do, yyyy"`) not commented out, or null. */
export function configString(config: string, key: string): string | null {
  for (let at = config.indexOf(key); at !== -1; at = config.indexOf(key, at + key.length)) {
    const lineStart = config.lastIndexOf("\n", at) + 1;
    if (config.slice(lineStart, at).includes(";")) continue;
    const after = config.charAt(at + key.length);
    if (after && !/[\s"]/.test(after)) continue;
    const open = config.indexOf('"', at + key.length);
    const newline = config.indexOf("\n", at);
    if (open === -1 || (newline !== -1 && open > newline)) continue;
    const close = config.indexOf('"', open + 1);
    if (close === -1) return null;
    return config.slice(open + 1, close);
  }
  return null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TOKENS = ["yyyy", "yy", "MMMM", "MMM", "MM", "M", "do", "dd", "d", "EEEE", "EEE", "EE", "E"];

const pad = (n: number) => String(n).padStart(2, "0");
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** A day written in a Logseq date format (date-fns' tokens, `'…'` for literal text). */
export function formatDay(year: number, month: number, day: number, format: string): string {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  let out = "";
  for (let i = 0; i < format.length; ) {
    if (format[i] === "'") {
      const close = format.indexOf("'", i + 1);
      const end = close === -1 ? format.length : close;
      out += format.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    const token = TOKENS.find((t) => format.startsWith(t, i));
    if (!token) {
      out += format[i++];
      continue;
    }
    i += token.length;
    if (token === "yyyy") out += String(year);
    else if (token === "yy") out += pad(year % 100);
    else if (token === "MMMM") out += MONTHS[month - 1];
    else if (token === "MMM") out += MONTHS[month - 1].slice(0, 3);
    else if (token === "MM") out += pad(month);
    else if (token === "M") out += String(month);
    else if (token === "do") out += ordinal(day);
    else if (token === "dd") out += pad(day);
    else if (token === "d") out += String(day);
    else if (token === "EEEE") out += DAYS[weekday];
    else out += DAYS[weekday].slice(0, 3);
  }
  return out;
}

/**
 * The day a journal's file name holds, read in the order the graph's file-name format puts the
 * year, month and day (`yyyy_MM_dd` by default); null when it holds none.
 */
export function journalDay(name: string, fileFormat = "yyyy_MM_dd"): { year: number; month: number; day: number } | null {
  const digits = name.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const order = (["yyyy", "MM", "dd"] as const)
    .map((token) => ({ token, at: fileFormat.indexOf(token) }))
    .sort((a, b) => (a.at === -1 ? 99 : a.at) - (b.at === -1 ? 99 : b.at));
  let at = 0;
  const parts: Record<string, number> = {};
  for (const { token } of order) {
    const length = token === "yyyy" ? 4 : 2;
    parts[token] = Number(digits.slice(at, at + length));
    at += length;
  }
  const { yyyy: year, MM: month, dd: day } = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** A page's name from its file name: `A___B` and `A%2FB` are the page `A/B`. */
export function pageName(fileStem: string): string {
  let name = fileStem.split("___").join("/");
  try {
    name = decodeURIComponent(name);
  } catch {}
  return name.normalize("NFC");
}

/** A name as a file or folder name: no slashes, no leading dot, not too long. */
function safeName(name: string): string {
  let out = name.replace(/\\/g, "-").replace(/[\u0000-\u001f]/g, " ").trim();
  while (out.startsWith(".")) out = out.slice(1);
  return out.slice(0, 150).trim();
}

/** `path` as a link from the file at `from`: relative, each part URL-encoded. */
function hrefFrom(from: string, path: string): string {
  const fromDir = dirname(from) ? dirname(from).split("/") : [];
  const parts = path.split("/");
  let common = 0;
  while (common < fromDir.length && common < parts.length - 1 && fromDir[common] === parts[common]) common++;
  return [...fromDir.slice(common).map(() => ".."), ...parts.slice(common).map(encodeURIComponent)].join("/");
}

// ——— The outline ———

/** `key:: value` (the key letters, digits, `_`, `-`, `.`, `/`). */
const PROPERTY = /^([A-Za-z0-9_./-]+)::(?:[ \t]|$)/;
/** Properties Logseq keeps for itself: left out. */
const INTERNAL = new Set(["id", "collapsed", "heading", "background-color", "background_color", "ls-type", "hl-type", "hl-page", "hl-stamp", "hl-color", "card-last-interval", "card-repeats", "card-ease-factor", "card-next-schedule", "card-last-reviewed", "card-last-score", "filters", "icon", "public", "exclude-from-graph-view"]);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MARKERS: Record<string, "todo" | "done" | "canceled"> = {
  TODO: "todo",
  DOING: "todo",
  LATER: "todo",
  NOW: "todo",
  WAIT: "todo",
  WAITING: "todo",
  "IN-PROGRESS": "todo",
  DONE: "done",
  CANCELED: "canceled",
  CANCELLED: "canceled",
};
/** A line of one picture: `![alt](href)`, an attribute map after it allowed. */
const IMAGE_ALONE = /^!\[[^\]\n]*\]\([^)\n]*\)(?:\{[^}\n]*\})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Block = { depth: number; lines: string[] };

/** Leading tabs and spaces of a line, and how wide they are (a tab as four). */
function indentOf(line: string): { text: string; width: number } {
  let i = 0;
  let width = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) width += line[i++] === "\t" ? 4 : 1;
  return { text: line.slice(0, i), width };
}

/**
 * A page's text as its blocks (`- ` lines and what follows each up to the next) and the lines
 * before the first one. Lines in a fenced code block stay in their block, bullets or not.
 */
export function parseOutline(markdown: string): { before: string[]; blocks: Block[] } {
  const lines = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const before: string[] = [];
  const blocks: Block[] = [];
  const open: number[] = [];
  let current: (Block & { indent: number }) | null = null;
  let fence: string | null = null;
  for (const line of lines) {
    if (current && fence) {
      const content = stripIndent(line, current.indent + 2);
      current.lines.push(content);
      const marker = FENCE.exec(content)?.[1];
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && content.trim() === marker) fence = null;
      continue;
    }
    const { text: indent, width } = indentOf(line);
    const rest = line.slice(indent.length);
    if (rest === "-" || rest.startsWith("- ")) {
      while (open.length && open[open.length - 1] >= width) open.pop();
      current = { depth: open.length, lines: [rest.slice(2)], indent: width };
      open.push(width);
      blocks.push(current);
    } else if (current) {
      current.lines.push(stripIndent(line, current.indent + 2));
    } else {
      before.push(line);
      continue;
    }
    const last = current.lines[current.lines.length - 1];
    const marker = FENCE.exec(last)?.[1];
    if (marker && !last.trim().slice(marker.length).includes(marker[0])) fence = marker;
  }
  // Blank lines between blocks belong to none.
  const trimmed = (lines: string[]) => {
    let end = lines.length;
    while (end > 1 && !lines[end - 1].trim()) end--;
    return lines.slice(0, end);
  };
  return { before, blocks: blocks.map(({ depth, lines }) => ({ depth, lines: trimmed(lines) })) };
}

/** `line` without up to `width` columns of leading white space. */
function stripIndent(line: string, width: number): string {
  let i = 0;
  let taken = 0;
  while (i < line.length && taken < width && (line[i] === " " || line[i] === "\t")) taken += line[i++] === "\t" ? 4 : 1;
  return line.slice(i);
}

/** A block's or a page's properties (`key:: value` lines) taken out of its lines. */
function takeProperties(lines: string[]): { lines: string[]; properties: [string, string][] } {
  const kept: string[] = [];
  const properties: [string, string][] = [];
  let fence = false;
  let drawer = false;
  for (const line of lines) {
    if (FENCE.test(line)) fence = !fence;
    if (fence) {
      kept.push(line);
      continue;
    }
    const trimmed = line.trim();
    // Org drawers (a logbook of clocked time, org-style properties): left out.
    if (drawer) {
      if (trimmed.toUpperCase() === ":END:") drawer = false;
      continue;
    }
    if (/^:[A-Z]+:$/i.test(trimmed) && trimmed.toUpperCase() !== ":END:") {
      drawer = true;
      continue;
    }
    const property = PROPERTY.exec(trimmed);
    if (property) properties.push([property[1].toLowerCase(), trimmed.slice(property[0].length).trim()]);
    else kept.push(line);
  }
  return { lines: kept, properties };
}

/** A property's value as a list of names: `[[A]], B, "C"`. */
export function propertyNames(value: string): string[] {
  const names: string[] = [];
  for (const part of value.split(",")) {
    let name = part.trim();
    if (name.startsWith("#")) name = name.slice(1);
    if (name.startsWith("[[") && name.endsWith("]]")) name = name.slice(2, -2);
    name = name.replace(/^"(.*)"$/, "$1").trim();
    if (name) names.push(name);
  }
  return names;
}

/** What links and references in a page's text can find. */
export type GraphContext = {
  /** Whether a page of the graph goes by `name` (without case). */
  knows: (name: string) => boolean;
  /** The text of the block with this id, or null. */
  blockText: (uuid: string) => string | null;
};

/** `fn` on the parts of a line outside inline code spans. */
const outsideCodeSpans = (line: string, fn: (text: string) => string) =>
  line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join("");

/** `{{name args}}` macros as what the editor can show. */
function macros(text: string, context: GraphContext, alone: boolean): string {
  let out = "";
  let at = 0;
  for (let open = text.indexOf("{{"); open !== -1; open = text.indexOf("{{", at)) {
    const close = text.indexOf("}}", open + 2);
    if (close === -1) break;
    out += text.slice(at, open);
    const inner = text.slice(open + 2, close).trim();
    const space = inner.search(/\s/);
    const name = (space === -1 ? inner : inner.slice(0, space)).toLowerCase();
    const arg = space === -1 ? "" : inner.slice(space + 1).trim();
    if (name === "embed") {
      if (arg.startsWith("((") && arg.endsWith("))")) out += context.blockText(arg.slice(2, -2).trim()) ?? "";
      else if (arg.startsWith("[[") && arg.endsWith("]]")) {
        const target = arg.slice(2, -2).trim();
        out += context.knows(target) ? `${alone ? "!" : ""}[[${target}]]` : target;
      } else out += arg;
    } else if (["video", "youtube", "tweet", "twitter", "vimeo", "bilibili", "pdf"].includes(name)) out += arg;
    else if (name === "cloze") out += arg;
    else out += `\`{{${inner.replace(/`/g, "'")}}}\``;
    at = close + 2;
  }
  return out + text.slice(at);
}

/**
 * One line's inline syntax as the editor reads it (see the top): macros, labelled links to pages
 * and blocks, block references, `#[[tags]]`, links to pages the graph has no file for, `^^marks^^`
 * and the attribute maps after images. Code spans stay.
 */
export function inlineMarkdown(line: string, context: GraphContext, alone = false): string {
  return outsideCodeSpans(line, (part) => {
    // `[label](((uuid)))`: the label.
    let text = replaceBetween(part, "](((", ")))", (inner, before) => {
      const label = labelBefore(before);
      return label !== null && UUID.test(inner.trim()) ? { cut: label.length + 1, with: label } : null;
    });
    // `[label]([[Page]])`.
    text = replaceBetween(text, "](", ")", (inner, before) => {
      if (!inner.startsWith("[[") || !inner.endsWith("]]")) return null;
      const label = labelBefore(before);
      if (label === null) return null;
      const target = inner.slice(2, -2).trim();
      return { cut: label.length + 1, with: context.knows(target) ? `[[${target}|${label}]]` : label };
    });
    // `((uuid))`.
    text = replaceBetween(text, "((", "))", (inner) => {
      const id = inner.trim();
      return UUID.test(id) ? { cut: 0, with: context.blockText(id) ?? "" } : null;
    });
    // `#[[two words]]`: a link where the graph has the page, else a tag.
    text = replaceBetween(text, "#[[", "]]", (inner) => {
      const name = inner.trim();
      if (context.knows(name)) return { cut: 0, with: `[[${name}]]` };
      const tag = name.replace(/\s+/g, "-");
      return { cut: 0, with: tag ? `#${tag}` : "" };
    });
    // `[[Page]]` the graph has no file for: its text.
    text = replaceBetween(text, "[[", "]]", (inner, before) => {
      const target = inner.split("|")[0].trim();
      if (context.knows(target)) return null;
      return { cut: before.endsWith("!") ? 1 : 0, with: inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : target };
    });
    text = replaceBetween(text, "^^", "^^", (inner) => (inner.trim() && !inner.includes("\n") ? { cut: 0, with: inner } : null));
    // `![a](../assets/a.png){:height 300, :width 400}`: the attribute map goes.
    text = replaceBetween(text, "){:", "}", () => ({ cut: 0, with: ")" }));
    // Last: a page embed's link has been checked by now, and a macro kept as code stays as it is.
    return macros(text, context, alone);
  });
}

/** The `[label` that `text` ends with (the part of a link before `](`), or null. */
function labelBefore(text: string): string | null {
  const open = text.lastIndexOf("[");
  if (open === -1) return null;
  const label = text.slice(open + 1);
  return label.includes("]") ? null : label;
}

/** How much of the text before a match `replaceBetween` shows its callback (a link's label at most). */
const BEFORE = 300;
/** The longest `open…close` `replaceBetween` reads as one. */
const INNER = 2000;

/**
 * Each `open…close` in `text` (the first `close` after `open`) through `replace`, which gets what
 * is between them and up to BEFORE characters of the text before (since the last replacement),
 * and returns the replacement and how many of those characters it takes away too; null leaves
 * it. Read once from left to right.
 */
function replaceBetween(
  text: string,
  open: string,
  close: string,
  replace: (inner: string, before: string) => { cut: number; with: string } | null,
): string {
  const parts: string[] = [];
  let at = 0;
  let from = 0;
  // The first `close` after the last `open`: the same for every later `open` before it.
  let end = -1;
  for (let start = text.indexOf(open, from); start !== -1; start = text.indexOf(open, from)) {
    if (end < start + open.length) end = text.indexOf(close, start + open.length);
    if (end === -1) break;
    // What is far apart isn't one piece of syntax (and reading it for each `open` would take long).
    if (end - start > INNER) {
      from = start + open.length;
      continue;
    }
    const before = text.slice(Math.max(at, start - BEFORE), start);
    const replaced = replace(text.slice(start + open.length, end), before);
    if (!replaced) {
      from = start + open.length;
      continue;
    }
    parts.push(text.slice(at, start - Math.min(replaced.cut, before.length)), replaced.with);
    at = end + close.length;
    from = at;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/** A block's first line without its task marker and priority: what the marker said, and the text. */
function taskOf(line: string): { task: "todo" | "done" | "canceled" | null; text: string } {
  const space = line.indexOf(" ");
  const word = space === -1 ? line : line.slice(0, space);
  const task = MARKERS[word] ?? null;
  let text = task ? (space === -1 ? "" : line.slice(space + 1)) : line;
  // `[#A]` priorities: a tag.
  if (/^\[#[A-C]\]/.test(text)) text = `#${text[2]}${text.slice(4)}`;
  return { task, text };
}

/** A SCHEDULED or DEADLINE line's day (`SCHEDULED: <2024-01-15 Mon>`), or null. */
function plannedDay(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("SCHEDULED: <") && !trimmed.startsWith("DEADLINE: <")) return null;
  const day = trimmed.slice(trimmed.indexOf("<") + 1, trimmed.indexOf("<") + 11);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** The block's heading level (`## Text` or `heading:: 2`), or 0. */
function headingLevel(first: string, properties: [string, string][]): number {
  let level = 0;
  while (level < first.length && first[level] === "#") level++;
  if (level >= 1 && level <= 6 && first[level] === " ") return level;
  const property = properties.find(([key]) => key === "heading")?.[1];
  if (property === "true") return 2;
  const number = Number(property);
  return Number.isInteger(number) && number >= 1 && number <= 6 ? number : 0;
}

/** The text a block shows for a reference to it: its first line without marker, heading or properties. */
export function referenceText(block: Block): string {
  const { lines } = takeProperties(block.lines);
  const first = taskOf((lines[0] ?? "").trim()).text;
  let level = 0;
  while (level < first.length && first[level] === "#") level++;
  return (level && first[level] === " " ? first.slice(level + 1) : first).trim();
}

/** The `id::` a block carries, or null. */
export function blockId(block: Block): string | null {
  for (const line of block.lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("id:: ")) {
      const id = trimmed.slice(5).trim();
      if (UUID.test(id)) return id.toLowerCase();
    }
  }
  return null;
}

/**
 * The page's outline (its blocks, without page properties) as Markdown, see the top.
 */
export function outlineMarkdown(blocks: Block[], context: GraphContext): string {
  const out: string[] = [];
  // Per depth: whether the block open there came out of the list, and the list level it set.
  const lifted: boolean[] = [];
  const level: number[] = [];
  let inList = false;
  for (const block of blocks) {
    const { lines, properties } = takeProperties(block.lines);
    const day = lines.map(plannedDay).find((d) => d !== null) ?? null;
    const body = lines.filter((line) => plannedDay(line) === null);
    const { task, text: firstText } = taskOf((body[0] ?? "").trim());
    const heading = headingLevel(firstText, properties);
    const ancestorsLifted = lifted.slice(0, block.depth).every(Boolean);
    // Code, tables, quotes and pictures alone (the editor has no picture inside a list item).
    const blockSyntax =
      FENCE.test(firstText) || firstText.startsWith("|") || firstText.startsWith(">") || (body.length === 1 && IMAGE_ALONE.test(firstText.trim()));
    const kept = properties.filter(([key]) => !INTERNAL.has(key) && key !== "title" && key !== "alias").map(([key, value]) => `${key}: ${value}`);
    const rest = [...body.slice(1), ...kept];
    let first = firstText;
    if (heading && /^#{1,6} /.test(first)) first = first.slice(first.indexOf(" ") + 1);
    // An empty block shows nothing; what is under it goes where it would have gone under its parent.
    const empty = !task && !first.trim() && !rest.some((l) => l.trim());
    const lift = ancestorsLifted && (heading > 0 || blockSyntax || empty) && !task;
    lifted[block.depth] = lift;
    lifted.length = block.depth + 1;
    const parentLevel = block.depth === 0 ? -1 : (level[block.depth - 1] ?? -1);
    const myLevel = lift || empty ? parentLevel : parentLevel + 1;
    level[block.depth] = myLevel;
    level.length = block.depth + 1;
    if (empty) continue;
    const alone = rest.length === 0;
    // Lines of the block, inline syntax worked out outside fenced code.
    let fence = false;
    const inline = (line: string, single = false) => {
      if (FENCE.test(line)) {
        fence = !fence;
        return line;
      }
      return fence ? line : inlineMarkdown(line, context, single);
    };
    first = inline(first, alone);
    const more = rest.map((line) => inline(line));
    if (task === "canceled" && first.trim()) first = `~~${first.trim()}~~`;
    if (day) first = `${first.trimEnd()} @${day}`;

    if (lift) {
      if (inList || out.length) out.push("");
      inList = false;
      if (heading) out.push(`${"#".repeat(heading)} ${first.trim()}`);
      else out.push(first, ...more);
      continue;
    }
    if (!inList && out.length) out.push("");
    inList = true;
    const pad = "  ".repeat(Math.max(0, myLevel));
    const box = task ? (task === "todo" ? "[ ] " : "[x] ") : "";
    const text = heading && !lift ? `**${first.trim()}**` : first;
    out.push(`${pad}- ${box}${text}`);
    for (const line of more) out.push(line.trim() ? `${pad}  ${line}` : "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ——— The graph ———

export type LogseqResult = { files: Map<string, Uint8Array>; graphs: number };

type GraphPage = { from: string; to: string; title: string; aliases: string[]; blocks: Block[]; before: string[] };

/**
 * The upload's files with each Logseq graph's pages and journals as Markdown files laid out and
 * written as above. Files outside the graphs stay as they are.
 */
export function unpackLogseqGraphs(files: Map<string, Uint8Array>): LogseqResult {
  const roots = logseqRoots(files.keys());
  if (!roots.length) return { files, graphs: 0 };
  const out = new Map(files);
  // Deeper graphs first, so a graph inside another's folder is its own.
  const sorted = [...roots].sort((a, b) => b.length - a.length);
  const claimed = new Set<string>();
  for (const root of sorted) {
    const inside = [...files.keys()].filter((p) => p.startsWith(root) && !claimed.has(p));
    for (const p of inside) claimed.add(p);
    const config = decodeText(files.get(`${root}${CONFIG}`)!);
    const titleFormat = configString(config, ":journal/page-title-format") ?? "MMM do, yyyy";
    const fileFormat = configString(config, ":journal/file-name-format") ?? "yyyy_MM_dd";

    const pages: GraphPage[] = [];
    const taken = new Map<string, Set<string>>();
    const place = (dir: string, name: string) => {
      if (!taken.has(dir)) taken.set(dir, new Set());
      const set = taken.get(dir)!;
      let candidate = name;
      for (let n = 2; set.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
      set.add(candidate.toLowerCase());
      return candidate;
    };
    for (const path of inside) {
      const local = path.slice(root.length);
      if (LEFT_OUT.some((folder) => local.startsWith(folder))) {
        out.delete(path);
        continue;
      }
      if (!isMarkdown(path)) continue;
      const text = decodeText(files.get(path)!);
      const { before, blocks } = parseOutline(text);
      // Page properties: lines before the first block, or a first block of nothing but properties.
      let pageProperties = takeProperties(before).properties;
      let pageBlocks = blocks;
      if (!pageProperties.length && blocks[0]) {
        const first = takeProperties(blocks[0].lines);
        if (first.properties.length && !first.lines.some((l) => l.trim())) {
          pageProperties = first.properties;
          pageBlocks = blocks.slice(1);
        }
      }
      const property = (key: string) => pageProperties.find(([k]) => k === key)?.[1];
      const aliases = propertyNames(property("alias") ?? "");
      if (local.startsWith("journals/")) {
        const day = journalDay(stem(basename(local)), fileFormat);
        if (day) {
          const iso = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
          const title = formatDay(day.year, day.month, day.day, titleFormat);
          const to = `${root}journals/${place(`${root}journals`, iso)}.md`;
          pages.push({ from: path, to, title, aliases: [title, iso, ...aliases], blocks: pageBlocks, before: takeProperties(before).lines });
          continue;
        }
      }
      const name = property("title")?.trim() || pageName(stem(basename(local)));
      const segments = name.split("/").map(safeName).filter(Boolean);
      if (!segments.length) segments.push(safeName(stem(basename(local))) || "page");
      const inPages = local.startsWith("pages/");
      const dir = inPages ? root.replace(/\/$/, "") : dirname(path);
      const folder = [dir, ...segments.slice(0, -1)].filter(Boolean).join("/");
      const to = `${folder ? `${folder}/` : ""}${place(folder, segments[segments.length - 1])}.md`;
      pages.push({
        from: path,
        to,
        title: segments[segments.length - 1],
        aliases: [name, ...aliases],
        blocks: pageBlocks,
        before: takeProperties(before).lines,
      });
    }

    // Names links may use, and the blocks references point at.
    const names = new Set<string>();
    // Not a namespaced page's last part alone: `[[B]]` is another page than `[[A/B]]` in Logseq.
    for (const page of pages) for (const name of page.aliases) names.add(name.trim().toLowerCase());
    const blocks = new Map<string, string>();
    for (const page of pages) {
      for (const block of page.blocks) {
        const id = blockId(block);
        if (id && !blocks.has(id)) blocks.set(id, referenceText(block));
      }
    }
    const context: GraphContext = {
      knows: (name) => names.has(name.trim().toLowerCase()),
      // A reference inside the referenced text is left out rather than followed.
      blockText: (uuid) => {
        const text = blocks.get(uuid.toLowerCase());
        return text === undefined ? null : inlineMarkdown(text, { knows: context.knows, blockText: () => "" });
      },
    };

    for (const page of pages) {
      const before = page.before.filter((l) => l.trim()).map((l) => inlineMarkdown(l, context));
      let body = [before.join("\n"), outlineMarkdown(page.blocks, context)].filter(Boolean).join("\n\n");
      // Pictures and files by relative path: from where the page is now.
      body = rewriteLinks(body, page.from, ({ path }) => (files.has(path) ? hrefFrom(page.to, path) : null));
      // The title too: links find pages by file name or alias, and a journal day's file is its ISO date.
      const aliases = [...new Set([page.title, ...page.aliases].map((a) => a.trim()).filter(Boolean))];
      const front = [
        "---",
        `title: "${page.title}"`,
        ...(aliases.length ? ["aliases:", ...aliases.map((a) => `  - "${a}"`)] : []),
        "---",
        "",
      ].join("\n");
      out.delete(page.from);
      out.set(page.to, new TextEncoder().encode(`${front}\n${body}\n`));
    }
  }
  return { files: out, graphs: roots.length };
}
