CREATE TABLE "pdf_letterhead" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"header" text DEFAULT '' NOT NULL,
	"footer" text DEFAULT '' NOT NULL,
	"logo_place" text DEFAULT 'left' NOT NULL,
	"accent" text DEFAULT '' NOT NULL,
	"page_numbers" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"logo" "bytea",
	"logo_type" text,
	"logo_updated_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pdf_letterhead" ADD CONSTRAINT "pdf_letterhead_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_letterhead" ADD CONSTRAINT "pdf_letterhead_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pdf_letterhead_name_idx" ON "pdf_letterhead" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "pdf_letterhead_default_idx" ON "pdf_letterhead" USING btree ("workspace_id") WHERE "pdf_letterhead"."is_default";