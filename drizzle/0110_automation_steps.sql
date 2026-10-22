CREATE TABLE "automation_version" (
	"automation_id" text NOT NULL,
	"version" integer NOT NULL,
	"trigger" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_version_automation_id_version_pk" PRIMARY KEY("automation_id","version")
);
--> statement-breakpoint
ALTER TABLE "automation_run" ALTER COLUMN "row_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "message" text;--> statement-breakpoint
ALTER TABLE "automation_run" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "automation_run" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_run" ADD COLUMN "test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_run" ADD COLUMN "definition" jsonb;--> statement-breakpoint
ALTER TABLE "automation_run" ADD COLUMN "trigger_data" jsonb;--> statement-breakpoint
ALTER TABLE "automation_run" ADD COLUMN "state" jsonb;--> statement-breakpoint
ALTER TABLE "database_automation" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "database_automation" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "database_automation" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "database_automation" ADD COLUMN "hook_salt" text;--> statement-breakpoint
ALTER TABLE "automation_version" ADD CONSTRAINT "automation_version_automation_id_database_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."database_automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_version" ADD CONSTRAINT "automation_version_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_automation_next_run_idx" ON "database_automation" USING btree ("next_run_at");--> statement-breakpoint
-- Automations saved before versions become their version 1, which their waiting runs carry on with.
INSERT INTO "automation_version" ("automation_id", "version", "trigger", "actions", "time_zone", "published_by", "published_at")
SELECT "id", 1, "trigger", "actions", "time_zone", "run_as", "updated_at" FROM "database_automation"
ON CONFLICT DO NOTHING;
