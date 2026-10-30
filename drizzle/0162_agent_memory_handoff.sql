ALTER TABLE "ai_memory" ADD COLUMN "replaces_id" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "handoff" text;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD CONSTRAINT "ai_memory_replaces_id_ai_memory_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."ai_memory"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Proposals were announced once per run: an owner keeps one item per agent from now on, the oldest.
DELETE FROM "notification" n USING "notification" o
WHERE n."kind" = 'agent_memory' AND o."kind" = 'agent_memory' AND o."user_id" = n."user_id" AND o."actor_id" = n."actor_id"
  AND o."workspace_id" = n."workspace_id" AND (o."created_at", o."id") < (n."created_at", n."id");
