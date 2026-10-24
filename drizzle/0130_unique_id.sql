ALTER TABLE "database_property" ADD COLUMN "last_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Unique ID properties (lib/unique-id) number a database's rows. Postgres gives the numbers out, so
-- every way a row is made (the app, templates, imports, the API, automations, copies) gets one,
-- and no write can change or drop one.
--
-- A row made in a database, or moved into one, gets the next number of each of its unique ID
-- properties: database_property.last_number counted up, which locks that property's row until the
-- transaction ends, so two rows made at once never get the same number. A copy of a row is a new
-- row and gets a new number. Row templates get none (the rows made from them do), and neither do
-- rows made while the property is deleted (they get one when it is restored). A write to a row's
-- values keeps the number it has. Numbers written by database_property_unique_ids below (a
-- trigger fired by a trigger) stand as given.
CREATE OR REPLACE FUNCTION page_unique_ids() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prop record;
  v_moved boolean := TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id;
  v_number integer;
BEGIN
  IF pg_trigger_depth() > 1 OR NEW.parent_id IS NULL OR NEW.kind <> 'page' THEN RETURN NEW; END IF;
  -- Waits for a unique ID property being added to the database to be numbered (see below), so
  -- the row is numbered by one or the other.
  IF v_moved THEN PERFORM 1 FROM page WHERE id = NEW.parent_id FOR KEY SHARE; END IF;
  FOR v_prop IN
    SELECT id, deleted_at FROM database_property WHERE database_id = NEW.parent_id AND type = 'unique_id' ORDER BY id
  LOOP
    IF NOT v_moved AND jsonb_typeof(OLD.properties -> v_prop.id) = 'number' THEN
      NEW.properties := jsonb_set(NEW.properties, ARRAY[v_prop.id], OLD.properties -> v_prop.id);
    ELSIF NEW.is_template OR v_prop.deleted_at IS NOT NULL THEN
      NEW.properties := NEW.properties - v_prop.id;
    ELSE
      UPDATE database_property SET last_number = last_number + 1 WHERE id = v_prop.id RETURNING last_number INTO v_number;
      NEW.properties := jsonb_set(NEW.properties, ARRAY[v_prop.id], to_jsonb(v_number));
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER page_unique_ids BEFORE INSERT OR UPDATE OF parent_id, properties ON "page"
FOR EACH ROW EXECUTE FUNCTION page_unique_ids();--> statement-breakpoint
-- A unique ID property added to a database, restored from the trash, or made from another type
-- numbers the rows in the order they were made (row templates aside). Added or restored, rows
-- that already have a number keep it (a restored backup or a copied database brings its rows'
-- numbers) and the others are numbered after the highest; made from another type, the old values
-- go and every row gets a new number. Rows in the trash are numbered too: they may come back.
CREATE OR REPLACE FUNCTION database_property_unique_ids() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_renumber boolean := TG_OP = 'UPDATE' AND OLD.type IS DISTINCT FROM NEW.type;
  v_last integer;
  v_count integer;
BEGIN
  IF NEW.type <> 'unique_id' OR NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.type = 'unique_id' AND OLD.deleted_at IS NULL THEN RETURN NULL; END IF;
  -- Rows being made in the database meanwhile are waited for and numbered here; rows made after
  -- this wait for the property and are numbered as they go in (page_unique_ids).
  PERFORM 1 FROM page WHERE id = NEW.database_id FOR UPDATE;
  SELECT last_number INTO v_last FROM database_property WHERE id = NEW.id;
  IF NOT v_renumber THEN
    SELECT greatest(v_last, coalesce(max(least((p.properties ->> NEW.id)::numeric, 2000000000)), 0))::integer INTO v_last
    FROM page p
    WHERE p.parent_id = NEW.database_id AND NOT p.is_template AND jsonb_typeof(p.properties -> NEW.id) = 'number';
  END IF;
  WITH todo AS (
    SELECT p.id, row_number() OVER (ORDER BY p.created_at, p.id) AS i
    FROM page p
    WHERE p.parent_id = NEW.database_id AND p.kind = 'page' AND NOT p.is_template
      AND (v_renumber OR jsonb_typeof(p.properties -> NEW.id) IS DISTINCT FROM 'number')
  )
  UPDATE page p SET properties = jsonb_set(p.properties, ARRAY[NEW.id], to_jsonb(v_last + todo.i))
  FROM todo WHERE p.id = todo.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE database_property SET last_number = v_last + v_count WHERE id = NEW.id;
  UPDATE page SET properties = properties - NEW.id WHERE parent_id = NEW.database_id AND is_template AND properties ? NEW.id;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER database_property_unique_ids AFTER INSERT OR UPDATE OF type, deleted_at ON "database_property"
FOR EACH ROW EXECUTE FUNCTION database_property_unique_ids();
