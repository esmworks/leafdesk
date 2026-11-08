/**
 * Notes found by meaning: each kept note's embedding in `memory_embedding`, made when a search first
 * needs it and made again when the note's text or details changed (`content_hash`) or the searching
 * workspace's embeddings model is another (`model`). Nothing embeds notes in the background: a
 * search embeds the query and at most FILL_LIMIT of the notes it reads that have no current
 * embedding, newest first; older ones wait for the next search and are found by their words
 * meanwhile. Any failure (no model, a limit, the provider) leaves the search to the words.
 */
import { createHash } from "node:crypto";
import { inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { memoryEmbedding } from "@/db/schema";
import { cosine } from "@/lib/memory-search";
import { embed, embeddingModelFor, minSimilarityFor } from "@/server/ai";
import { semanticAvailable } from "@/server/semantic-index";

/** The table a note is kept in. */
export type NoteStore = "ai_memory" | "shared_memory" | "account_memory";

/** A note to search, with the table it is kept in. */
export type EmbeddableNote = { id: string; store: NoteStore; text: string; details?: string | null };

/** Texts per embeddings request. */
const EMBED_BATCH = 32;
/** Notes one search embeds at most; the rest wait for the next search. */
const FILL_LIMIT = 64;
/** How long a search waits for the embeddings before going on with the words alone. */
const EMBED_TIMEOUT_MS = 8_000;

const COLUMN = { ai_memory: "aiMemoryId", shared_memory: "sharedMemoryId", account_memory: "accountMemoryId" } as const;

/** How much of a note's details is embedded: enough for what it is about, and a request's size stays bounded. */
const DETAILS_CHARS = 1_000;

/** What is embedded of a note: its line and the start of its details. */
const embeddedText = (note: EmbeddableNote) => (note.details ? `${note.text}\n\n${note.details.slice(0, DETAILS_CHARS)}` : note.text);

/** The hash that tells an embedding still matches its note. */
export const noteHash = (note: EmbeddableNote) => createHash("sha256").update(embeddedText(note)).digest("hex");

/**
 * How close each of `notes` is to `query` by meaning, by `workspaceId`'s embeddings model, keeping
 * only those at least as close as the workspace's minimum similarity (as page search does); null
 * when semantic search doesn't run there or failed now, so the caller searches by words alone.
 * Embeds what it needs (see the module's comment) as `userId`, within their AI allowance.
 */
export async function noteSimilarities(
  notes: EmbeddableNote[],
  query: string,
  { userId, workspaceId }: { userId: string; workspaceId: string },
): Promise<Map<string, number> | null> {
  if (!notes.length || !query.trim()) return null;
  try {
    if (!(await semanticAvailable(workspaceId))) return null;
    const [model, minSimilarity] = await Promise.all([embeddingModelFor(workspaceId), minSimilarityFor(workspaceId)]);
    if (!model) return null;

    const ids = (store: NoteStore) => notes.filter((n) => n.store === store).map((n) => n.id);
    const conditions = (Object.keys(COLUMN) as NoteStore[])
      .filter((store) => ids(store).length)
      .map((store) => inArray(memoryEmbedding[COLUMN[store]], ids(store)));
    const rows = await db
      .select({
        aiMemoryId: memoryEmbedding.aiMemoryId,
        sharedMemoryId: memoryEmbedding.sharedMemoryId,
        accountMemoryId: memoryEmbedding.accountMemoryId,
        contentHash: memoryEmbedding.contentHash,
        model: memoryEmbedding.model,
        embedding: memoryEmbedding.embedding,
      })
      .from(memoryEmbedding)
      .where(or(...conditions));
    const stored = new Map(rows.map((r) => [(r.aiMemoryId ?? r.sharedMemoryId ?? r.accountMemoryId)!, r] as const));

    const hashes = new Map(notes.map((n) => [n.id, noteHash(n)] as const));
    const current = (id: string) => {
      const row = stored.get(id);
      return row && row.model === model && row.contentHash === hashes.get(id) ? row.embedding : null;
    };
    const missing = notes
      .filter((n) => !current(n.id))
      .reverse()
      .slice(0, FILL_LIMIT);

    const texts = [query, ...missing.map(embeddedText)];
    const signal = AbortSignal.timeout(EMBED_TIMEOUT_MS);
    const vectors: number[][] = [];
    // One search takes one request from the person's AI allowance, however many batches it needs.
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      vectors.push(...(await embed(texts.slice(i, i + EMBED_BATCH), { feature: "memory.search", userId, workspaceId, signal, skipRateLimit: i > 0 })));
    }
    const [queryVector, ...made] = vectors;
    if (!queryVector?.length || made.length !== missing.length || vectors.some((v) => v.length !== queryVector.length || !v.every(Number.isFinite))) return null;

    if (missing.length) await keep(missing, made, hashes, model);

    const fresh = new Map(missing.map((n, i) => [n.id, made[i]] as const));
    const similarity = new Map<string, number>();
    for (const note of notes) {
      const vector = fresh.get(note.id) ?? current(note.id);
      if (!vector || vector.length !== queryVector.length) continue;
      const score = cosine(queryVector, vector);
      if (score >= minSimilarity) similarity.set(note.id, score);
    }
    return similarity;
  } catch {
    // The AI layer logs its own failures; the words still find notes.
    return null;
  }
}

/** Stores new embeddings, replacing a note's old one. A note deleted meanwhile is skipped. */
async function keep(notes: EmbeddableNote[], vectors: number[][], hashes: Map<string, string>, model: string) {
  for (const store of Object.keys(COLUMN) as NoteStore[]) {
    const column = COLUMN[store];
    const values = notes.flatMap((note, i) =>
      note.store === store ? [{ [column]: note.id, contentHash: hashes.get(note.id)!, model, dimensions: vectors[i].length, embedding: vectors[i] }] : [],
    );
    for (const value of values) {
      try {
        await db
          .insert(memoryEmbedding)
          .values(value)
          .onConflictDoUpdate({
            target: memoryEmbedding[column],
            set: { contentHash: value.contentHash, model, dimensions: value.dimensions, embedding: value.embedding, createdAt: new Date() },
          });
      } catch (error) {
        // The note went while the model worked (its foreign key): nothing to keep.
        if ((error as { code?: string })?.code !== "23503" && (error as { cause?: { code?: string } })?.cause?.code !== "23503") throw error;
      }
    }
  }
}
