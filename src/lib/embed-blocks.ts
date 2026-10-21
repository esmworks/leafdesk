import * as Y from "yjs";
import type { ViewConfig, ViewType } from "@/db/schema/app";
import { COLLAB_FRAGMENT } from "./collab-constants";
import { filterConfigError } from "./filters";
import { isViewType, layoutConfigError, LINKED_VIEW_TYPES } from "./views";

/**
 * Database blocks inside page bodies: an inline database (a database page living under the page
 * and shown in its body) and a linked view (any database the reader can see, with a view of its
 * own). Both only point at the database by id; rows, titles and counts are loaded separately and
 * with the reader's access to the database, never through the host page.
 *
 * The configs here are shared by the editor (React specs, components/page/embed-blocks.tsx) and the
 * server (plain specs, server/blocknote.ts), so both build the same Yjs structure. Everything else
 * in this file is pure: the Markdown form of the blocks and id rewrites for duplicates.
 */

export const DATABASE_BLOCK = "database";
export const LINKED_VIEW_BLOCK = "linkedView";
export type EmbedBlockType = typeof DATABASE_BLOCK | typeof LINKED_VIEW_BLOCK;

export const databaseBlockConfig = {
  type: DATABASE_BLOCK,
  propSchema: { databaseId: { default: "" } },
  content: "none",
} as const;

export const linkedViewBlockConfig = {
  type: LINKED_VIEW_BLOCK,
  // `view` is the linked view's own layout and filters as JSON (see parseLinkedView): block props
  // are flat strings, and keeping it in the block makes it sync and undo with the page.
  propSchema: { databaseId: { default: "" }, view: { default: "" } },
  content: "none",
} as const;

export const isEmbedBlockType = (type: unknown): type is EmbedBlockType =>
  type === DATABASE_BLOCK || type === LINKED_VIEW_BLOCK;

// ---------------------------------------------------------------------------------------------
// Linked view settings

export type LinkedView = { type: ViewType; config: ViewConfig };

export const DEFAULT_LINKED_VIEW: LinkedView = { type: "table", config: {} };

/**
 * Layouts a linked view can take: every one but the form and the dashboard (lib/views
 * LINKED_VIEW_TYPES). A form adds rows through a view the database owns (its questions, defaults
 * and public link live on that view, and answers are checked against it), so a page can't carry
 * one of its own; a dashboard is made of linked views itself, and a page has dashboard blocks. An
 * inline database still shows the database's own form and dashboard views.
 */
export { LINKED_VIEW_TYPES };

/**
 * The linked view stored in a block. Anyone who may edit the host page can write the prop, so it
 * is checked like a view config sent to the server; anything malformed reads as a plain table.
 */
export function parseLinkedView(value: unknown): LinkedView {
  if (typeof value !== "string" || !value) return DEFAULT_LINKED_VIEW;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return DEFAULT_LINKED_VIEW;
  }
  return checkLinkedView(parsed);
}

/** A linked view already parsed from JSON (a dashboard widget's), checked like parseLinkedView's. */
export function checkLinkedView(parsed: unknown): LinkedView {
  if (!parsed || typeof parsed !== "object") return DEFAULT_LINKED_VIEW;
  const { type, config } = parsed as { type?: unknown; config?: unknown };
  if (!isViewType(type) || !(LINKED_VIEW_TYPES as readonly ViewType[]).includes(type)) return DEFAULT_LINKED_VIEW;
  if (!config || typeof config !== "object" || Array.isArray(config)) return { type, config: {} };
  // Only dashboard views hold widgets.
  const { widgets: _, ...c } = config as ViewConfig;
  if (filterConfigError(c) || layoutConfigError(c)) return { type, config: {} };
  return { type, config: c };
}

export const serializeLinkedView = (view: LinkedView) => JSON.stringify({ type: view.type, config: view.config });

// ---------------------------------------------------------------------------------------------
// Markdown

/**
 * In Markdown (stored for search and history, read and written by MCP, exported) a database block
 * is one line holding only the kind and the database id: an HTML comment, so renderers show
 * nothing and the database's title, which the page's readers may not be allowed to see, is never
 * part of the page body.
 *
 *   <!-- leafdesk:database 3f0c… -->
 *   <!-- leafdesk:linked-view 3f0c… -->
 */
const MARKDOWN_KIND: Record<EmbedBlockType, string> = { database: "database", linkedView: "linked-view" };
const REFERENCE_LINE = /^ {0,3}<!--\s*leafdesk:(database|linked-view)\s+([\w-]{1,128})\s*-->\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function referenceLine(type: EmbedBlockType, databaseId: string) {
  return `<!-- leafdesk:${MARKDOWN_KIND[type]} ${databaseId} -->`;
}

export type EmbedReference = { type: EmbedBlockType; databaseId: string };

export function parseReferenceLine(line: string): EmbedReference | null {
  const match = REFERENCE_LINE.exec(line);
  if (!match) return null;
  return { type: match[1] === "database" ? DATABASE_BLOCK : LINKED_VIEW_BLOCK, databaseId: match[2] };
}

export type MarkdownPart = { markdown: string } | { reference: EmbedReference };

