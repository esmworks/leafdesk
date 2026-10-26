/**
 * Notion's "Markdown & CSV" export, on top of the layout lib/import/markdown already reads (names
 * with ids, a folder of subpages next to each page, `Tasks.csv` + `Tasks_all.csv` + a folder of row
 * pages for each database). Pure: the server import (server/import/markdown.ts) uses these to
 *
 *   - turn what Notion writes as HTML into the Markdown forms the editor reads: callouts
 *     (`<aside>💡 …</aside>`) become `> [!NOTE]` callouts, and inline equations written
 *     $`…`$ become $…$. Toggles (`<details><summary>`), to-dos, tables and $$ equations are
 *     read as they are;
 *   - take the property list off the top of a row's page ("Status: Done", one line per property,
 *     under the title), keeping its values for relations;
 *   - find relations: Notion writes a relation cell as `Title (../Other%20DB%20<id>/Title%20<id>.md)`
 *     (or with a notion.so link, or `[Title](…)` in the row page's list), several separated by
 *     commas. A column whose links lead to rows of a database in the same upload becomes a relation
 *     to it; links elsewhere leave the column as text, without the links;
 *   - point notion.so links to pages of the upload at the imported pages.
 */

import { leadingEmoji } from "../content-blocks";
import { splitList } from "./csv";
import { resolveLink, withoutQuery } from "./markdown";

/**
 * The Notion id a file or folder name ends with ("Tasks 1a2b….csv", "Tasks 1a2b…_all.csv",
 * "Tasks 1a2b…/"), lowercase; null for a name without one.
 */
export function notionId(path: string): string | null {
  // The slashes it ends with counted off by hand: `/\/+$/` would start over at each slash of a long run.
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  const name = path.slice(0, end).split("/").pop() ?? "";
  const stem = name.replace(/\.(?:md|markdown|csv)$/i, "").replace(/_all$/i, "");
  return /\s([0-9a-f]{32})$/i.exec(stem)?.[1].toLowerCase() ?? null;
}

/** Whether any of the paths is named the way Notion's export names files. */
export function isNotionExport(paths: Iterable<string>): boolean {
  for (const path of paths) if (path.split("/").some((part) => notionId(part))) return true;
  return false;
}

/**
 * The id of the page a notion.so (or notion.site) link opens: the 32 hex digits its last path
 * segment ends with ("Page-Title-1a2b…", or a UUID with dashes), or its `p` parameter (a page
 * opened as a peek). Null for other links.
 */
