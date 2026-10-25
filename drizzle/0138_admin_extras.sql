ALTER TABLE "workspace_invitation" ADD COLUMN "teamspaces" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_join_request" ADD COLUMN "teamspaces" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_publication" ADD COLUMN "expires_at" timestamp with time zone;