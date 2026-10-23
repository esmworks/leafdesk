-- A page that comes into a skills database (moved in, or its database turned into one) keeps the
-- description it had as a skill: when its description property is empty, the description is
-- written there instead of being cleared (0113 cleared it). Otherwise unchanged: the property's
-- value is the description.
CREATE OR REPLACE FUNCTION page_skill_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_skills boolean;
  v_property text;
  v_value text;
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
    v_value := btrim(coalesce(NEW.properties ->> v_property, ''));
    IF v_value = '' AND NEW.skill_description <> ''
      AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.properties IS NOT DISTINCT FROM OLD.properties) THEN
      NEW.properties := jsonb_set(NEW.properties, ARRAY[v_property], to_jsonb(NEW.skill_description));
    ELSE
      NEW.skill_description := left(v_value, 1024);
    END IF;
  END IF;
  RETURN NEW;
END
$$;
