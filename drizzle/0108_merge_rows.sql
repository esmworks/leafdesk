ALTER TABLE "row_activity" DROP CONSTRAINT "row_activity_kind_check";--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "merged_into_id" text;--> statement-breakpoint
ALTER TABLE "row_activity" ADD COLUMN "merged_from_id" text;--> statement-breakpoint
ALTER TABLE "row_activity" ADD COLUMN "merged_from_title" text;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_merged_into_id_page_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."page"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_merged_into_idx" ON "page" USING btree ("merged_into_id") WHERE "page"."merged_into_id" is not null;--> statement-breakpoint
ALTER TABLE "row_activity" ADD CONSTRAINT "row_activity_kind_check" CHECK ("row_activity"."kind" in ('created', 'title', 'property', 'merged'));