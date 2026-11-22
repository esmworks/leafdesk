import { turkishRoots } from "./turkish-stem";

/** Notes a search of the memory answers with (the chat's read_memory, MCP's list_memory), the best first. */
export const MEMORY_SEARCH_LIMIT = 10;

const lowered = (text: string) => text.toLocaleLowerCase("tr");
const words = (text: string) => lowered(text).split(/[\s,.;:!?"'()]+/).filter(Boolean);

/** A search's words, lower-cased, each once. */
export const queryWords = (query: string) => [...new Set(words(query))];

/** Whether one of `text`'s words starts with `word` ("offer" finds "offers", "3" never "13"). */
const hasWord = (text: string[], word: string) => text.some((w) => w.startsWith(word));

/**
 * How well `word` is found in a note's line and details: 2 in the line, 1 in the details; half
 * that when only its Turkish root is ("farkı" in a note saying "fark", lib/turkish-stem.ts).
 */
function wordScore(line: string[], details: string[], word: string, roots: string[]): number {
  if (hasWord(line, word)) return 2;
  if (hasWord(details, word)) return 1;
  if (roots.some((root) => hasWord(line, root))) return 1;
  if (roots.some((root) => hasWord(details, root))) return 0.5;
  return 0;
}

/**
 * The notes (oldest first) with most of `query`'s words, the best first: words in a note's line
 * count twice those in its details, newer notes first on a tie; at most `limit`. A word matches
 * the start of a note's word, and so does its Turkish root, by half.
 */
export function matchNotes<T extends { text: string; details?: string | null }>(notes: T[], query: string, limit: number = MEMORY_SEARCH_LIMIT): T[] {
  const wanted = queryWords(query).map((word) => ({ word, roots: turkishRoots(word) }));
  if (!wanted.length) return [];
  return notes
    .map((note, index) => {
      const line = words(note.text);
      const details = words(note.details ?? "");
      return { note, index, score: wanted.reduce((sum, w) => sum + wordScore(line, details, w.word, w.roots), 0) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .map((s) => s.note);
}

/** How far down a ranking a note still counts in rankNotes (reciprocal rank fusion's usual k). */
const FUSION_K = 60;

/**
 * The notes (oldest first) that best fit `query`, the best first, at most `limit`: by their words
 * (matchNotes) and, when `similarity` is given, by meaning too, `similarity` holding each note
 * (by id) whose embedding is close enough to the query's. The two rankings are fused by their ranks
 * (reciprocal rank fusion), so a note found both ways comes first and neither scale needs to match
 * the other's; newer notes first on a tie. Without `similarity` (no embeddings model, or it
 * failed), the words alone.
 */
export function rankNotes<T extends { id: string; text: string; details?: string | null }>(
  notes: T[],
  query: string,
  similarity: ReadonlyMap<string, number> | null,
  limit: number = MEMORY_SEARCH_LIMIT,
): T[] {
  if (!similarity?.size) return matchNotes(notes, query, limit);
  const score = new Map<T, number>();
  const add = (ranked: T[]) => ranked.forEach((note, rank) => score.set(note, (score.get(note) ?? 0) + 1 / (FUSION_K + rank + 1)));
  add(matchNotes(notes, query, notes.length));
  add(notes.filter((n) => similarity.has(n.id)).sort((a, b) => similarity.get(b.id)! - similarity.get(a.id)!));
  const order = new Map(notes.map((note, index) => [note, index] as const));
  return [...score.entries()]
    .sort(([a, sa], [b, sb]) => sb - sa || order.get(b)! - order.get(a)!)
    .slice(0, limit)
    .map(([note]) => note);
}

/** Cosine similarity of two vectors of the same length; 0 when either is all zeros. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
