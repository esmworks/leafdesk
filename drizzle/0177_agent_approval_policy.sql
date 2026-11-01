CREATE TABLE "agent_daily_change" (
	"agent_id" text NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_daily_change_agent_id_day_pk" PRIMARY KEY("agent_id","day")
);
--> statement-breakpoint
CREATE TABLE "agent_tool_rule" (
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"tool" text NOT NULL,
	"rule" text NOT NULL,
	"set_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_rule_agent_id_connection_id_tool_pk" PRIMARY KEY("agent_id","connection_id","tool"),
	CONSTRAINT "agent_tool_rule_rule_check" CHECK ("agent_tool_rule"."rule" in ('allow', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "workspace_agent" ADD COLUMN "quiet_hours" jsonb;--> statement-breakpoint
ALTER TABLE "workspace_agent" ADD COLUMN "daily_change_limit" integer;--> statement-breakpoint
ALTER TABLE "agent_daily_change" ADD CONSTRAINT "agent_daily_change_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_rule" ADD CONSTRAINT "agent_tool_rule_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_rule" ADD CONSTRAINT "agent_tool_rule_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_rule" ADD CONSTRAINT "agent_tool_rule_set_by_user_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;