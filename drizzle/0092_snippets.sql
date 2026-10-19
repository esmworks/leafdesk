CREATE TABLE "snippet" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"workspace_id" text,
	"trigger" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snippet_scope_check" CHECK (("snippet"."user_id" is null) <> ("snippet"."workspace_id" is null)),
	CONSTRAINT "snippet_trigger_check" CHECK ("snippet"."trigger" ~ '^[a-z0-9_-]{1,32}$')
);
--> statement-breakpoint
ALTER TABLE "snippet" ADD CONSTRAINT "snippet_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snippet" ADD CONSTRAINT "snippet_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snippet" ADD CONSTRAINT "snippet_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "snippet_user_trigger_idx" ON "snippet" USING btree ("user_id","trigger") WHERE "snippet"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "snippet_workspace_trigger_idx" ON "snippet" USING btree ("workspace_id","trigger") WHERE "snippet"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX "snippet_created_by_idx" ON "snippet" USING btree ("created_by");