ALTER TABLE "page" ADD COLUMN "background" jsonb;
--> statement-breakpoint
-- Page backgrounds replace covers (src/lib/page-background.ts). An image cover becomes an image
-- background; a gradient cover becomes the color closest to it. The cover column goes in 0045.
UPDATE "page" SET "background" = CASE
  WHEN "cover" ->> 'kind' = 'image' AND "cover" ->> 'url' IS NOT NULL
    THEN jsonb_build_object('kind', 'image', 'url', "cover" ->> 'url')
  WHEN "cover" ->> 'kind' = 'gradient' THEN jsonb_build_object('kind', 'color', 'color', CASE "cover" ->> 'gradient'
    WHEN 'forest' THEN 'green'
    WHEN 'meadow' THEN 'green'
    WHEN 'lagoon' THEN 'blue'
    WHEN 'sky' THEN 'blue'
    WHEN 'dusk' THEN 'purple'
    WHEN 'ember' THEN 'orange'
    WHEN 'berry' THEN 'pink'
    ELSE 'gray'
  END)
END
WHERE "cover" IS NOT NULL;
--> statement-breakpoint
-- An uploaded background image is a file the page uses, like one in its body, so it is kept, opens
-- for whoever sees the page (or a copy of it) and goes into exports. Only an image background's
-- exact file path counts (`background.url`, `/api/files/<id>`); links to other sites and colors
-- reference nothing. Keep in sync with backgroundFileId in src/lib/page-background.ts.
CREATE OR REPLACE FUNCTION sync_file_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ids text[];
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.content_markdown IS NOT DISTINCT FROM OLD.content_markdown
    AND NEW.properties IS NOT DISTINCT FROM OLD.properties
    AND NEW.background IS NOT DISTINCT FROM OLD.background THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(array_agg(DISTINCT found.id), '{}') INTO ids
  FROM (
    SELECT m[1] AS id
    FROM regexp_matches(NEW.content_markdown, '/api/files/([A-Za-z0-9_-]{24})(?![A-Za-z0-9_-])', 'g') AS m
    UNION
    SELECT substring(u #>> '{}' FROM '^/api/files/([A-Za-z0-9_-]{24})$')
    FROM jsonb_path_query(NEW.properties, 'lax $.*[*].url') AS u
    UNION
    SELECT substring(NEW.background ->> 'url' FROM '^/api/files/([A-Za-z0-9_-]{24})$')
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
CREATE TRIGGER page_file_references AFTER INSERT OR UPDATE OF content_markdown, properties, background ON page
FOR EACH ROW EXECUTE FUNCTION sync_file_references();
