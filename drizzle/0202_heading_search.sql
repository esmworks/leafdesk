-- A word in a page's headings counts for more in search than one in the rest of its body: the
-- headings' text is kept apart (heading_text, written with content_text on every save) and weighed
-- B, the body C, the title still A. Pages saved before get their headings from their Markdown
-- (toggle headings, written as HTML there, come with their next save). Replacing the vector
-- rewrites the page table once and builds its index again.
ALTER TABLE "page" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "heading_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "page" SET "heading_text" = coalesce(
  (select string_agg(trim(m[1]), E'\n') from regexp_matches("content_markdown", '^#{1,6}[ \t]+(.+)$', 'gm') as m),
  ''
) WHERE "content_markdown" ~ '(^|\n)#{1,6}[ \t]';--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', search_fold(left(coalesce(title, ''), 1000))), 'A') || setweight(to_tsvector('simple', search_fold(left(coalesce(heading_text, ''), 4000))), 'B') || setweight(to_tsvector('simple', search_fold(left(coalesce(content_text, ''), 80000))), 'C') || setweight(to_tsvector('simple', cjk_bigrams(left(title, 1000))), 'A') || setweight(to_tsvector('simple', cjk_bigrams(left(heading_text, 4000))), 'B') || setweight(to_tsvector('simple', cjk_bigrams(left(content_text, 80000))), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "page_search_vector_idx" ON "page" USING gin ("search_vector");
