CREATE TABLE "ai_usage" (
	"workspace_id" text NOT NULL,
	"month" date NOT NULL,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"own_account" boolean NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_workspace_id_month_feature_model_own_account_pk" PRIMARY KEY("workspace_id","month","feature","model","own_account")
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;