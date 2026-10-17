-- Japanese, Chinese and Korean text has no spaces between words (or joins particles to them), so the
-- 'simple' parser takes a whole run as one word and search found it only from its start. The search
-- vector now also holds every two-character piece of such text ("明日の会議" → 明日 日の の会 会議,
-- and the last character alone), and lib/search-words cuts queries into the same pieces. Pieces are
-- taken from the first 30,000 characters of such text only, which keeps the vector well under
-- Postgres' 1 MB limit; later text is still found from the start of its runs. The character ranges
-- are those of CJK in src/lib/search-words.ts. Replacing the column rewrites the page table once.
CREATE OR REPLACE FUNCTION cjk_bigrams(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  select coalesce(string_agg(piece, ' '), '')
  from (
    select substr(run[1], i, 2) as piece
    from regexp_matches(coalesce(t, ''), '[々぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+', 'g') as run,
      generate_series(1, char_length(run[1])) as i
    limit 30000
  ) pieces
$$;--> statement-breakpoint
ALTER TABLE "page" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(content_text, '')), 'B') || setweight(to_tsvector('simple', cjk_bigrams(title)), 'A') || setweight(to_tsvector('simple', cjk_bigrams(content_text)), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "page_search_vector_idx" ON "page" USING gin ("search_vector");
