-- Full-text search finds pages by the words of the PDFs and Word documents they show, not only
-- semantic search. Each document's text (file_text, read once per file) gets its own vector, built
-- like a page body's: the words of its first 80,000 characters and the two-character pieces of their
-- Chinese and Japanese text (cjk_bigrams, migration 0077), which keeps it under Postgres' tsvector
-- limit for the same reason. Adding the column rewrites file_text once.
ALTER TABLE "file_text" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', left(text, 80000)) || to_tsvector('simple', cjk_bigrams(left(text, 80000)))) STORED;--> statement-breakpoint
CREATE INDEX "file_text_search_vector_idx" ON "file_text" USING gin ("search_vector");
