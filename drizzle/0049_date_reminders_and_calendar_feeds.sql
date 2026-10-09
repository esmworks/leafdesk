CREATE TABLE "row_reminder" (
	"row_id" text NOT NULL,
	"property_id" text NOT NULL,
	"date" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "row_reminder_row_id_property_id_date_pk" PRIMARY KEY("row_id","property_id","date")
);
--> statement-breakpoint
CREATE TABLE "calendar_feed" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"view_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "calendar_feed_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "date" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "row_reminder" ADD CONSTRAINT "row_reminder_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_reminder" ADD CONSTRAINT "row_reminder_property_id_database_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."database_property"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_view_id_database_view_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."database_view"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feed_user_view_idx" ON "calendar_feed" USING btree ("user_id","view_id");--> statement-breakpoint
CREATE INDEX "calendar_feed_view_idx" ON "calendar_feed" USING btree ("view_id");--> statement-breakpoint
CREATE INDEX "notification_snoozed_idx" ON "notification" USING btree ("snoozed_until") WHERE "notification"."snoozed_until" is not null;