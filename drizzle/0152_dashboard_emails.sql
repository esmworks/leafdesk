ALTER TABLE "schedule" ADD COLUMN "page_id" text;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_page_idx" ON "schedule" USING btree ("page_id");