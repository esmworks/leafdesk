ALTER TABLE "page_publication" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_site" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "workspace_site" ADD COLUMN "theme" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_site" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_site" ADD COLUMN "header_links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_site" ADD COLUMN "analytics_id" text;--> statement-breakpoint
ALTER TABLE "workspace_site" ADD CONSTRAINT "workspace_site_domain_unique" UNIQUE("domain");