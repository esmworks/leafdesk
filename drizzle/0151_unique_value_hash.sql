DROP INDEX "unique_value_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "unique_value_key_idx" ON "unique_value" USING btree ("property_id",md5("key"));--> statement-breakpoint
-- The unique index holds each key's hash (a btree entry can't hold more than about 2.7 KB, and a
-- value can be longer); keys still compare in full. A second row with a key is refused before the
-- index is reached, so the error names the value rather than its hash: "Key (property_id,
-- key)=(<id>, <key>) already exists." (server/unique-values.ts). The index stays the last word for
-- writes racing each other, naming the hash.
CREATE OR REPLACE FUNCTION page_unique_values() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prop record;
  v_key text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.parent_id IS NOT DISTINCT FROM NEW.parent_id AND OLD.properties IS NOT DISTINCT FROM NEW.properties
      AND OLD.archived_at IS NOT DISTINCT FROM NEW.archived_at AND OLD.is_template = NEW.is_template AND OLD.kind = NEW.kind THEN
      RETURN NULL;
    END IF;
    IF OLD.parent_id IS DISTINCT FROM NEW.parent_id THEN DELETE FROM unique_value WHERE row_id = NEW.id; END IF;
  END IF;
  IF NEW.parent_id IS NULL THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('unique_value:' || NEW.parent_id, 0));
  FOR v_prop IN
    SELECT id, type FROM database_property
    WHERE database_id = NEW.parent_id AND deleted_at IS NULL AND options -> 'unique' = 'true'::jsonb
    ORDER BY id
  LOOP
    v_key := CASE WHEN NEW.archived_at IS NULL AND NOT NEW.is_template AND NEW.kind = 'page'
      THEN unique_value_key(v_prop.type, NEW.properties -> v_prop.id) END;
    IF v_key IS NULL THEN
      DELETE FROM unique_value WHERE row_id = NEW.id AND property_id = v_prop.id;
    ELSE
      IF EXISTS (
        SELECT 1 FROM unique_value
        WHERE property_id = v_prop.id AND md5(key) = md5(v_key) AND key = v_key AND row_id <> NEW.id
      ) THEN
        RAISE unique_violation USING
          MESSAGE = 'duplicate key value violates unique constraint "unique_value_key_idx"',
          DETAIL = format('Key (property_id, key)=(%s, %s) already exists.', v_prop.id, v_key),
          CONSTRAINT = 'unique_value_key_idx', TABLE = 'unique_value';
      END IF;
      INSERT INTO unique_value (row_id, property_id, key) VALUES (NEW.id, v_prop.id, v_key)
      ON CONFLICT (row_id, property_id) DO UPDATE SET key = EXCLUDED.key WHERE unique_value.key IS DISTINCT FROM EXCLUDED.key;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;--> statement-breakpoint
-- Turning the rule on counts the rows' values: two rows with the same one are refused naming it,
-- as above (the app checks first and says which, server/unique-values requireNoDuplicates).
CREATE OR REPLACE FUNCTION database_property_unique_values() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_on boolean := NEW.deleted_at IS NULL AND (NEW.options -> 'unique') IS NOT DISTINCT FROM 'true'::jsonb
    AND NEW.type IN ('text', 'number', 'email', 'url', 'phone');
  v_key text;
BEGIN
  IF NOT v_on THEN
    DELETE FROM unique_value WHERE property_id = NEW.id;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND (OLD.options -> 'unique') IS NOT DISTINCT FROM 'true'::jsonb AND OLD.type = NEW.type THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('unique_value:' || NEW.database_id, 0));
  SELECT k.key INTO v_key
  FROM page p, LATERAL (SELECT unique_value_key(NEW.type, p.properties -> NEW.id) AS key) k
  WHERE p.parent_id = NEW.database_id AND p.archived_at IS NULL AND NOT p.is_template AND p.kind = 'page' AND k.key IS NOT NULL
  GROUP BY k.key HAVING count(*) > 1
  ORDER BY k.key LIMIT 1;
  IF v_key IS NOT NULL THEN
    RAISE unique_violation USING
      MESSAGE = 'duplicate key value violates unique constraint "unique_value_key_idx"',
      DETAIL = format('Key (property_id, key)=(%s, %s) already exists.', NEW.id, v_key),
      CONSTRAINT = 'unique_value_key_idx', TABLE = 'unique_value';
  END IF;
  DELETE FROM unique_value WHERE property_id = NEW.id;
  INSERT INTO unique_value (row_id, property_id, key)
  SELECT p.id, NEW.id, k.key
  FROM page p, LATERAL (SELECT unique_value_key(NEW.type, p.properties -> NEW.id) AS key) k
  WHERE p.parent_id = NEW.database_id AND p.archived_at IS NULL AND NOT p.is_template AND p.kind = 'page' AND k.key IS NOT NULL;
  RETURN NULL;
END
$$;