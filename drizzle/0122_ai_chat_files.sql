CREATE TABLE "ai_chat_file" (
	"file_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"conversation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_conversation" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "ai_chat_file" ADD CONSTRAINT "ai_chat_file_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_file" ADD CONSTRAINT "ai_chat_file_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_file" ADD CONSTRAINT "ai_chat_file_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_file" ADD CONSTRAINT "ai_chat_file_conversation_id_ai_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_chat_file_user_idx" ON "ai_chat_file" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "ai_chat_file_conversation_idx" ON "ai_chat_file" USING btree ("conversation_id");