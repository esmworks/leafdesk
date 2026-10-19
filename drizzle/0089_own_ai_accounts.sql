CREATE TABLE "ai_account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"api_key" text,
	"key_hint" text,
	"embeddings_model" text,
	"stt_model" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_account_provider_check" CHECK ("ai_account"."provider" in ('anthropic', 'openai', 'google', 'opencode-go', 'openai-compatible')),
	CONSTRAINT "ai_account_status_check" CHECK ("ai_account"."status" in ('active', 'broken'))
);
--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_subject_check";--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "ai_account_id" text;--> statement-breakpoint
ALTER TABLE "ai_account" ADD CONSTRAINT "ai_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_account_user_idx" ON "ai_account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_account_default_idx" ON "ai_account" USING btree ("user_id") WHERE "ai_account"."is_default";--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_ai_account_id_ai_account_id_fk" FOREIGN KEY ("ai_account_id") REFERENCES "public"."ai_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_subject_check" CHECK ("notification"."kind" in ('join_request', 'agent_approval', 'agent_memory', 'agent_report', 'ai_account_detached') or "notification"."page_id" is not null);