CREATE TABLE "automation_fire" (
	"automation_id" text NOT NULL,
	"row_id" text NOT NULL,
	"basis" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_fire_automation_id_row_id_pk" PRIMARY KEY("automation_id","row_id")
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_event_actor_kind_check";--> statement-breakpoint
ALTER TABLE "automation_run" ADD COLUMN "basis" text;--> statement-breakpoint
ALTER TABLE "database_automation" ADD COLUMN "check_error" text;--> statement-breakpoint
ALTER TABLE "automation_fire" ADD CONSTRAINT "automation_fire_automation_id_database_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."database_automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_fire" ADD CONSTRAINT "automation_fire_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_fire_row_idx" ON "automation_fire" USING btree ("row_id");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_kind_check" CHECK ("audit_event"."actor_kind" in ('user', 'agent', 'api_token', 'connected_app', 'scim', 'system', 'automation'));