CREATE TABLE "booking_link" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"database_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"duration_minutes" integer NOT NULL,
	"weekdays" jsonb NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"buffer_minutes" integer DEFAULT 0 NOT NULL,
	"days_ahead" integer NOT NULL,
	"min_notice_minutes" integer DEFAULT 0 NOT NULL,
	"time_zone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_link_hours_check" CHECK ("booking_link"."start_minute" >= 0 and "booking_link"."end_minute" <= 1440 and "booking_link"."end_minute" - "booking_link"."start_minute" >= "booking_link"."duration_minutes"),
	CONSTRAINT "booking_link_ranges_check" CHECK ("booking_link"."duration_minutes" between 5 and 480 and "booking_link"."buffer_minutes" between 0 and 120 and "booking_link"."days_ahead" between 1 and 60 and "booking_link"."min_notice_minutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "booking_made_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "booking_made_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "booking_made_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "booking_made_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_link" ADD CONSTRAINT "booking_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_link" ADD CONSTRAINT "booking_link_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_link" ADD CONSTRAINT "booking_link_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_link_token_idx" ON "booking_link" USING btree ("token");--> statement-breakpoint
CREATE INDEX "booking_link_user_idx" ON "booking_link" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "booking_link_database_idx" ON "booking_link" USING btree ("database_id");