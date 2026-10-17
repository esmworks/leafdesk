/**
 * The pure parts of semantic search (#43): what text of a page is embedded, in which chunks, and
 * how full-text and semantic rankings are merged. No database or network here, so it's unit-tested
 * (semantic-text.test.ts); server/semantic-index.ts and server/semantic-search.ts use it.
 */
import { createHash } from "node:crypto";
import { blocksToPlainText, type BlockLike } from "@/lib/blocks";
import { displayValue } from "@/lib/properties";
import { isCjkTerm } from "@/lib/search-words";
import { formatValue } from "@/server/ai/prompts";

/** Characters a chunk aims for, and the most it may have (a longer block is split). */
export const CHUNK_TARGET = 900;
export const CHUNK_MAX = 1_400;
/** Chunks one page may have; text beyond them isn't searched by meaning (full-text still finds it). */
export const MAX_CHUNKS_PER_PAGE = 200;
/** Chunks the text of a page's attached documents may add on top (see server/file-text.ts). */
export const MAX_FILE_CHUNKS_PER_PAGE = 300;

/**
 * Which version of the chunking the index was built with. Raise it whenever the chunks a page
 * makes change for the same page (what text goes in, how it's cut, the limits above): pages
 * indexed with another version count as stale, so the sweep and `pnpm search:index` go over them
 * again. Chunks whose text stays the same aren't embedded again.
 */
export const CHUNKER_VERSION = 2;

/** The most characters of where a chunk is (its page's place and section) that go in front of it. */
export const CONTEXT_MAX = 200;
/** The most characters of one page title or heading in that context. */
const CONTEXT_PART_MAX = 80;
const PATH_SEPARATOR = " › ";

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

export type BlockText = { id: string | null; text: string; heading?: true };

