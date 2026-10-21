CREATE TABLE "agent_version" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"number" integer NOT NULL,
	"kind" text DEFAULT 'changed' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changes" jsonb,
	"restored_from" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agent_version_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agent_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_version_number_idx" ON "agent_version" USING btree ("agent_id","number");--> statement-breakpoint
-- Agents made before versions start with their setup as it is now: version 1, a "baseline". It is
-- built the way server/agents/versions.ts reads a setup.
INSERT INTO "agent_version" ("id", "agent_id", "number", "kind", "snapshot")
SELECT gen_random_uuid()::text, a."id", 1, 'baseline', jsonb_build_object(
	'settings', to_jsonb(a) - 'id' - 'workspace_id' - 'user_id' - 'created_by' - 'created_at' - 'updated_at' - 'archived_at',
	'skills', coalesce((SELECT jsonb_agg(s."page_id" ORDER BY s."position", s."created_at") FROM "agent_skill" s WHERE s."agent_id" = a."id"), '[]'::jsonb),
	'schedules', coalesce((
		SELECT jsonb_agg(jsonb_build_object('id', s."id", 'rule', s."rule", 'timeZone', s."time_zone", 'task', coalesce(s."settings"->>'task', ''), 'databaseId', s."database_id") ORDER BY s."created_at", s."id")
		FROM "schedule" s WHERE s."agent_id" = a."id" AND s."kind" = 'agent'
	), '[]'::jsonb),
	'shares', coalesce((
		SELECT jsonb_agg(jsonb_build_object('pageId', p."page_id", 'level', p."level") ORDER BY p."page_id")
		FROM "page_permission" p
		WHERE p."user_id" = a."user_id" AND p."level" IN ('view', 'comment', 'edit')
			AND p."page_id" NOT IN (SELECT d."database_id" FROM "agent_database_share" d WHERE d."agent_id" = a."id")
	), '[]'::jsonb)
)
FROM "workspace_agent" a;
