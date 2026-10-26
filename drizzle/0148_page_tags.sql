CREATE TABLE "page_tag" (
	"page_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "page_tag_page_id_key_pk" PRIMARY KEY("page_id","key")
);
--> statement-breakpoint
CREATE TABLE "page_tag_queue" (
	"page_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_tag" ADD CONSTRAINT "page_tag_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tag_queue" ADD CONSTRAINT "page_tag_queue_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_tag_key_idx" ON "page_tag" USING btree ("key" text_pattern_ops);--> statement-breakpoint
-- Pages written before tags were indexed: the tag backfill (server/page-tags.ts) reads each once.
-- A "#" followed by anything but a space or another "#" (a heading's marker is neither).
INSERT INTO "page_tag_queue" ("page_id") SELECT "id" FROM "page" WHERE "content_markdown" ~ '#[^\s#]';
