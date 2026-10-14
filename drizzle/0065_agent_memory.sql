ALTER TABLE "ai_memory" ADD COLUMN "status" text DEFAULT 'kept' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD COLUMN "agent_run_id" text;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD CONSTRAINT "ai_memory_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;