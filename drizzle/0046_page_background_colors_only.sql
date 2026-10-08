-- Page backgrounds are colors and patterns only (src/lib/page-background.ts): a background no
-- longer loads an image, so image backgrounds are removed. Done before the trigger changes, so the
-- trigger still drops the file references those images held.
UPDATE "page" SET "background" = NULL WHERE "background" ->> 'kind' = 'image';
--> statement-breakpoint
-- Files a page uses are those in its body and its files properties again; a background holds none.
CREATE OR REPLACE FUNCTION sync_file_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ids text[];
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.content_markdown IS NOT DISTINCT FROM OLD.content_markdown
    AND NEW.properties IS NOT DISTINCT FROM OLD.properties THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(array_agg(DISTINCT found.id), '{}') INTO ids
  FROM (
    SELECT m[1] AS id
    FROM regexp_matches(NEW.content_markdown, '/api/files/([A-Za-z0-9_-]{24})(?![A-Za-z0-9_-])', 'g') AS m
    UNION
    SELECT substring(u #>> '{}' FROM '^/api/files/([A-Za-z0-9_-]{24})$')
    FROM jsonb_path_query(NEW.properties, 'lax $.*[*].url') AS u
  ) AS found
  WHERE found.id IS NOT NULL;
  DELETE FROM file_reference WHERE page_id = NEW.id AND NOT (file_id = ANY (ids));
  IF cardinality(ids) > 0 THEN
    INSERT INTO file_reference (file_id, page_id)
    SELECT f.id, NEW.id FROM file f WHERE f.id = ANY (ids) AND f.workspace_id = NEW.workspace_id
    ON CONFLICT DO NOTHING;
    UPDATE file SET referenced_at = now()
    WHERE id = ANY (ids) AND workspace_id = NEW.workspace_id AND referenced_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS page_file_references ON page;
--> statement-breakpoint
CREATE TRIGGER page_file_references AFTER INSERT OR UPDATE OF content_markdown, properties ON page
FOR EACH ROW EXECUTE FUNCTION sync_file_references();
