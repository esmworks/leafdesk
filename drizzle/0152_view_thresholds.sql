CREATE TABLE "automation_threshold" (
	"automation_id" text PRIMARY KEY NOT NULL,
	"met" boolean NOT NULL,
	"value" double precision,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_threshold" ADD CONSTRAINT "automation_threshold_automation_id_database_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."database_automation"("id") ON DELETE cascade ON UPDATE no action;