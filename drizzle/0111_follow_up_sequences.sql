CREATE TABLE "email_sequence" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"database_id" text NOT NULL,
	"name" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"send_window" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_enrollment" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"database_id" text NOT NULL,
	"row_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone,
	"paused_until" timestamp with time zone,
	"reason" text,
	"problems" jsonb,
	"pending_change_id" text,
	"last_email_id" text,
	"sent" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"enrolled_by" text,
	"stopped_by" text,
	"claimed_until" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "sequence_enrollment_status_check" CHECK ("sequence_enrollment"."status" in ('active', 'waiting', 'paused', 'finished', 'stopped'))
);
--> statement-breakpoint
CREATE TABLE "sequence_send" (
	"enrollment_id" text NOT NULL,
	"step" integer NOT NULL,
	"row_email_id" text,
	"mailbox_id" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_send_enrollment_id_step_pk" PRIMARY KEY("enrollment_id","step")
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "sequence_enrollment_id" text;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "follow_up_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "follow_up_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "follow_up_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "follow_up_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "follow_up_daily_limit" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "follow_up_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_sequence" ADD CONSTRAINT "email_sequence_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sequence" ADD CONSTRAINT "email_sequence_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sequence" ADD CONSTRAINT "email_sequence_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_sequence_id_email_sequence_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."email_sequence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_sender_id_user_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_pending_change_id_pending_change_id_fk" FOREIGN KEY ("pending_change_id") REFERENCES "public"."pending_change"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_last_email_id_row_email_id_fk" FOREIGN KEY ("last_email_id") REFERENCES "public"."row_email"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_enrolled_by_user_id_fk" FOREIGN KEY ("enrolled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_stopped_by_user_id_fk" FOREIGN KEY ("stopped_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_send" ADD CONSTRAINT "sequence_send_enrollment_id_sequence_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."sequence_enrollment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_send" ADD CONSTRAINT "sequence_send_row_email_id_row_email_id_fk" FOREIGN KEY ("row_email_id") REFERENCES "public"."row_email"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_send" ADD CONSTRAINT "sequence_send_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_sequence_database_idx" ON "email_sequence" USING btree ("database_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_enrollment_open_idx" ON "sequence_enrollment" USING btree ("sequence_id","row_id") WHERE "sequence_enrollment"."status" in ('active', 'waiting', 'paused');--> statement-breakpoint
CREATE INDEX "sequence_enrollment_due_idx" ON "sequence_enrollment" USING btree ("next_at") WHERE "sequence_enrollment"."status" = 'active';--> statement-breakpoint
CREATE INDEX "sequence_enrollment_row_idx" ON "sequence_enrollment" USING btree ("row_id","started_at");--> statement-breakpoint
CREATE INDEX "sequence_enrollment_sender_idx" ON "sequence_enrollment" USING btree ("sender_id","workspace_id");--> statement-breakpoint
CREATE INDEX "sequence_enrollment_ended_idx" ON "sequence_enrollment" USING btree ("ended_at") WHERE "sequence_enrollment"."ended_at" is not null;--> statement-breakpoint
CREATE INDEX "sequence_send_mailbox_idx" ON "sequence_send" USING btree ("mailbox_id","sent_at");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_sequence_enrollment_id_sequence_enrollment_id_fk" FOREIGN KEY ("sequence_enrollment_id") REFERENCES "public"."sequence_enrollment"("id") ON DELETE cascade ON UPDATE no action;