CREATE TABLE "synced_block_reference" (
	"page_id" text NOT NULL,
	"source_id" text NOT NULL,
	"sync_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synced_block_reference_page_id_source_id_sync_id_pk" PRIMARY KEY("page_id","source_id","sync_id")
);
--> statement-breakpoint
ALTER TABLE "synced_block_reference" ADD CONSTRAINT "synced_block_reference_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synced_block_reference" ADD CONSTRAINT "synced_block_reference_source_id_page_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "synced_block_reference_source_idx" ON "synced_block_reference" USING btree ("source_id","sync_id");