ALTER TABLE "telegram_link" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "telegram_link" ADD COLUMN "agent_conversation_id" text;--> statement-breakpoint
ALTER TABLE "telegram_link" ADD CONSTRAINT "telegram_link_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link" ADD CONSTRAINT "telegram_link_agent_conversation_id_agent_conversation_id_fk" FOREIGN KEY ("agent_conversation_id") REFERENCES "public"."agent_conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_link_agent_idx" ON "telegram_link" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "telegram_link_agent_conversation_idx" ON "telegram_link" USING btree ("agent_conversation_id");