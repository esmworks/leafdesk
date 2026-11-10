ALTER TABLE "workspace_agent" ADD COLUMN "helpers_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_agent" ADD COLUMN "helpers_set_by" text;--> statement-breakpoint
ALTER TABLE "workspace_agent" ADD COLUMN "reports_to" text;--> statement-breakpoint
ALTER TABLE "workspace_agent" ADD COLUMN "via_manager_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_agent" ADD CONSTRAINT "workspace_agent_helpers_set_by_user_id_fk" FOREIGN KEY ("helpers_set_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent" ADD CONSTRAINT "workspace_agent_reports_to_workspace_agent_id_fk" FOREIGN KEY ("reports_to") REFERENCES "public"."workspace_agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_agent_reports_to_idx" ON "workspace_agent" USING btree ("reports_to");--> statement-breakpoint
-- Agents that already ask chosen agents keep them; the rest ask no one, as before.
UPDATE "workspace_agent" SET "helpers_mode" = 'chosen' WHERE EXISTS (SELECT 1 FROM "agent_helper" WHERE "agent_helper"."agent_id" = "workspace_agent"."id");
