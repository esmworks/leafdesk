CREATE TABLE "page_task" (
	"page_id" text NOT NULL,
	"block_id" text NOT NULL,
	"user_id" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"date" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_task_page_id_block_id_user_id_pk" PRIMARY KEY("page_id","block_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "page_task_backfill" (
	"page_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_task" ADD CONSTRAINT "page_task_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_task" ADD CONSTRAINT "page_task_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_task_backfill" ADD CONSTRAINT "page_task_backfill_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_task_user_idx" ON "page_task" USING btree ("user_id","updated_at");--> statement-breakpoint
-- Pages written before the index whose Markdown may hold someone's to-do (an unticked to-do and
-- an "@"): server/page-tasks.ts reads each once and indexes what it finds.
INSERT INTO "page_task_backfill" ("page_id")
SELECT "id" FROM "page" WHERE "content_markdown" LIKE '%[ ]%' AND "content_markdown" LIKE '%@%';
