ALTER TABLE "notification" DROP CONSTRAINT "notification_subject_check";--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "agent_task_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "agent_task_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "agent_task_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "agent_task_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_run_task_idx" ON "agent_run" USING btree (("source"->>'fromAgentId'),"created_at") WHERE "agent_run"."source"->>'kind' = 'handoff' and "agent_run"."source"->>'queued' = 'true';--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_subject_check" CHECK ("notification"."kind" in ('join_request', 'review', 'agent_approval', 'agent_memory', 'agent_report', 'ai_account_detached', 'ai_limit', 'agent_limit_request', 'ai_reminder', 'agent_task') or "notification"."page_id" is not null);