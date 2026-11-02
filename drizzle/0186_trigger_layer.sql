ALTER TABLE "notification" DROP CONSTRAINT "notification_subject_check";--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "schedule_paused_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "schedule_paused_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "schedule_paused_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "schedule_paused_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_key_idx" ON "conversation" USING btree ("user_id","workspace_id",coalesce("agent_id", ''),"key") WHERE "conversation"."key" is not null;--> statement-breakpoint
CREATE INDEX "agent_run_conversation_idx" ON "agent_run" USING btree ("conversation_id") WHERE "agent_run"."conversation_id" is not null;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_subject_check" CHECK ("notification"."kind" in ('join_request', 'review', 'agent_approval', 'agent_memory', 'agent_report', 'ai_account_detached', 'ai_limit', 'agent_limit_request', 'ai_reminder', 'agent_task', 'schedule_paused') or "notification"."page_id" is not null);