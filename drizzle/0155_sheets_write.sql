CREATE TABLE "sheets_write" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"row_id" text NOT NULL,
	"created" boolean DEFAULT false NOT NULL,
	"before" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"edited_by" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sheets_write" ADD CONSTRAINT "sheets_write_sync_id_database_sync_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."database_sync"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheets_write" ADD CONSTRAINT "sheets_write_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheets_write" ADD CONSTRAINT "sheets_write_edited_by_user_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sheets_write_row_idx" ON "sheets_write" USING btree ("sync_id","row_id");