CREATE TABLE "conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text,
	"chat_id" text,
	"title" text DEFAULT '' NOT NULL,
	"model" text,
	"thinking" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"queue" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_file" (
	"file_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"conversation_id" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_memory" DROP CONSTRAINT "ai_memory_conversation_id_ai_conversation_id_fk";
--> statement-breakpoint
ALTER TABLE "telegram_link" DROP CONSTRAINT "telegram_link_conversation_id_ai_conversation_id_fk";
--> statement-breakpoint
ALTER TABLE "telegram_link" DROP CONSTRAINT "telegram_link_agent_conversation_id_agent_conversation_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_file" ADD CONSTRAINT "conversation_file_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_file" ADD CONSTRAINT "conversation_file_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_file" ADD CONSTRAINT "conversation_file_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_file" ADD CONSTRAINT "conversation_file_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_user_idx" ON "conversation" USING btree ("user_id","workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversation_agent_idx" ON "conversation" USING btree ("agent_id","user_id","chat_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversation_file_user_idx" ON "conversation_file" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "conversation_file_conversation_idx" ON "conversation_file" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_file_run_idx" ON "conversation_file" USING btree ("run_id");--> statement-breakpoint
INSERT INTO "conversation" ("id", "user_id", "workspace_id", "agent_id", "chat_id", "title", "model", "thinking", "messages", "queue", "created_at", "updated_at")
  SELECT "id", "user_id", "workspace_id", NULL, NULL, "title", "model", "thinking", "messages", '[]'::jsonb, "created_at", "updated_at" FROM "ai_conversation";--> statement-breakpoint
INSERT INTO "conversation" ("id", "user_id", "workspace_id", "agent_id", "chat_id", "title", "model", "thinking", "messages", "queue", "created_at", "updated_at")
  SELECT "id", "user_id", "workspace_id", "agent_id", "chat_id", "title", NULL, NULL, "messages", "queue", "created_at", "updated_at" FROM "agent_conversation";--> statement-breakpoint
INSERT INTO "conversation_file" ("file_id", "user_id", "workspace_id", "conversation_id", "run_id", "created_at")
  SELECT "file_id", "user_id", "workspace_id", "conversation_id", NULL, "created_at" FROM "ai_chat_file";--> statement-breakpoint
INSERT INTO "conversation_file" ("file_id", "user_id", "workspace_id", "conversation_id", "run_id", "created_at")
  SELECT "file_id", "user_id", "workspace_id", "conversation_id", "run_id", "created_at" FROM "agent_chat_file";--> statement-breakpoint
ALTER TABLE "ai_memory" ADD CONSTRAINT "ai_memory_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link" ADD CONSTRAINT "telegram_link_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link" ADD CONSTRAINT "telegram_link_agent_conversation_id_conversation_id_fk" FOREIGN KEY ("agent_conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;