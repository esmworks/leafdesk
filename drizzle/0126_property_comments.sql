CREATE TABLE "property_comment" (
	"page_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"threads" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "row_activity" DROP CONSTRAINT "row_activity_actor_kind_check";--> statement-breakpoint
ALTER TABLE "property_comment" ADD CONSTRAINT "property_comment_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_comment" ADD CONSTRAINT "property_comment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_activity" ADD CONSTRAINT "row_activity_actor_kind_check" CHECK ("row_activity"."actor_kind" in ('user', 'agent', 'automation', 'ai', 'form', 'button'));