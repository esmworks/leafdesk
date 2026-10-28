CREATE TABLE "database_change" (
	"id" text PRIMARY KEY NOT NULL,
	"database_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text,
	"actor_kind" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"changed_values" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_change_actor_kind_check" CHECK ("database_change"."actor_kind" in ('user', 'agent', 'automation', 'ai', 'form', 'button')),
	CONSTRAINT "database_change_kind_check" CHECK ("database_change"."kind" in ('property_added', 'property_changed', 'property_deleted', 'property_restored', 'view_added', 'view_changed', 'view_deleted', 'view_restored', 'rows_trashed', 'rows_restored'))
);
--> statement-breakpoint
ALTER TABLE "database_change" ADD CONSTRAINT "database_change_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_change" ADD CONSTRAINT "database_change_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_change" ADD CONSTRAINT "database_change_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_change_database_time_idx" ON "database_change" USING btree ("database_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "database_change_target_idx" ON "database_change" USING btree ("target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "row_activity_database_time_idx" ON "row_activity" USING btree ("database_id","created_at" DESC NULLS LAST);