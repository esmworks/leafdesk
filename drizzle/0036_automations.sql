CREATE TABLE "automation_run" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"row_id" text NOT NULL,
	"actor_id" text,
	"created" boolean DEFAULT false NOT NULL,
	"changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "database_automation" (
	"id" text PRIMARY KEY NOT NULL,
	"database_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_salt" text NOT NULL,
	"run_as" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "automation_id" text;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "automation_emails" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "automation_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_automation_id_database_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."database_automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_automation" ADD CONSTRAINT "database_automation_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_automation" ADD CONSTRAINT "database_automation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_automation" ADD CONSTRAINT "database_automation_run_as_user_id_fk" FOREIGN KEY ("run_as") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_automation" ADD CONSTRAINT "database_automation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_run_due_idx" ON "automation_run" USING btree ("status","next_at");--> statement-breakpoint
CREATE INDEX "automation_run_automation_idx" ON "automation_run" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE INDEX "database_automation_database_idx" ON "database_automation" USING btree ("database_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_automation_id_database_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."database_automation"("id") ON DELETE cascade ON UPDATE no action;