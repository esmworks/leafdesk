ALTER TABLE "notification" DROP CONSTRAINT "notification_subject_check";--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_agent_idx" ON "schedule" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_subject_check" CHECK ("notification"."kind" in ('join_request', 'agent_approval', 'agent_memory', 'agent_report') or "notification"."page_id" is not null);