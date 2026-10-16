CREATE TABLE "file_text" (
	"file_id" text PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"extractor_version" integer NOT NULL,
	"text" text NOT NULL,
	"pages" integer,
	"partial" boolean DEFAULT false NOT NULL,
	"failed" boolean DEFAULT false NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_text" ADD CONSTRAINT "file_text_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_text_content_hash_idx" ON "file_text" USING btree ("content_hash");