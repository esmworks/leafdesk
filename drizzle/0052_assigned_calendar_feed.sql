ALTER TABLE "calendar_feed" ALTER COLUMN "view_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feed_user_assigned_idx" ON "calendar_feed" USING btree ("user_id","workspace_id") WHERE "calendar_feed"."view_id" is null;--> statement-breakpoint
CREATE INDEX "calendar_feed_workspace_idx" ON "calendar_feed" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_target_check" CHECK (("calendar_feed"."view_id" is null) <> ("calendar_feed"."workspace_id" is null));