ALTER TABLE "page_snapshot" ADD COLUMN "after_version" text;--> statement-breakpoint
ALTER TABLE "page_snapshot" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "page_snapshot" ADD COLUMN "review_kept" jsonb;