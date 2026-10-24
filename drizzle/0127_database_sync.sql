CREATE TABLE "database_sync" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"database_id" text NOT NULL,
	"source" text NOT NULL,
	"site_url" text NOT NULL,
	"query" jsonb NOT NULL,
	"mapping" jsonb NOT NULL,
	"secrets" text NOT NULL,
	"interval_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"running_until" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_count" integer,
	"last_error" text,
	"last_error_detail" text,
	"run_as" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "database_sync" ADD CONSTRAINT "database_sync_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_sync" ADD CONSTRAINT "database_sync_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_sync" ADD CONSTRAINT "database_sync_run_as_user_id_fk" FOREIGN KEY ("run_as") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_sync" ADD CONSTRAINT "database_sync_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "database_sync_database_idx" ON "database_sync" USING btree ("database_id");--> statement-breakpoint
CREATE INDEX "database_sync_due_idx" ON "database_sync" USING btree ("next_run_at") WHERE "database_sync"."enabled";--> statement-breakpoint
CREATE INDEX "database_sync_workspace_idx" ON "database_sync" USING btree ("workspace_id");