CREATE TABLE "github_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"signature" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"status" text NOT NULL,
	"pull_request" jsonb,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_sync" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"database_id" text NOT NULL,
	"secret" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"run_as" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_delivery" ADD CONSTRAINT "github_delivery_sync_id_github_sync_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."github_sync"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_sync" ADD CONSTRAINT "github_sync_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_sync" ADD CONSTRAINT "github_sync_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_sync" ADD CONSTRAINT "github_sync_run_as_user_id_fk" FOREIGN KEY ("run_as") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_sync" ADD CONSTRAINT "github_sync_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_delivery_delivery_idx" ON "github_delivery" USING btree ("sync_id","delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_delivery_signature_idx" ON "github_delivery" USING btree ("sync_id","signature");--> statement-breakpoint
CREATE INDEX "github_delivery_received_idx" ON "github_delivery" USING btree ("sync_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "github_sync_database_idx" ON "github_sync" USING btree ("database_id");--> statement-breakpoint
CREATE INDEX "github_sync_workspace_idx" ON "github_sync" USING btree ("workspace_id");