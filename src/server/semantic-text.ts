/**
 * The pure parts of semantic search (#43): what text of a page is embedded, in which chunks, and
 * how full-text and semantic rankings are merged. No database or network here, so it's unit-tested
 * (semantic-text.test.ts); server/semantic-index.ts and server/semantic-search.ts use it.
 */
import { createHash } from "node:crypto";
import { blocksToPlainText, type BlockLike } from "@/lib/blocks";
import { displayValue } from "@/lib/properties";
import { formatValue } from "@/server/ai/prompts";

/** Characters a chunk aims for, and the most it may have (a longer block is split). */
export const CHUNK_TARGET = 900;
export const CHUNK_MAX = 1_400;
/** Chunks one page may have; text beyond them isn't searched by meaning (full-text still finds it). */
export const MAX_CHUNKS_PER_PAGE = 200;

/**
 * Which version of the chunking the index was built with. Raise it whenever the chunks a page
 * makes change for the same page (what text goes in, how it's cut, the limits above): pages
 * indexed with another version count as stale, so the sweep and `pnpm search:index` go over them
 * again. Chunks whose text stays the same aren't embedded again.
 */
export const CHUNKER_VERSION = 1;

/**
 * Row values that go into a row's text. Relations and people are left out: their names are other
 * pages' titles and people's names, which the row's readers may not be allowed to see. Formulas and
 * rollups can reach through relations too.
 */
const INDEXED_TYPES = new Set(["text", "number", "select", "multi_select", "status", "date", "url", "email", "phone", "checklist"]);

export type IndexedProperty = Parameters<typeof displayValue>[0];

/**
 * A database row's values as "Name: value" lines, in property order. Properties in `restricted`
 * (any with access rules, see server/property-access) are left out, name and value: the index is
 * shared by every reader, so a value some of them may not see must never be found or shown.
 */
export function rowPropertyLines(
  properties: IndexedProperty[],
  values: Record<string, unknown>,
  restricted: ReadonlySet<string> = new Set(),
): string[] {
  const lines: string[] = [];
  for (const prop of properties) {
    if (!INDEXED_TYPES.has(prop.type) || restricted.has(prop.id)) continue;
    const shown = formatValue(displayValue(prop, values[prop.id])).trim();
    if (shown) lines.push(`${prop.name.trim() || "?"}: ${shown.replace(/\s+/g, " ")}`);
  }
  return lines;
}

type BlockWithId = BlockLike & { id?: string; children?: BlockWithId[] };

/** Each block's own text (children separately), with its id, in document order. */
export function blockTexts(blocks: BlockWithId[]): { id: string | null; text: string }[] {
  const out: { id: string | null; text: string }[] = [];
  const walk = (list: BlockWithId[]) => {
    for (const block of list) {
      const text = blocksToPlainText([{ ...block, children: [] }]).trim();
      if (text) out.push({ id: block.id ?? null, text });
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

export type ChunkSource = {
  title: string;
  /** Row values (see rowPropertyLines); they open the first chunk. */
  properties?: string[];
  blocks: { id: string | null; text: string }[];
};

export type ChunkDraft = {
  position: number;
  /** The block the chunk starts at; null for the title and the row's values. */
  blockId: string | null;
  /** What is embedded: the page title, then the passage. */
  text: string;
  hash: string;
};

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Cuts text longer than `max` at sentence ends or spaces, near `max`. */
export function splitLong(text: string, max = CHUNK_MAX): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const floor = Math.floor(max / 2);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"), window.lastIndexOf("? "), window.lastIndexOf("! "));
    if (cut >= floor) cut += 1;
    else {
      cut = window.lastIndexOf(" ");
      if (cut < floor) cut = max;
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * A page's text in chunks of about CHUNK_TARGET characters, each starting with the page's title (so
 * a passage carries what it is about) and made of whole blocks where they fit. A page with nothing
 * but a title is one chunk. Chunks with the same text appear once.
 */
export function chunkPage(source: ChunkSource, { target = CHUNK_TARGET, max = CHUNK_MAX } = {}): ChunkDraft[] {
  const title = source.title.trim().replace(/\s+/g, " ");
  const prefix = title ? `${title}\n` : "";
  const pieces: { blockId: string | null; text: string }[] = [];
  if (source.properties?.length) {
    for (const part of splitLong(source.properties.join("\n"), max)) pieces.push({ blockId: null, text: part });
  }
  for (const block of source.blocks) {
    for (const part of splitLong(block.text, max)) pieces.push({ blockId: block.id, text: part });
  }

  const bodies: { blockId: string | null; text: string }[] = [];
  let current: { blockId: string | null; parts: string[]; size: number } | null = null;
  for (const piece of pieces) {
    if (current && current.size + piece.text.length + 1 <= target) {
      current.parts.push(piece.text);
      current.size += piece.text.length + 1;
      continue;
    }
    if (current) bodies.push({ blockId: current.blockId, text: current.parts.join("\n") });
    current = { blockId: piece.blockId, parts: [piece.text], size: piece.text.length };
  }
  if (current) bodies.push({ blockId: current.blockId, text: current.parts.join("\n") });
  if (!bodies.length && title) bodies.push({ blockId: null, text: "" });

  const seen = new Set<string>();
  const chunks: ChunkDraft[] = [];
  for (const body of bodies) {
    const text = `${prefix}${body.text}`.trim();
    if (!text) continue;
    const hash = sha256(text);
    if (seen.has(hash)) continue;
    seen.add(hash);
    chunks.push({ position: chunks.length, blockId: body.blockId, text, hash });
    if (chunks.length >= MAX_CHUNKS_PER_PAGE) break;
  }
  return chunks;
}

/** Fingerprint of what a page's index was built from: its chunks and the model. */
export function sourceHash(model: string, chunks: Pick<ChunkDraft, "hash" | "blockId">[]): string {
  return sha256(JSON.stringify([model, chunks.map((c) => [c.hash, c.blockId])]));
}

/** A chunk's passage without the title line it was embedded with, for snippets. */
export function passageOf(chunkText: string, title: string): string {
  const t = title.trim().replace(/\s+/g, " ");
  // A page with only a title has nothing else to show.
  if (t && chunkText.trim() === t) return "";
  const body = t && chunkText.startsWith(`${t}\n`) ? chunkText.slice(t.length + 1) : chunkText;
  return body.trim();
}

/** The start of a passage as one line of at most `max` characters. */
export function snippetOf(passage: string, max = 160): string {
  const flat = passage.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Reciprocal rank fusion: merges rankings of ids into one, each id scoring the sum of
 * 1 / (k + rank) over the rankings it appears in. Ties keep the order of the earlier rankings.
 */
export function reciprocalRankFusion(rankings: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, { score: number; order: number }>();
  let order = 0;
  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      const entry = scores.get(id) ?? { score: 0, order: order++ };
      entry.score += 1 / (k + i + 1);
      scores.set(id, entry);
    });
  }
  return [...scores.entries()]
    .sort(([, a], [, b]) => b.score - a.score || a.order - b.order)
    .map(([id, { score }]) => ({ id, score }));
}

/** Cosine similarity, as `embedding_cosine` computes it in SQL (for tests and fakes). */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** A vector as a PostgreSQL `real[]` literal; only finite numbers get through. */
export function vectorLiteral(vector: number[]): string {
  if (!vector.length || !vector.every((n) => Number.isFinite(n))) throw new Error("Not a vector");
  return `{${vector.join(",")}}`;
}
