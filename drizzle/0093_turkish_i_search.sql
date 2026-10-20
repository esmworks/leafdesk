-- Turkish lowers "I" to "ı" and "İ" to "i"; the database lowers both to "i" (as English does) and
-- keeps "ı", so a page saying "IŞIK" had the word "işik" and wasn't found by "ışık", nor "ışık" by
-- "IŞIK". search_fold lowers text and treats the dotted and dotless i alike ("ı" becomes "i", and
-- the combining dot some collations leave after a lowered "İ" goes), as lib/search-fold does in
-- JavaScript; the search vectors hold folded words, and every query is folded the same way
-- (server/pages.ts fullTextSearch, server/mentions.ts). Lowering first makes it the same under a
-- Turkish collation, which lowers "I" to "ı". Chinese and Japanese pieces (cjk_bigrams) have no such
-- letters and are left as they were.
-- Replacing the columns rewrites the page and file_text tables once; replacing only the function
-- later wouldn't recompute the stored vectors.
CREATE OR REPLACE FUNCTION search_fold(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  select translate(lower(t), E'ı̇', 'i')
$$;--> statement-breakpoint
ALTER TABLE "page" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', search_fold(left(coalesce(title, ''), 1000))), 'A') || setweight(to_tsvector('simple', search_fold(left(coalesce(content_text, ''), 80000))), 'B') || setweight(to_tsvector('simple', cjk_bigrams(left(title, 1000))), 'A') || setweight(to_tsvector('simple', cjk_bigrams(left(content_text, 80000))), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "page_search_vector_idx" ON "page" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "file_text" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "file_text" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', search_fold(left(text, 80000))) || to_tsvector('simple', cjk_bigrams(left(text, 80000)))) STORED;--> statement-breakpoint
CREATE INDEX "file_text_search_vector_idx" ON "file_text" USING gin ("search_vector");
