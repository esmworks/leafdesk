CREATE TABLE "ai_usage_person" (
	"workspace_id" text NOT NULL,
	"month" date NOT NULL,
	"user_id" text,
	"feature" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_person_key" UNIQUE NULLS NOT DISTINCT("workspace_id","month","user_id","feature")
);
--> statement-breakpoint
ALTER TABLE "ai_usage_person" ADD CONSTRAINT "ai_usage_person_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_person" ADD CONSTRAINT "ai_usage_person_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;