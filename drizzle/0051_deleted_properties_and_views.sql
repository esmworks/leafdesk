ALTER TABLE "database_property" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "database_property" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "database_view" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "database_view" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "database_property" ADD CONSTRAINT "database_property_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_view" ADD CONSTRAINT "database_view_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_property_deleted_idx" ON "database_property" USING btree ("deleted_at") WHERE "database_property"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "database_view_deleted_idx" ON "database_view" USING btree ("deleted_at") WHERE "database_view"."deleted_at" is not null;