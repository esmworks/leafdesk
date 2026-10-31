ALTER TABLE "agent_mailbox" ADD COLUMN "on_new_mail" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_mailbox" ADD COLUMN "task" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_mailbox" ADD COLUMN "filters" jsonb DEFAULT '{"senders":[],"subject":"","knownOnly":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_mailbox" ADD COLUMN "limited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_message" ADD COLUMN "automated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_message" ADD COLUMN "agent_marks" jsonb;