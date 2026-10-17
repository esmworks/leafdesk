-- Chinese and Japanese text has no spaces between words, so the 'simple' parser takes a whole run as
-- one word and search found it only from its start. The search vector now also holds every
-- two-character piece of such text ("明日の会議" → 明日 日の の会 会議, and the last character
-- alone), and lib/search-words cuts queries into the same pieces. Pieces are taken from the first
-- 30,000 characters of such text only; later text is still found from the start of its runs. The
-- character ranges (letters only) are CJK_RANGES in src/lib/search-words.ts, and
-- search-words.test.ts checks they match. Korean is written with spaces, so it is left to the
-- parser.
-- A tsvector holds at most 1,048,575 bytes, and a save whose vector is longer fails. So the vector
-- takes only the first 1,000 characters of the title and 80,000 of the body. Measured worst case
-- (unique hyphenated pairs of four-byte letters, about 7.5 bytes per character, with the pieces at
-- their 30,000 limit of 12 bytes each): about 980 KB; ordinary prose takes about 1.1 bytes a
-- character. Replacing the column rewrites the page table once; replacing only the function later
-- wouldn't recompute the stored vectors.
CREATE OR REPLACE FUNCTION cjk_bigrams(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  select coalesce(string_agg(piece, ' '), '')
  from (
    select substr(run[1], i, 2) as piece
    from regexp_matches(coalesce(t, ''), '[\u3005-\u3007\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002fa1f\u3041-\u3096\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff\uff66-\uff9f]+', 'g') as run,
      generate_series(1, char_length(run[1])) as i
    limit 30000
  ) pieces
$$;--> statement-breakpoint
ALTER TABLE "page" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', left(coalesce(title, ''), 1000)), 'A') || setweight(to_tsvector('simple', left(coalesce(content_text, ''), 80000)), 'B') || setweight(to_tsvector('simple', cjk_bigrams(left(title, 1000))), 'A') || setweight(to_tsvector('simple', cjk_bigrams(left(content_text, 80000))), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "page_search_vector_idx" ON "page" USING gin ("search_vector");
