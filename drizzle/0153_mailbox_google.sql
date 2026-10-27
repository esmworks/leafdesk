CREATE TABLE "mailbox_oauth" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "auth" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_oauth" ADD CONSTRAINT "mailbox_oauth_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_oauth" ADD CONSTRAINT "mailbox_oauth_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_auth_check" CHECK ("mailbox"."auth" in ('password', 'google'));