export function notionUrlId(href: string): string | null {
  const url = URL.parse(href.trim());
  if (!url || !/(?:^|\.)notion\.(?:so|site)$/i.test(url.hostname)) return null;
  const peek = url.searchParams.get("p")?.replace(/-/g, "");
  if (peek && /^[0-9a-f]{32}$/i.test(peek)) return peek.toLowerCase();
  const last = url.pathname.split("/").filter(Boolean).pop()?.replace(/-/g, "") ?? "";
  const match = /([0-9a-f]{32})$/i.exec(last);
  return match ? match[1].toLowerCase() : null;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Inline equations as Notion writes them, $`…`$, as $…$ (see lib/content-markdown). */
function inlineEquations(line: string): string {
  if (!line.includes("$`")) return line;
  return line.replace(/\$`([^`\n]+)`\$/g, (whole, latex: string) => (latex.trim() ? `$${latex.trim()}$` : whole));
}

/**
 * A callout's lines (between `<aside>` and `</aside>`) as a `> [!NOTE]` callout: Notion's
 * default callout is gray, which is what NOTE stands for. An icon on a line of its own (as newer
 * exports write it) joins the text after it.
 */
function callout(inner: string[]): string[] {
  const lines = inner.map((l) => l.trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length && leadingEmoji(lines[0].trim()) === lines[0].trim()) {
    const icon = lines.shift()!.trim();
    while (lines.length && !lines[0].trim()) lines.shift();
    lines.unshift(lines.length ? `${icon} ${lines.shift()!.trim()}` : icon);
  }
  return ["> [!NOTE]", ...lines.map((l) => (l.trim() ? `> ${inlineEquations(l.trim())}` : ">"))];
}

/**
 * Notion's Markdown with its HTML callouts and inline equations in the forms the editor reads
 * (see the top of this file). Code blocks are left as they are, and so is an `<aside>` that
 * never closes.
 */
export function notionMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  // Once an `<aside>` has been looked for its end to the last line in vain, none after it has one:
  // they aren't looked for again, which would take time growing with the square of the lines.
  let unclosed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      out.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      out.push(line);
      continue;
    }
    const aside = unclosed ? null : /^\s*<aside>(.*)$/i.exec(line);
    if (aside) {
      const inner: string[] = [];
      let rest = aside[1];
      let end = i;
      let after: string | null = null;
      for (;;) {
        const close = rest.search(/<\/aside>/i);
        if (close !== -1) {
          inner.push(rest.slice(0, close));
          after = rest.slice(close + "</aside>".length);
          break;
        }
        inner.push(rest);
        if (++end >= lines.length) break;
        rest = lines[end];
      }
      if (after !== null) {
        i = end;
        out.push(...callout(inner), "");
        if (after.trim()) out.push(inlineEquations(after.trim()));
        continue;
      }
      unclosed = true;
    }
    out.push(inlineEquations(line));
  }
  return out.join("\n");
}

/**
 * The property list Notion writes at the top of a database row's page (under the title, one
 * `Name: value` line per filled property, then a blank line): the body without it, and the values
 * by column name. Only lines naming a column of the database (`headers`, the title's left out)
 * count, and only a list that ends in a blank line (or the end); any other body comes back as it is.
 */
export function splitRowProperties(
  body: string,
  headers: string[],
  titleColumn: number | null,
): { body: string; values: Map<string, string> } {
  const values = new Map<string, string>();
  // Longest names first, so "Due date" isn't read as "Due" with the value "date: …".
  const names = headers.filter((_, i) => i !== titleColumn).sort((a, b) => b.length - a.length);
  if (!names.length) return { body, values };
  const lines = body.split("\n");
  let n = 0;
  for (; n < lines.length && lines[n].trim(); n++) {
    const line = lines[n];
    const name = names.find((h) => line.toLowerCase().startsWith(`${h.toLowerCase()}:`));
    if (!name || values.has(name)) return { body, values: new Map() };
    values.set(name, line.slice(name.length + 1).trim());
  }
  if (!values.size) return { body, values };
  return { body: lines.slice(n).join("\n").replace(/^\s*\n/, ""), values };
}

/** One entry of a relation cell: the row's title, and where its link points (when it has one). */
export type RelationRef = {
  title: string;
  /** The row page's path in the upload (a relative `.md` link resolved). */
  path: string | null;
  /** The row page's Notion id (from a notion.so link, or the linked file's name). */
  id: string | null;
};

/** `Title (target)` entries: a target in parentheses right before a comma or the end. */
const TARGET = /\s\(((?:[^\s()]|\([^\s()]*\))+)\)(?=\s*,|\s*$)/g;
/** `[Title](target)` links, as a row page's property list writes relations: the title… */
const MD_LABEL = /\[((?:\\.|[^\]\\\n])*)/y;
/** …and the target after it. */
const MD_TARGET = /\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?\s*\)/y;

/**
 * The `[Title](target)` links of `text`, as a global regex of the two would find them, in time
 * growing with the text's length: one regex would read the rest of a line again from each `[`
 * of a long run of them. A title that isn't followed by a target doesn't start a link, and
 * neither does a `[` inside it (that title ends at the same `]`), so the search goes on after it.
 */
function* markdownLinks(text: string): Generator<{ index: number; length: number; title: string; target: string }> {
  for (let open = text.indexOf("["); open !== -1; ) {
    MD_LABEL.lastIndex = open;
    const label = MD_LABEL.exec(text)!;
    MD_TARGET.lastIndex = MD_LABEL.lastIndex;
    const target = MD_TARGET.exec(text);
    const next = target ? MD_TARGET.lastIndex : MD_LABEL.lastIndex;
    if (target) yield { index: open, length: next - open, title: label[1], target: target[1] };
    open = text.indexOf("[", next);
  }
}

/** Where a relation's link points; null for a link that isn't to a page (an image, a web page). */
function refTarget(target: string, from: string): Pick<RelationRef, "path" | "id"> | null {
  const id = notionUrlId(target);
  if (id) return { path: null, id };
  if (!/\.md$/i.test(withoutQuery(target))) return null;
  const path = resolveLink(from, target);
  return path ? { path, id: notionId(path) } : null;
}

/**
 * A relation cell's entries, their links resolved relative to `from` (the CSV file or the row
 * page the cell is in). Empty when the cell has no link to a page: a plain list of titles, or not
 * a relation at all. Titles after the last link are entries without one.
 */
export function relationRefs(cell: string, from: string): RelationRef[] {
  const refs: RelationRef[] = [];
  let last = 0;
  const rest = (text: string) => {
    for (const title of splitList(text)) refs.push({ title, path: null, id: null });
  };
  if (cell.includes("](")) {
    for (const link of markdownLinks(cell)) {
      const target = refTarget(link.target, from);
      if (!target) continue;
      rest(cell.slice(last, link.index));
      refs.push({ title: link.title.replace(/\\(.)/g, "$1").trim(), ...target });
      last = link.index + link.length;
    }
  } else {
    let start = 0;
    for (const match of cell.matchAll(TARGET)) {
      const target = refTarget(match[1], from);
      // "Title (note)" in a title isn't a link: it stays part of the title.
      if (!target) continue;
      refs.push({ title: cell.slice(start, match.index).replace(/^\s*,\s*/, "").trim(), ...target });
      start = last = match.index + match[0].length;
    }
  }
  if (!refs.length) return [];
  rest(cell.slice(last));
  return refs;
}

/** A relation cell as the titles it lists, for a column that stays text: "A (…), B (…)" is "A, B". */
export function relationTitles(cell: string, from: string): string {
  const refs = relationRefs(cell, from);
  return refs.length ? refs.map((r) => r.title).join(", ") : cell;
}

export type NotionDatabase = {
  /** The database's key in the import plan. */
  key: string;
  /** Its CSV file. */
  source: string;
  headers: string[];
  rows: string[][];
  titleColumn: number | null;
  /** Its row pages' property lists: the page's path, and its values by column name. */
  rowPages: { source: string; values: Map<string, string> }[];
};

export type RelationColumn = { column: number; header: string; target: string };

/**
 * Which columns of the databases are relations, and to which database (its key): those with links
 * (in the CSV or in the row pages' lists) that `targetOf` says lead to rows of an imported database,
 * the one most of them lead to. `targetOf` gives, for a link, the key of the database whose row it
 * points at, or null. Columns whose links all lead elsewhere come back in `plain`, to be imported
 * as text without the links.
 */
export function planRelations(
  databases: NotionDatabase[],
  targetOf: (ref: RelationRef) => string | null,
): { relations: Map<string, RelationColumn[]>; plain: Map<string, number[]> } {
  const relations = new Map<string, RelationColumn[]>();
  const plain = new Map<string, number[]>();
  for (const database of databases) {
    database.headers.forEach((header, column) => {
      if (column === database.titleColumn) return;
      const refs = [
        ...database.rows.flatMap((row) => relationRefs(row[column] ?? "", database.source)),
        ...database.rowPages.flatMap((p) => relationRefs(p.values.get(header) ?? "", p.source)),
      ].filter((r) => r.path || r.id);
      if (!refs.length) return;
      const votes = new Map<string, number>();
      for (const ref of refs) {
        const target = targetOf(ref);
        if (target) votes.set(target, (votes.get(target) ?? 0) + 1);
      }
      const target = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (target) relations.set(database.key, [...(relations.get(database.key) ?? []), { column, header, target }]);
      else plain.set(database.key, [...(plain.get(database.key) ?? []), column]);
    });
  }
  return { relations, plain };
}

/** Markdown link destinations (not in code) that are notion.so links. */
const NOTION_LINK = /(\]\(\s*<?)(https?:\/\/(?:[a-z0-9-]+\.)*notion\.(?:so|site)\/[^\s)>]*)/gi;

/**
 * `markdown` with links to notion.so pages that `lookup` knows (by id) pointed where it says;
 * others, and links in code, stay as they are.
 */
export function rewriteNotionUrls(markdown: string, lookup: (id: string) => string | null): string {
  if (!/notion\.(?:so|site)/i.test(markdown)) return markdown;
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => {
          if (i % 2) return part;
          return part.replace(NOTION_LINK, (whole, head: string, href: string) => {
            const id = notionUrlId(href);
            const target = id ? lookup(id) : null;
            return target ? `${head}${target}` : whole;
          });
        })
        .join("");
    })
    .join("\n");
}

/** Whether a line is nothing but one Markdown link (Notion writes a subpage so, where it sits). */
export function soleLink(line: string): string | null {
  const match = /^\s*\[((?:\\.|[^\]\\\n])*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?\s*\)\s*$/.exec(line);
  return match ? match[2] : null;
}
