CREATE TABLE "agent_creator" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"group_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_creator_principal_key" UNIQUE NULLS NOT DISTINCT("workspace_id","user_id","group_id"),
	CONSTRAINT "agent_creator_one_principal" CHECK (("agent_creator"."user_id" is null) <> ("agent_creator"."group_id" is null))
);
--> statement-breakpoint
CREATE TABLE "agent_limit_request" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"tokens" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "agent_limit_request_status_check" CHECK ("agent_limit_request"."status" in ('pending', 'approved', 'declined'))
);
--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_subject_check";--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "agent_limit_request_id" text;--> statement-breakpoint
ALTER TABLE "agent_creator" ADD CONSTRAINT "agent_creator_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_creator" ADD CONSTRAINT "agent_creator_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_creator" ADD CONSTRAINT "agent_creator_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_member"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_creator" ADD CONSTRAINT "agent_creator_group_fk" FOREIGN KEY ("group_id","workspace_id") REFERENCES "public"."member_group"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_limit_request" ADD CONSTRAINT "agent_limit_request_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_limit_request" ADD CONSTRAINT "agent_limit_request_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_limit_request" ADD CONSTRAINT "agent_limit_request_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_limit_request" ADD CONSTRAINT "agent_limit_request_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_creator_group_idx" ON "agent_creator" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "agent_limit_request_agent_idx" ON "agent_limit_request" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_limit_request_pending_idx" ON "agent_limit_request" USING btree ("agent_id","requested_by") WHERE "agent_limit_request"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_agent_limit_request_id_agent_limit_request_id_fk" FOREIGN KEY ("agent_limit_request_id") REFERENCES "public"."agent_limit_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_ai_limit_idx" ON "notification" USING btree ("user_id","workspace_id",coalesce("actor_id", ''),"date","message") WHERE "notification"."kind" = 'ai_limit' and "notification"."date" is not null;--> statement-breakpoint
CREATE INDEX "notification_agent_limit_request_idx" ON "notification" USING btree ("agent_limit_request_id") WHERE "notification"."agent_limit_request_id" is not null;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_subject_check" CHECK ("notification"."kind" in ('join_request', 'review', 'agent_approval', 'agent_memory', 'agent_report', 'ai_account_detached', 'ai_limit', 'agent_limit_request') or "notification"."page_id" is not null);