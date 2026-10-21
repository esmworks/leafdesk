ALTER TABLE "page" ADD COLUMN "outdated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "outdated_by" text;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_outdated_by_user_id_fk" FOREIGN KEY ("outdated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_outdated_idx" ON "page" USING btree ("workspace_id") WHERE "page"."outdated_at" is not null;