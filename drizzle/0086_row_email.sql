CREATE TABLE "mail_database" (
	"database_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"property_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"address" text NOT NULL,
	"display_name" text,
	"imap_host" text NOT NULL,
	"imap_port" integer NOT NULL,
	"imap_secure" boolean NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"smtp_secure" boolean NOT NULL,
	"username" text NOT NULL,
	"secret" text NOT NULL,
	"folders" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'connecting' NOT NULL,
	"status_error" text,
	"synced_at" timestamp with time zone,
	"consented_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_status_check" CHECK ("mailbox"."status" in ('connecting', 'ok', 'error'))
);
--> statement-breakpoint
CREATE TABLE "row_email" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"mailbox_id" text,
	"database_id" text NOT NULL,
	"row_id" text NOT NULL,
	"direction" text NOT NULL,
	"message_id" text NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text,
	"to" text[] DEFAULT '{}'::text[] NOT NULL,
	"cc" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"html" text,
	"unverified_sender" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error" text,
	"sent_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "row_email_direction_check" CHECK ("row_email"."direction" in ('in', 'out')),
	CONSTRAINT "row_email_status_check" CHECK ("row_email"."status" in ('received', 'hidden', 'queued', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "row_email_attachment" (
	"row_email_id" text NOT NULL,
	"file_id" text NOT NULL,
	"name" text NOT NULL,
	"content_id" text,
	CONSTRAINT "row_email_attachment_row_email_id_file_id_pk" PRIMARY KEY("row_email_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "row_email_id" text;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "row_email_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "row_email_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "row_email_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_database" ADD CONSTRAINT "mail_database_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_database" ADD CONSTRAINT "mail_database_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_email" ADD CONSTRAINT "row_email_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_email" ADD CONSTRAINT "row_email_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_email" ADD CONSTRAINT "row_email_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_email" ADD CONSTRAINT "row_email_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_email" ADD CONSTRAINT "row_email_sent_by_user_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_email_attachment" ADD CONSTRAINT "row_email_attachment_row_email_id_row_email_id_fk" FOREIGN KEY ("row_email_id") REFERENCES "public"."row_email"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_email_attachment" ADD CONSTRAINT "row_email_attachment_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_database_workspace_idx" ON "mail_database" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_member_idx" ON "mailbox" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "row_email_message_idx" ON "row_email" USING btree ("workspace_id","message_id");--> statement-breakpoint
CREATE INDEX "row_email_row_idx" ON "row_email" USING btree ("row_id","sent_at");--> statement-breakpoint
CREATE INDEX "row_email_queue_idx" ON "row_email" USING btree ("next_attempt_at") WHERE "row_email"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "row_email_attachment_file_idx" ON "row_email_attachment" USING btree ("file_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_row_email_id_row_email_id_fk" FOREIGN KEY ("row_email_id") REFERENCES "public"."row_email"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_row_email_idx" ON "notification" USING btree ("row_email_id") WHERE "notification"."row_email_id" is not null;