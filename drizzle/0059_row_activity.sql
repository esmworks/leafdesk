CREATE TABLE "row_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"row_id" text NOT NULL,
	"database_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text,
	"actor_kind" text NOT NULL,
	"kind" text NOT NULL,
	"property_id" text,
	"property_type" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "row_activity_actor_kind_check" CHECK ("row_activity"."actor_kind" in ('user', 'agent', 'automation', 'form')),
	CONSTRAINT "row_activity_kind_check" CHECK ("row_activity"."kind" in ('created', 'title', 'property')),
	CONSTRAINT "row_activity_property_check" CHECK (("row_activity"."kind" = 'property') = ("row_activity"."property_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "row_activity" ADD CONSTRAINT "row_activity_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_activity" ADD CONSTRAINT "row_activity_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_activity" ADD CONSTRAINT "row_activity_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "row_activity_row_time_idx" ON "row_activity" USING btree ("row_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);