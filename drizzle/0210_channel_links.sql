CREATE TABLE "channel_link" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"user_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"username" text,
	"display_name" text DEFAULT '' NOT NULL,
	"workspace_id" text,
	"conversation_id" text,
	"mode" text DEFAULT 'ask' NOT NULL,
	"agent_id" text,
	"agent_conversation_id" text,
	"notifications" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_link_code" (
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "channel_link_code_user_id_channel_pk" PRIMARY KEY("user_id","channel"),
	CONSTRAINT "channel_link_code_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "channel_link" ADD CONSTRAINT "channel_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link" ADD CONSTRAINT "channel_link_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link" ADD CONSTRAINT "channel_link_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link" ADD CONSTRAINT "channel_link_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link" ADD CONSTRAINT "channel_link_agent_conversation_id_conversation_id_fk" FOREIGN KEY ("agent_conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_code" ADD CONSTRAINT "channel_link_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_link_user_channel_idx" ON "channel_link" USING btree ("user_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_link_external_user_idx" ON "channel_link" USING btree ("channel","external_user_id");--> statement-breakpoint
CREATE INDEX "channel_link_workspace_idx" ON "channel_link" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "channel_link_conversation_idx" ON "channel_link" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "channel_link_agent_idx" ON "channel_link" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "channel_link_agent_conversation_idx" ON "channel_link" USING btree ("agent_conversation_id");--> statement-breakpoint
-- Links and codes made for Telegram before chat apps shared these tables, kept as they were.
INSERT INTO "channel_link" ("id", "channel", "user_id", "external_user_id", "chat_id", "username", "display_name", "workspace_id", "conversation_id", "mode", "agent_id", "agent_conversation_id", "notifications", "created_at", "last_used_at")
SELECT "id", 'telegram', "user_id", "telegram_user_id", "chat_id", "username", "display_name", "workspace_id", "conversation_id", "mode", "agent_id", "agent_conversation_id", "notifications", "created_at", "last_used_at" FROM "telegram_link";--> statement-breakpoint
INSERT INTO "channel_link_code" ("user_id", "channel", "code_hash", "expires_at")
SELECT "user_id", 'telegram', "code_hash", "expires_at" FROM "telegram_link_code";--> statement-breakpoint
DROP TABLE "telegram_link" CASCADE;--> statement-breakpoint
DROP TABLE "telegram_link_code" CASCADE;