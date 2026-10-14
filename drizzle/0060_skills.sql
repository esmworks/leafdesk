ALTER TABLE "page" ADD COLUMN "is_skill" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "skill_description" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "page_skill_idx" ON "page" USING btree ("workspace_id") WHERE "page"."is_skill";