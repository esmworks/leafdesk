CREATE TABLE "mail_folder" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"delimiter" text,
	"uid_validity" text DEFAULT '' NOT NULL,
	"last_uid" integer DEFAULT 0 NOT NULL,
	"oldest_uid" integer DEFAULT 0 NOT NULL,
	"modseq" text,
	"unseen" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mail_message" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"uid" integer NOT NULL,
	"message_id" text,
	"thread_id" text NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"from_address" text DEFAULT '' NOT NULL,
	"from_name" text,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"subject_key" text DEFAULT '' NOT NULL,
	"preview" text DEFAULT '' NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"size" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_folder" ADD CONSTRAINT "mail_folder_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_message" ADD CONSTRAINT "mail_message_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_message" ADD CONSTRAINT "mail_message_folder_id_mail_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."mail_folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_folder_path_idx" ON "mail_folder" USING btree ("mailbox_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_message_uid_idx" ON "mail_message" USING btree ("folder_id","uid");--> statement-breakpoint
CREATE INDEX "mail_message_folder_idx" ON "mail_message" USING btree ("folder_id","sent_at");--> statement-breakpoint
CREATE INDEX "mail_message_thread_idx" ON "mail_message" USING btree ("mailbox_id","thread_id");--> statement-breakpoint
CREATE INDEX "mail_message_id_idx" ON "mail_message" USING btree ("mailbox_id","message_id");--> statement-breakpoint
CREATE INDEX "mail_message_subject_idx" ON "mail_message" USING btree ("mailbox_id","subject_key","sent_at");--> statement-breakpoint
CREATE INDEX "mail_message_reply_idx" ON "mail_message" USING btree ("mailbox_id","in_reply_to");--> statement-breakpoint
CREATE INDEX "mail_message_references_idx" ON "mail_message" USING gin ("references");