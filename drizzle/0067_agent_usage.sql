CREATE TABLE "agent_usage" (
	"agent_id" text NOT NULL,
	"month" date NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_usage_agent_id_month_pk" PRIMARY KEY("agent_id","month")
);
--> statement-breakpoint
ALTER TABLE "workspace_agent" ADD COLUMN "monthly_token_limit" integer;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;