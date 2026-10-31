CREATE TABLE "mail_snooze" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"woke_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_snooze" ADD CONSTRAINT "mail_snooze_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_snooze_thread_idx" ON "mail_snooze" USING btree ("mailbox_id","thread_id");--> statement-breakpoint
CREATE INDEX "mail_snooze_due_idx" ON "mail_snooze" USING btree ("until") WHERE "mail_snooze"."woke_at" is null;