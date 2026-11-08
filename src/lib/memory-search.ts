/** Notes a search of the memory answers with (the chat's read_memory, MCP's list_memory), the best first. */
export const MEMORY_SEARCH_LIMIT = 10;

const lowered = (text: string) => text.toLocaleLowerCase("tr");

/** A search's words, lower-cased, each once. */
export const queryWords = (query: string) => [...new Set(lowered(query).split(/[\s,.;:!?"'()]+/).filter(Boolean))];

/**
 * The notes (oldest first) with most of `query`'s words, the best first: words in a note's line
 * count twice those in its details, newer notes first on a tie; at most `limit`.
 */
export function matchNotes<T extends { text: string; details?: string | null }>(notes: T[], query: string, limit = MEMORY_SEARCH_LIMIT): T[] {
  const words = queryWords(query);
  if (!words.length) return [];
  return notes
    .map((note, index) => {
      const line = lowered(note.text);
      const details = lowered(note.details ?? "");
      return { note, index, score: words.reduce((sum, w) => sum + (line.includes(w) ? 2 : details.includes(w) ? 1 : 0), 0) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .map((s) => s.note);
}
