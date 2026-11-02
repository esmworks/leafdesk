ALTER TABLE "notification" DROP CONSTRAINT "notification_subject_check";--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "ai_chat_waiting_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "ai_chat_waiting_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "ai_chat_waiting_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "ai_chat_waiting_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_subject_check" CHECK ("notification"."kind" in ('join_request', 'review', 'agent_approval', 'agent_memory', 'agent_report', 'ai_account_detached', 'ai_limit', 'agent_limit_request', 'ai_reminder', 'agent_task', 'schedule_paused', 'ai_chat_waiting') or "notification"."page_id" is not null);