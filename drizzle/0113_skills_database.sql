ALTER TABLE "page" ADD COLUMN "is_skill_database" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "skill_description_property" text;--> statement-breakpoint
-- Every row of a skills database is a skill: a row added to one, or moved into one, is marked (and
-- stays marked when it moves out). Its description is the value of the database's description
-- property, a text one not in the trash, cut to the 1024 characters a description may have.
CREATE OR REPLACE FUNCTION page_skill_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_skills boolean;
  v_property text;
BEGIN
  IF NEW.parent_id IS NULL OR NEW.kind <> 'page' THEN RETURN NEW; END IF;
  SELECT d.is_skill_database, dp.id INTO v_skills, v_property
  FROM page d
  LEFT JOIN database_property dp
    ON dp.id = d.skill_description_property AND dp.database_id = d.id AND dp.type = 'text' AND dp.deleted_at IS NULL
  WHERE d.id = NEW.parent_id;
  IF NOT FOUND OR NOT v_skills THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN NEW.is_skill := true; END IF;
  IF v_property IS NOT NULL THEN
    NEW.skill_description := left(btrim(coalesce(NEW.properties ->> v_property, '')), 1024);
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER page_skill_row BEFORE INSERT OR UPDATE OF parent_id, properties ON "page"
FOR EACH ROW EXECUTE FUNCTION page_skill_row();
