CREATE TABLE "database_row_access" (
	"database_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "database_row_access" ADD CONSTRAINT "database_row_access_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_row_access" ADD CONSTRAINT "database_row_access_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_row_access" ADD CONSTRAINT "database_row_access_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_row_access_workspace_idx" ON "database_row_access" USING btree ("workspace_id");--> statement-breakpoint
-- Row access (lib/row-access.ts): a database's rules give the people in a person property of a
-- row, or the row's creator, a level on the row and the pages under it, like an entry of their
-- own. A database whose rows are restricted shows a row (and what is under it) only to those its
-- rules or its own entries name, and to people with full access to the database: what the row
-- would inherit from the database and above is left out for everyone else. The nearest row of
-- such a database in the page's chain decides. Otherwise as in 0055_security_hardening.sql.
CREATE OR REPLACE FUNCTION page_access_level(p_user text, p_page text) RETURNS smallint
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  v_workspace text;
  v_teamspace text;
  v_role text;
  v_access text;
  v_members smallint;
  v_default smallint := 0;
  v_cap smallint := 0;
  v_everyone smallint;
  v_own smallint;
  v_group smallint;
  v_named boolean;
  v_grouped boolean := false;
  v_ruled boolean;
  v_rooted boolean;
  v_row text;
  v_row_depth int;
  v_database text;
  v_restricted boolean;
  v_rules jsonb;
  v_grant smallint;
BEGIN
  SELECT workspace_id, teamspace_id INTO v_workspace, v_teamspace FROM page WHERE id = p_page;
  IF v_workspace IS NULL THEN RETURN 0; END IF;
  SELECT role INTO v_role FROM workspace_member WHERE workspace_id = v_workspace AND user_id = p_user;
  IF v_role IS NULL THEN RETURN 0; END IF;
  IF v_role IN ('owner', 'member') THEN
    IF v_teamspace IS NULL THEN
      v_cap := 4;
    ELSE
      SELECT access, array_position(ARRAY['none', 'view', 'comment', 'edit', 'full'], member_level) - 1
        INTO v_access, v_members FROM teamspace WHERE id = v_teamspace;
      IF v_access = 'default'
        OR EXISTS (SELECT 1 FROM teamspace_member WHERE teamspace_id = v_teamspace AND user_id = p_user)
        OR EXISTS (
          SELECT 1 FROM teamspace_group tg
          JOIN member_group_member gm ON gm.group_id = tg.group_id AND gm.user_id = p_user
          WHERE tg.teamspace_id = v_teamspace
        ) THEN
        -- The teamspace's owners and the workspace's owners run it: full access by default.
        IF v_role = 'owner'
          OR EXISTS (SELECT 1 FROM teamspace_member WHERE teamspace_id = v_teamspace AND user_id = p_user AND role = 'owner') THEN
          v_default := 4;
        ELSE
          v_default := v_members;
        END IF;
        v_cap := 4;
      ELSIF v_access = 'open' THEN
        -- Those who haven't joined read and comment, never more than its members get.
        v_default := LEAST(2, v_members);
        v_cap := 2;
      END IF;
    END IF;
    v_grouped := EXISTS (SELECT 1 FROM page_group_permission WHERE workspace_id = v_workspace);
  END IF;
  v_named := EXISTS (SELECT 1 FROM page_permission WHERE workspace_id = v_workspace);
  v_ruled := EXISTS (SELECT 1 FROM database_row_access WHERE workspace_id = v_workspace);
  -- Workspaces that never restrict or share a page: skip the ancestor walk.
  IF NOT v_named AND NOT v_grouped AND NOT v_ruled THEN
    RETURN v_default;
  END IF;
  WITH RECURSIVE chain AS (
    SELECT id, parent_id, 0 AS depth FROM page WHERE id = p_page
    UNION ALL
    SELECT p.id, p.parent_id, c.depth + 1 FROM page p JOIN chain c ON p.id = c.parent_id WHERE c.depth < 64
  )
  SELECT
    CASE WHEN v_named THEN
      (SELECT array_position(ARRAY['none', 'view', 'comment', 'edit', 'full'], pp.level) - 1
         FROM chain c JOIN page_permission pp ON pp.page_id = c.id AND pp.user_id IS NULL
         ORDER BY c.depth LIMIT 1)
    END,
    CASE WHEN v_named THEN
      (SELECT array_position(ARRAY['none', 'view', 'comment', 'edit', 'full'], pp.level) - 1
         FROM chain c JOIN page_permission pp ON pp.page_id = c.id AND pp.user_id = p_user
         ORDER BY c.depth LIMIT 1)
    END,
    CASE WHEN v_grouped THEN
      (SELECT max(nearest.rank) FROM (
         SELECT DISTINCT ON (gp.group_id) array_position(ARRAY['none', 'view', 'comment', 'edit', 'full'], gp.level) - 1 AS rank
         FROM chain c
         JOIN page_group_permission gp ON gp.page_id = c.id
         JOIN member_group_member gm ON gm.group_id = gp.group_id AND gm.user_id = p_user
         ORDER BY gp.group_id, c.depth
       ) nearest)
    END,
    (SELECT bool_or(c.parent_id IS NULL) FROM chain c)
  INTO v_everyone, v_own, v_group, v_rooted;
  -- The walk stopped before the top: an entry further up ("everyone: none", say) went unseen.
  -- Nothing rather than the teamspace's default; pages aren't nested this deep (MAX_PAGE_DEPTH).
  IF NOT COALESCE(v_rooted, false) THEN
    RETURN 0;
  END IF;
  IF v_ruled THEN
    -- The nearest row (the page itself or one above it) of a database with row access.
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, 0 AS depth FROM page WHERE id = p_page
      UNION ALL
      SELECT p.id, p.parent_id, c.depth + 1 FROM page p JOIN chain c ON p.id = c.parent_id WHERE c.depth < 64
    )
    SELECT c.id, c.depth, ra.database_id, ra.restricted, ra.rules
      INTO v_row, v_row_depth, v_database, v_restricted, v_rules
      FROM chain c JOIN database_row_access ra ON ra.database_id = c.parent_id
      ORDER BY c.depth LIMIT 1;
  END IF;
  IF v_row IS NULL THEN
    RETURN GREATEST(LEAST(COALESCE(v_everyone, v_default), v_cap), COALESCE(v_own, 0), COALESCE(v_group, 0));
  END IF;
  -- What the rules give this person on that row: a person property of the database (not deleted,
  -- still a person property) naming them, or their having created the row.
  SELECT max(array_position(ARRAY['none', 'view', 'comment', 'edit', 'full'], rule->>'level') - 1)
    INTO v_grant
    FROM jsonb_array_elements(v_rules) rule
    JOIN page r ON r.id = v_row
    WHERE (rule->>'kind' = 'creator' AND r.created_by = p_user)
      OR (
        rule->>'kind' = 'person'
        AND jsonb_typeof(r.properties -> (rule->>'propertyId')) = 'array'
        AND (r.properties -> (rule->>'propertyId')) ? p_user
        AND EXISTS (
          SELECT 1 FROM database_property dp
          WHERE dp.id = rule->>'propertyId' AND dp.database_id = v_database AND dp.type = 'person' AND dp.deleted_at IS NULL
        )
      );
  IF NOT v_restricted OR page_access_level(p_user, v_database) >= 4 THEN
    RETURN GREATEST(LEAST(COALESCE(v_everyone, v_default), v_cap), COALESCE(v_own, 0), COALESCE(v_group, 0), COALESCE(v_grant, 0));
  END IF;
  -- Restricted rows: only the entries on the row and below it count, besides the rules.
  WITH RECURSIVE chain AS (
    SELECT id, parent_id, 0 AS depth FROM page WHERE id = p_page
    UNION ALL
    SELECT p.id, p.parent_id, c.depth + 1 FROM page p JOIN chain c ON p.id = c.parent_id WHERE c.depth < v_row_depth
  )
  SELECT
    CASE WHEN v_named THEN
      (SELECT array_position(ARRAY['none', 'view', 'comment', 'edit', 'full'], pp.level) - 1
         FROM chain c JOIN page_permission pp ON pp.page_id = c.id AND pp.user_id IS NULL
         ORDER BY c.depth LIMIT 1)
    END,
    CASE WHEN v_named THEN
      (SELECT array_position(ARRAY['none', 'view', 'comment', 'edit', 'full'], pp.level) - 1
         FROM chain c JOIN page_permission pp ON pp.page_id = c.id AND pp.user_id = p_user
         ORDER BY c.depth LIMIT 1)
    END,
    CASE WHEN v_grouped THEN
      (SELECT max(nearest.rank) FROM (
         SELECT DISTINCT ON (gp.group_id) array_position(ARRAY['none', 'view', 'comment', 'edit', 'full'], gp.level) - 1 AS rank
         FROM chain c
         JOIN page_group_permission gp ON gp.page_id = c.id
         JOIN member_group_member gm ON gm.group_id = gp.group_id AND gm.user_id = p_user
         ORDER BY gp.group_id, c.depth
       ) nearest)
    END
  INTO v_everyone, v_own, v_group;
  RETURN GREATEST(LEAST(COALESCE(v_everyone, 0), v_cap), COALESCE(v_own, 0), COALESCE(v_group, 0), COALESCE(v_grant, 0));
END
$$;