/** Each block's own text (children separately), with its id, in document order; headings marked. */
export function blockTexts(blocks: BlockWithId[]): BlockText[] {
  const out: BlockText[] = [];
  const walk = (list: BlockWithId[]) => {
    for (const block of list) {
      const text = blocksToPlainText([{ ...block, children: [] }]).trim();
      if (text) out.push(block.type === "heading" ? { id: block.id ?? null, text, heading: true } : { id: block.id ?? null, text });
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

export type ChunkSource = {
  title: string;
  /** Titles of the pages above, top first (a row's database last). */
  path?: string[];
  /** Row values (see rowPropertyLines); they open the first chunk. */
  properties?: string[];
  blocks: BlockText[];
  /** The text of documents attached to the page (PDFs, Word), each with the block that shows it. */
  files?: FileSource[];
};

export type FileSource = { blockId: string; name: string; text: string };

export type ChunkDraft = {
  position: number;
  /** The block the chunk starts at; null for the title and the row's values. */
  blockId: string | null;
  /**
   * What is embedded: where the passage is (see chunkContext), a blank line, then the passage.
   * The passage itself never has a blank line, so passageOf can find where it starts.
   */
  text: string;
  hash: string;
};

const oneLine = (text: string) => text.trim().replace(/\s+/g, " ");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * Where a chunk is, in at most CONTEXT_MAX characters: the titles of the pages above and the
 * page's own ("Sales › 2026 plan"), then the heading the chunk lies under, if any. Pages farthest
 * up are left out first ("… › 2026 plan"). Empty when there is nothing to say.
 */
export function chunkContext(path: string[], title: string, heading?: string | null): string {
  const head = heading ? clip(oneLine(heading), CONTEXT_PART_MAX) : "";
  const parts = [...path, title].map((t) => clip(oneLine(t), CONTEXT_PART_MAX)).filter(Boolean);
  const room = CONTEXT_MAX - (head ? head.length + 1 : 0);
  let line = parts.join(PATH_SEPARATOR);
  for (let drop = 1; line.length > room && drop < parts.length; drop++) line = ["…", ...parts.slice(drop)].join(PATH_SEPARATOR);
  return [clip(line, room), head].filter(Boolean).join("\n");
}

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

type Passage = { blockId: string | null; text: string };

/** Packs pieces into passages of about `target` characters; a passage starts at its first piece's block. */
function pack(pieces: Passage[], target: number): Passage[] {
  const bodies: Passage[] = [];
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
  return bodies;
}

/**
 * A page's text in chunks of about CHUNK_TARGET characters, made of whole blocks where they fit,
 * a heading starting a new one. Each starts with where it is (chunkContext: the pages above, the page's title, the heading it
 * lies under), so a passage carries what it is about. A page with nothing but a title is one
 * chunk. Chunks with the same text appear once.
 *
 * The text of each attached document follows in chunks of its own, whose passage starts with the
 * file name and which point at the block showing the file, so an answer quoting one links to the
 * document. They have their own allowance (MAX_FILE_CHUNKS_PER_PAGE): a long PDF doesn't push the
 * page's own text out of the index.
 */
export function chunkPage(source: ChunkSource, { target = CHUNK_TARGET, max = CHUNK_MAX } = {}): ChunkDraft[] {
  const path = source.path ?? [];
  // Blank lines inside a passage would end it early (see passageOf).
  const flat = (text: string) => text.replace(/\n\s*\n/g, "\n");
  type Piece = { blockId: string | null; text: string; heading: string | null; isHeading: boolean };
  const pieces: Piece[] = [];
  if (source.properties?.length) {
    for (const part of splitLong(flat(source.properties.join("\n")), max)) pieces.push({ blockId: null, text: part, heading: null, isHeading: false });
  }
  let heading: string | null = null;
  for (const block of source.blocks) {
    if (block.heading) heading = block.text;
    for (const part of splitLong(flat(block.text), max)) pieces.push({ blockId: block.id, text: part, heading, isHeading: !!block.heading });
  }

  const bodies: { blockId: string | null; heading: string | null; text: string }[] = [];
  let current: { blockId: string | null; heading: string | null; parts: string[]; size: number } | null = null;
  for (const piece of pieces) {
    // A heading opens a new chunk (one section per chunk), unless the one so far is very short.
    const fits = current && current.size + piece.text.length + 1 <= target && !(piece.isHeading && current.size >= target / 4);
    if (current && fits) {
      current.parts.push(piece.text);
      current.size += piece.text.length + 1;
      continue;
    }
    if (current) bodies.push({ blockId: current.blockId, heading: current.heading, text: current.parts.join("\n") });
    // A chunk starting at a heading has it in its text already.
    current = { blockId: piece.blockId, heading: piece.isHeading ? null : piece.heading, parts: [piece.text], size: piece.text.length };
  }
  if (current) bodies.push({ blockId: current.blockId, heading: current.heading, text: current.parts.join("\n") });
  if (!bodies.length && chunkContext(path, source.title)) bodies.push({ blockId: null, heading: null, text: "" });

  const seen = new Set<string>();
  const chunks: ChunkDraft[] = [];
  const add = (context: string, blockId: string | null, passage: string) => {
    const text = context ? `${context}\n\n${passage}` : passage;
    if (!text.trim()) return;
    const hash = sha256(text);
    if (seen.has(hash)) return;
    seen.add(hash);
    chunks.push({ position: chunks.length, blockId, text, hash });
  };
  for (const body of bodies) {
    add(chunkContext(path, source.title, body.heading), body.blockId, body.text.trim());
    if (chunks.length >= MAX_CHUNKS_PER_PAGE) break;
  }

  const allowance = chunks.length + MAX_FILE_CHUNKS_PER_PAGE;
  const context = chunkContext(path, source.title);
  for (const file of source.files ?? []) {
    const name = oneLine(file.name) || "file";
    // One line per paragraph: the passage has no blank line (see passageOf).
    const parts = file.text.split(/\n\s*\n/).flatMap((paragraph) => splitLong(paragraph.replace(/\s+/g, " "), max));
    for (const body of pack(parts.map((text) => ({ blockId: file.blockId, text })), target)) {
      if (chunks.length >= allowance) return chunks;
      add(context, file.blockId, `${name}\n${body.text}`.trim());
    }
  }
  return chunks;
}

/** Fingerprint of what a page's index was built from: its chunks and the model. */
export function sourceHash(model: string, chunks: Pick<ChunkDraft, "hash" | "blockId">[]): string {
  return sha256(JSON.stringify([model, chunks.map((c) => [c.hash, c.blockId])]));
}

/**
 * A chunk's passage without where it is (chunkContext), for snippets and the AI chat. That names
 * pages above, which the reader may not be allowed to see, so it never shows.
 */
export function passageOf(chunkText: string, title: string): string {
  const split = chunkText.indexOf("\n\n");
  if (split !== -1) return chunkText.slice(split + 2).trim();
  // Indexed by the first chunker (CHUNKER_VERSION 1), not yet again: just the title line in front.
  const t = title.trim().replace(/\s+/g, " ");
  // A page with only a title has nothing else to show.
  if (t && chunkText.trim() === t) return "";
  const body = t && chunkText.startsWith(`${t}\n`) ? chunkText.slice(t.length + 1) : chunkText;
  return body.trim();
}

/** Lower-cased for comparing words, the dotted and dotless i alike (Turkish). */
const foldWord = (word: string) => word.toLocaleLowerCase("tr").replace(/ı/g, "i");

/**
 * Of a page's chunks, the one whose passage has the most of `terms` (see lib/search-words: words
 * matched as prefixes, Japanese, Chinese and Korean pieces anywhere in a word), then the most matches, then the earliest. Where the text search found the
 * page, this is the passage it was found for. With no term in any passage (the title matched),
 * the first chunk. Null without chunks.
 */
export function bestChunkForTerms<T extends { position: number; text: string }>(chunks: T[], terms: string[], title: string): T | null {
  const wanted = [...new Set(terms.map(foldWord).filter(Boolean))];
  let best: { chunk: T; distinct: number; total: number } | null = null;
  for (const chunk of chunks) {
    const words = (passageOf(chunk.text, title).match(/[\p{L}\p{N}]+/gu) ?? []).map(foldWord);
    let distinct = 0;
    let total = 0;
    for (const term of wanted) {
      const hits = words.filter((w) => (isCjkTerm(term) ? w.includes(term) : w.startsWith(term))).length;
      if (hits) distinct++;
      total += hits;
    }
    if (
      !best ||
      distinct > best.distinct ||
      (distinct === best.distinct && (total > best.total || (total === best.total && chunk.position < best.chunk.position)))
    ) {
      best = { chunk, distinct, total };
    }
  }
  return best?.chunk ?? null;
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
