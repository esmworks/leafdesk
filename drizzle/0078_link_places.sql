-- Every block of a page that links to another page, with the text around each link, so "Linked from"
-- lists each place and opens the page at it. Existing links get theirs from a backfill on the server
-- (server/mentions.ts) or when their page is next saved.
ALTER TABLE "page_link" ADD COLUMN "places" jsonb;
