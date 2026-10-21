CREATE TABLE "agent_conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_id" text,
	"title" text DEFAULT '' NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_conversation" ADD CONSTRAINT "agent_conversation_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_conversation" ADD CONSTRAINT "agent_conversation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_conversation" ADD CONSTRAINT "agent_conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_conversation_user_idx" ON "agent_conversation" USING btree ("user_id","agent_id","chat_id","updated_at");