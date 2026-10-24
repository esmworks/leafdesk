/**
 * The card that shows when the pointer rests on a mention of a page or a link to one
 * (components/page/page-preview-card.tsx): what it holds, and the pure helpers the server
 * (server/page-preview.ts) builds it with.
 */

import type { PageKind } from "@/db/schema";

/** A page as its preview card shows it. Only ever made for someone who may open the page. */
export type PagePreview = {
  id: string;
  workspaceId: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  /** The pages above it that the viewer can see, from the top. */
  path: { id: string; title: string; icon: string | null; kind: PageKind }[];
  /** Who last changed it (null when unknown, or they were deleted) and when (ISO). */
  editedBy: string | null;
  editedAt: string;
  /** The start of its text (empty for databases and pages without text). */
  excerpt: string;
  /** A database row's first values, as text, by property name (property access applied). */
  properties: { name: string; value: string }[];
};

/** Characters of a page's text the card shows, at most. */
export const PREVIEW_EXCERPT = 280;
/** Values of a row the card shows, at most. */
export const PREVIEW_PROPERTIES = 4;
/** Characters of one value, at most. */
const PREVIEW_VALUE = 80;

/**
 * The first lines of a page's text for its card: whitespace in each line collapsed, empty lines
 * left out, cut at a word near `max` characters with an ellipsis.
 */
export function previewExcerpt(text: string, max = PREVIEW_EXCERPT): string {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const joined = lines.join("\n");
  if (joined.length <= max) return joined;
  const cut = joined.slice(0, max);
  const space = cut.search(/\s\S*$/);
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A row value as MCP and exports read it (server/mcp/query displayProperties: option names, related
 * rows' titles, people's names) as one line of text, or "" for nothing to show. Booleans show only
 * when ticked.
 */
export function previewValueText(value: unknown): string {
  const text = (v: unknown): string => {
    if (v === null || v === undefined || v === false) return "";
    if (v === true) return "✓";
    if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    if (Array.isArray(v)) return v.map(text).filter(Boolean).join(", ");
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      // A checklist item, a related row, a person, a file, a place, a range of dates.
      if (typeof o.checked === "boolean" && typeof o.text === "string") return `${o.checked ? "☑" : "☐"} ${o.text}`;
      for (const key of ["title", "name", "address", "text"]) if (typeof o[key] === "string" && o[key]) return text(o[key]);
      if (typeof o.start === "string") return [o.start, o.end].filter((d) => typeof d === "string" && d).join(" → ");
      return "";
    }
    return "";
  };
  const line = text(value);
  return line.length > PREVIEW_VALUE ? `${line.slice(0, PREVIEW_VALUE - 1).trimEnd()}…` : line;
}
