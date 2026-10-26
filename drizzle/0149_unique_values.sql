CREATE TABLE "unique_value" (
	"row_id" text NOT NULL,
	"property_id" text NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "unique_value_row_id_property_id_pk" PRIMARY KEY("row_id","property_id")
);
--> statement-breakpoint
ALTER TABLE "unique_value" ADD CONSTRAINT "unique_value_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unique_value" ADD CONSTRAINT "unique_value_property_id_database_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."database_property"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_value_key_idx" ON "unique_value" USING btree ("property_id","key");--> statement-breakpoint
-- Properties that keep their values unique (options.unique, lib/unique-values). Postgres keeps
-- the rule, so every way a row is written (the app, the API, imports, automations, syncs, copies,
-- restores) is held to it: each live row's value is in unique_value under its folded form, and the
-- unique index refuses a second row with the same one (error 23505 on unique_value_key_idx, which
-- server/unique-values.ts turns into a PropertyValueError).
--
-- The folded form, as lib/unique-values uniqueValueKey works it out: text, emails and links
-- trimmed and in lower case, phone numbers by their digits and "+", numbers by amount. Null for an
-- empty value, which any number of rows may have.
CREATE OR REPLACE FUNCTION unique_value_key(p_type text, p_value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_key text;
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  IF p_type = 'number' THEN
    IF jsonb_typeof(p_value) <> 'number' THEN RETURN NULL; END IF;
    RETURN trim_scale((p_value #>> '{}')::numeric)::text;
  END IF;
  IF jsonb_typeof(p_value) <> 'string' THEN RETURN NULL; END IF;
  IF p_type = 'phone' THEN
    v_key := regexp_replace(p_value #>> '{}', '[^0-9+]', '', 'g');
  ELSE
    v_key := lower(btrim(p_value #>> '{}'));
  END IF;
  RETURN nullif(v_key, '');
END
$$;--> statement-breakpoint
-- A row written, moved, trashed or restored: its entries follow its values. Every write takes a
-- shared lock on its database, which turning the rule on takes exclusively (below), so a row
-- written while the rule is turned on is either counted there or sees the rule here.
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
      INSERT INTO unique_value (row_id, property_id, key) VALUES (NEW.id, v_prop.id, v_key)
      ON CONFLICT (row_id, property_id) DO UPDATE SET key = EXCLUDED.key WHERE unique_value.key IS DISTINCT FROM EXCLUDED.key;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER page_unique_values AFTER INSERT OR UPDATE OF parent_id, properties, archived_at, is_template, kind ON "page"
FOR EACH ROW EXECUTE FUNCTION page_unique_values();--> statement-breakpoint
-- The rule turned on (a property added with it, turned on, restored from the trash, or made from
-- another type): the rows' values are counted, and two rows with the same one stop it (23505), so
-- the app checks first and says which. Turned off, deleted or made a type that can't keep it: its
-- entries go.
CREATE OR REPLACE FUNCTION database_property_unique_values() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_on boolean := NEW.deleted_at IS NULL AND (NEW.options -> 'unique') IS NOT DISTINCT FROM 'true'::jsonb
    AND NEW.type IN ('text', 'number', 'email', 'url', 'phone');
BEGIN
  IF NOT v_on THEN
    DELETE FROM unique_value WHERE property_id = NEW.id;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND (OLD.options -> 'unique') IS NOT DISTINCT FROM 'true'::jsonb AND OLD.type = NEW.type THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('unique_value:' || NEW.database_id, 0));
  DELETE FROM unique_value WHERE property_id = NEW.id;
  INSERT INTO unique_value (row_id, property_id, key)
  SELECT p.id, NEW.id, k.key
  FROM page p, LATERAL (SELECT unique_value_key(NEW.type, p.properties -> NEW.id) AS key) k
  WHERE p.parent_id = NEW.database_id AND p.archived_at IS NULL AND NOT p.is_template AND p.kind = 'page' AND k.key IS NOT NULL;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER database_property_unique_values AFTER INSERT OR UPDATE OF options, type, deleted_at ON "database_property"
FOR EACH ROW EXECUTE FUNCTION database_property_unique_values();
