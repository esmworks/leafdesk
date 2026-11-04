ALTER TABLE "page_task" ADD COLUMN "remind_at" timestamp with time zone;--> statement-breakpoint
-- Pages already holding to-dos are read again, so their reminders reach the new column.
INSERT INTO "page_task_backfill" ("page_id") SELECT DISTINCT "page_id" FROM "page_task" ON CONFLICT DO NOTHING;
