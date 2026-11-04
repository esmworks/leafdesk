CREATE TABLE "row_repeat" (
	"row_id" text PRIMARY KEY NOT NULL,
	"database_id" text NOT NULL,
	"property_id" text NOT NULL,
	"rule" jsonb NOT NULL,
	"time_zone" text NOT NULL,
	"set_by" text,
	"chain_id" text NOT NULL,
	"previous_row_id" text,
	"made_hash" text,
	"spawn_day" text,
	"spawn_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "row_repeat" ADD CONSTRAINT "row_repeat_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_repeat" ADD CONSTRAINT "row_repeat_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_repeat" ADD CONSTRAINT "row_repeat_property_id_database_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."database_property"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_repeat" ADD CONSTRAINT "row_repeat_set_by_user_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_repeat" ADD CONSTRAINT "row_repeat_previous_row_id_page_id_fk" FOREIGN KEY ("previous_row_id") REFERENCES "public"."page"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "row_repeat_database_idx" ON "row_repeat" USING btree ("database_id");--> statement-breakpoint
CREATE INDEX "row_repeat_previous_idx" ON "row_repeat" USING btree ("previous_row_id");