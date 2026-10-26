CREATE TABLE "web_link_check" (
	"workspace_id" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"http_status" integer,
	"reason" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone,
	"wanted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_link_check_workspace_id_url_pk" PRIMARY KEY("workspace_id","url")
);
--> statement-breakpoint
ALTER TABLE "web_link_check" ADD CONSTRAINT "web_link_check_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_link_check_due_idx" ON "web_link_check" USING btree ("checked_at");