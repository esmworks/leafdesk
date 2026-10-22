CREATE TABLE "agent_share" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"group_id" text,
	"level" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_share_principal_key" UNIQUE NULLS NOT DISTINCT("agent_id","user_id","group_id"),
	CONSTRAINT "agent_share_level_check" CHECK ("agent_share"."level" in ('full', 'edit', 'interact')),
	CONSTRAINT "agent_share_one_principal" CHECK ("agent_share"."user_id" is null or "agent_share"."group_id" is null)
);
--> statement-breakpoint
ALTER TABLE "agent_share" ADD CONSTRAINT "agent_share_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_share" ADD CONSTRAINT "agent_share_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_share" ADD CONSTRAINT "agent_share_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_share" ADD CONSTRAINT "agent_share_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_member"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_share" ADD CONSTRAINT "agent_share_group_fk" FOREIGN KEY ("group_id","workspace_id") REFERENCES "public"."member_group"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_share_user_idx" ON "agent_share" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_share_group_idx" ON "agent_share" USING btree ("group_id");--> statement-breakpoint
-- Agents made before sharing: everyone in the workspace can view and interact with them (as any
-- member could chat with them in a block and mention them), and whoever created one, while still an
-- owner or member of its workspace, has full access.
INSERT INTO "agent_share" ("id", "agent_id", "workspace_id", "level", "created_by")
SELECT gen_random_uuid()::text, a."id", a."workspace_id", 'interact', a."created_by" FROM "workspace_agent" a;--> statement-breakpoint
INSERT INTO "agent_share" ("id", "agent_id", "workspace_id", "user_id", "level", "created_by")
SELECT gen_random_uuid()::text, a."id", a."workspace_id", a."created_by", 'full', a."created_by"
FROM "workspace_agent" a
JOIN "workspace_member" m ON m."workspace_id" = a."workspace_id" AND m."user_id" = a."created_by" AND m."role" <> 'guest';
