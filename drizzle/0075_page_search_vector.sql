-- Full-text search reads a stored, weighted vector of each page's title (A) and body (B) instead of
-- parsing them again for every candidate page. Adding the column rewrites the page table once.
DROP INDEX "page_search_idx";--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(content_text, '')), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "page_search_vector_idx" ON "page" USING gin ("search_vector");