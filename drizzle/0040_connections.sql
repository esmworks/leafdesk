CREATE TABLE "agent_grant" (
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_grant_agent_id_connection_id_pk" PRIMARY KEY("agent_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"slug" text NOT NULL,
	"url" text NOT NULL,
	"auth_type" text NOT NULL,
	"secrets" text,
	"status" text DEFAULT 'needsAuth' NOT NULL,
	"status_error" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kinds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tools_at" timestamp with time zone,
	"event_preset" text DEFAULT 'hmac' NOT NULL,
	"event_secret" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_event" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_oauth" (
	"state" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"user_id" text NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_trigger" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"event_type" text,
	"prompt" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_subject_check";--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "agent_run_id" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "state" jsonb;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "pending" jsonb;--> statement-breakpoint
ALTER TABLE "agent_grant" ADD CONSTRAINT "agent_grant_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grant" ADD CONSTRAINT "agent_grant_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_event" ADD CONSTRAINT "connection_event_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD CONSTRAINT "connection_oauth_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD CONSTRAINT "connection_oauth_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_trigger" ADD CONSTRAINT "connection_trigger_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_trigger" ADD CONSTRAINT "connection_trigger_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_trigger" ADD CONSTRAINT "connection_trigger_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_slug_idx" ON "connection" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_event_delivery_idx" ON "connection_event" USING btree ("connection_id","delivery_id");--> statement-breakpoint
CREATE INDEX "connection_event_received_idx" ON "connection_event" USING btree ("connection_id","received_at");--> statement-breakpoint
CREATE INDEX "connection_trigger_connection_idx" ON "connection_trigger" USING btree ("connection_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_agent_run_idx" ON "notification" USING btree ("agent_run_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_subject_check" CHECK ("notification"."kind" in ('join_request', 'agent_approval') or "notification"."page_id" is not null);