CREATE TABLE "pending_change" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"database_id" text NOT NULL,
	"row_id" text,
	"payload" jsonb NOT NULL,
	"edited_payload" jsonb,
	"before" jsonb,
	"reason" text DEFAULT '' NOT NULL,
	"source" jsonb NOT NULL,
	"agent_id" text,
	"agent_run_id" text,
	"proposed_by" text,
	"sender_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"result_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pending_change_kind_check" CHECK ("pending_change"."kind" in ('create_row', 'update_row', 'email_draft')),
	CONSTRAINT "pending_change_status_check" CHECK ("pending_change"."status" in ('pending', 'approved', 'dismissed', 'expired', 'failed')),
	CONSTRAINT "pending_change_row_check" CHECK ("pending_change"."kind" = 'create_row' or "pending_change"."row_id" is not null),
	CONSTRAINT "pending_change_sender_check" CHECK ("pending_change"."kind" <> 'email_draft' or "pending_change"."sender_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_subject_check";--> statement-breakpoint
ALTER TABLE "row_activity" ADD COLUMN "proposed_by" text;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "review_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "review_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "review_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "review_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_agent" ADD COLUMN "row_changes" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_proposed_by_user_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_sender_id_user_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_change_queue_idx" ON "pending_change" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "pending_change_row_idx" ON "pending_change" USING btree ("row_id","status");--> statement-breakpoint
CREATE INDEX "pending_change_expiry_idx" ON "pending_change" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "pending_change_run_idx" ON "pending_change" USING btree ("agent_run_id");--> statement-breakpoint
ALTER TABLE "row_activity" ADD CONSTRAINT "row_activity_proposed_by_user_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_subject_check" CHECK ("notification"."kind" in ('join_request', 'review', 'agent_approval', 'agent_memory', 'agent_report', 'ai_account_detached') or "notification"."page_id" is not null);