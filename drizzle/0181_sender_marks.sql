CREATE TABLE "mail_sender_logo" (
	"domain" text PRIMARY KEY NOT NULL,
	"image" "bytea",
	"image_type" text,
	"checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_message" ADD COLUMN "sender_auth" text;--> statement-breakpoint
CREATE INDEX "mail_sender_logo_due_idx" ON "mail_sender_logo" USING btree ("next_check_at");