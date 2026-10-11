-- What people were given in a workspace they have since left, or were removed from, goes: their
-- page and property entries, their calendar feeds of it and API tokens that only reach it. None of
-- it worked while they were out, but all of it came back if they were let in again; leaving now
-- removes it (forgetWorkspaceGrants), and this clears what earlier departures left behind.
DELETE FROM "page_permission" pp
WHERE pp."user_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "workspace_member" m WHERE m."workspace_id" = pp."workspace_id" AND m."user_id" = pp."user_id");
--> statement-breakpoint
DELETE FROM "property_permission" pp
WHERE pp."user_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "workspace_member" m WHERE m."workspace_id" = pp."workspace_id" AND m."user_id" = pp."user_id");
--> statement-breakpoint
DELETE FROM "calendar_feed" f
WHERE f."workspace_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "workspace_member" m WHERE m."workspace_id" = f."workspace_id" AND m."user_id" = f."user_id");
--> statement-breakpoint
DELETE FROM "calendar_feed" f
USING "database_view" v, "page" p
WHERE f."view_id" = v."id" AND p."id" = v."database_id"
  AND NOT EXISTS (SELECT 1 FROM "workspace_member" m WHERE m."workspace_id" = p."workspace_id" AND m."user_id" = f."user_id");
--> statement-breakpoint
DELETE FROM "api_token" t
WHERE t."workspace_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "workspace_member" m WHERE m."workspace_id" = t."workspace_id" AND m."user_id" = t."user_id");
