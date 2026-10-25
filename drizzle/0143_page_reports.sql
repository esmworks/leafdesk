CREATE TABLE "page_report" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"page_id" text NOT NULL,
	"published_page_id" text NOT NULL,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"email" text,
	"reporter_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone,
	"handled_by" text,
	CONSTRAINT "page_report_status_check" CHECK ("page_report"."status" in ('open', 'dismissed', 'unpublished'))
);
--> statement-breakpoint
ALTER TABLE "page_report" ADD CONSTRAINT "page_report_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_report" ADD CONSTRAINT "page_report_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_report" ADD CONSTRAINT "page_report_published_page_id_page_id_fk" FOREIGN KEY ("published_page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_report" ADD CONSTRAINT "page_report_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_report" ADD CONSTRAINT "page_report_handled_by_user_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_report_workspace_idx" ON "page_report" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "page_report_page_idx" ON "page_report" USING btree ("page_id");