const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** Each line with the reference it holds, or null inside fenced code and for other lines. */
function scanLines(markdown: string): { line: string; reference: EmbedReference | null }[] {
  let fence: string | null = null;
  return markdown.split(/\r?\n/).map((line) => {
    if (fence) {
      const closing = FENCE_CLOSE.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = null;
      return { line, reference: null };
    }
    const opening = FENCE.exec(line);
    if (opening) {
      fence = opening[1];
      return { line, reference: null };
    }
    return { line, reference: parseReferenceLine(line) };
  });
}

/**
 * Splits Markdown at reference lines (outside fenced code), so the text between them is parsed as
 * usual and each reference becomes its block. Only a line of its own counts, not one inside text.
 */
export function splitMarkdownReferences(markdown: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("\n");
    if (text.trim()) parts.push({ markdown: text });
    buffer = [];
  };
  for (const { line, reference } of scanLines(markdown)) {
    if (reference) {
      flush();
      parts.push({ reference });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return parts;
}

/** Every reference line of a Markdown body, in order (outside fenced code). */
export function markdownReferences(markdown: string): EmbedReference[] {
  return scanLines(markdown).flatMap(({ reference }) => (reference ? [reference] : []));
}

/** Rewrites each reference line (outside fenced code) with `replace`. */
export function mapReferenceLines(markdown: string, replace: (reference: EmbedReference) => string): string {
  return scanLines(markdown)
    .map(({ line, reference }) => (reference ? replace(reference) : line))
    .join("\n");
}

// ---------------------------------------------------------------------------------------------
// Block trees

/** The part of a BlockNote block these helpers read; the server passes full blocks through. */
type AnyBlock = { type: string; props?: Record<string, unknown>; children?: AnyBlock[] };

/** Database blocks of a block tree, in document order (nested ones included). */
export function blockReferences(blocks: AnyBlock[]): EmbedReference[] {
  const out: EmbedReference[] = [];
  const walk = (list: AnyBlock[]) => {
    for (const block of list) {
      if (isEmbedBlockType(block.type) && typeof block.props?.databaseId === "string" && block.props.databaseId) {
        out.push({ type: block.type, databaseId: block.props.databaseId });
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

/**
 * Replaces each database block with `replace(block)`, depth first, keeping the rest of the tree.
 * Used to give serializers that don't know the blocks something they can write.
 */
export function replaceEmbedBlocks<B extends AnyBlock>(blocks: B[], replace: (block: B) => B): B[] {
  return blocks.map((block) => {
    const next = isEmbedBlockType(block.type) ? replace(block) : block;
    return next.children?.length ? { ...next, children: replaceEmbedBlocks(next.children as B[], replace) } : next;
  });
}

/**
 * Blocks for Markdown that references database blocks, given the page's current blocks: a linked
 * view named again keeps its own settings, and inline databases the Markdown leaves out stay at the
 * end of the page. An inline database is a real database living under the page, and a rewrite
 * (usually an AI app replacing the body) must not make it disappear from the page by accident.
 */
export function mergeReferencedBlocks<B extends AnyBlock>(
  parts: ({ blocks: B[] } | { reference: EmbedReference })[],
  existing: B[],
  { keepMissingInline }: { keepMissingInline: boolean },
): B[] {
  const current = collectEmbedBlocks(existing);
  const used = new Set<B>();
  const out: B[] = [];
  for (const part of parts) {
    if ("blocks" in part) {
      out.push(...part.blocks);
      continue;
    }
    const { type, databaseId } = part.reference;
    const match = current.find((b) => !used.has(b) && b.type === type && b.props?.databaseId === databaseId);
    if (match) used.add(match);
    const props = type === LINKED_VIEW_BLOCK ? { databaseId, view: String(match?.props?.view ?? "") } : { databaseId };
    out.push({ type, props, children: [] } as unknown as B);
  }
  if (keepMissingInline) {
    const listed = new Set(blockReferences(out).map((r) => `${r.type}:${r.databaseId}`));
    for (const block of current) {
      const key = `${block.type}:${String(block.props?.databaseId)}`;
      if (block.type !== DATABASE_BLOCK || listed.has(key)) continue;
      listed.add(key);
      out.push({ type: DATABASE_BLOCK, props: { databaseId: block.props?.databaseId }, children: [] } as unknown as B);
    }
  }
  return out;
}

function collectEmbedBlocks<B extends AnyBlock>(blocks: B[]): B[] {
  const out: B[] = [];
  const walk = (list: B[]) => {
    for (const block of list) {
      if (isEmbedBlockType(block.type)) out.push(block);
      if (block.children?.length) walk(block.children as B[]);
    }
  };
  walk(blocks);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Yjs documents

/**
 * Points the inline database blocks of a page document at other databases (`map`: old id → new
 * id), in place. Duplicating a page copies its inline databases too, and the copied page must show
 * its copies. Linked views keep their source: they show a database that lives elsewhere.
 * Returns how many blocks changed.
 */
export function remapInlineDatabases(doc: Y.Doc, map: ReadonlyMap<string, string>): number {
  let changed = 0;
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === DATABASE_BLOCK) {
        const next = map.get(String(child.getAttribute("databaseId") ?? ""));
        if (next) {
          child.setAttribute("databaseId", next);
          changed++;
        }
      }
      walk(child);
    }
  };
  doc.transact(() => walk(doc.getXmlFragment(COLLAB_FRAGMENT)));
  return changed;
}
