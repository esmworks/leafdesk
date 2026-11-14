CREATE TABLE "agent_chain_run" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"started_by" text,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"run_id" text,
	"code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_chain_run" ADD CONSTRAINT "agent_chain_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chain_run" ADD CONSTRAINT "agent_chain_run_schedule_id_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chain_run" ADD CONSTRAINT "agent_chain_run_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chain_run" ADD CONSTRAINT "agent_chain_run_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_chain_run_schedule_idx" ON "agent_chain_run" USING btree ("schedule_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chain_run_going_idx" ON "agent_chain_run" USING btree ("schedule_id") WHERE "agent_chain_run"."status" = 'running';