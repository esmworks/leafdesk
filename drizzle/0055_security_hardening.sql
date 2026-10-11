-- The page access rule (0034_teamspace_member_level) failing closed: the walk up a page's ancestors
-- stops after 64 steps, and a page it can't follow to the top level now gets no access instead of
-- the teamspace's default, since an entry for everyone (or the user) above the cut would go unseen.
-- Unchanged otherwise. Workspaces that never restrict or share a page still skip the walk.
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
  v_rooted boolean;
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
  -- Workspaces that never restrict or share a page: skip the ancestor walk.
  IF NOT v_named AND NOT v_grouped THEN
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
  RETURN GREATEST(LEAST(COALESCE(v_everyone, v_default), v_cap), COALESCE(v_own, 0), COALESCE(v_group, 0));
END
$$;
--> statement-breakpoint
-- Sign-in providers' tokens (GitHub, Google, OIDC, single sign-on) aren't kept any more: Leafdesk
-- never read them back. Those stored so far go too.
UPDATE "account" SET "access_token" = NULL, "refresh_token" = NULL, "id_token" = NULL
WHERE "access_token" IS NOT NULL OR "refresh_token" IS NOT NULL OR "id_token" IS NOT NULL;
