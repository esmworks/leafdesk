CREATE TABLE "page_verification" (
	"page_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"expired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "page_webhook" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"events" jsonb NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"teamspace_id" text,
	"page_id" text,
	"secret_salt" text NOT NULL,
	"owner_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"paused" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_webhook_scope_check" CHECK ("page_webhook"."scope" in ('workspace', 'teamspace', 'page')),
	CONSTRAINT "page_webhook_scope_target_check" CHECK (("page_webhook"."scope" <> 'teamspace' or "page_webhook"."teamspace_id" is not null) and ("page_webhook"."scope" <> 'page' or "page_webhook"."page_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "page_webhook_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"event" text NOT NULL,
	"page_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"http_status" integer,
	"code" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "page_webhook_delivery_status_check" CHECK ("page_webhook_delivery"."status" in ('pending', 'delivered', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "page_webhook_pending" (
	"page_id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"title" boolean DEFAULT false NOT NULL,
	"body" boolean DEFAULT false NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "verification_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "verification_emails" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "verification_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "verification_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "page_verification" ADD CONSTRAINT "page_verification_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_verification" ADD CONSTRAINT "page_verification_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_verification" ADD CONSTRAINT "page_verification_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_webhook" ADD CONSTRAINT "page_webhook_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_webhook" ADD CONSTRAINT "page_webhook_teamspace_id_teamspace_id_fk" FOREIGN KEY ("teamspace_id") REFERENCES "public"."teamspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_webhook" ADD CONSTRAINT "page_webhook_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_webhook" ADD CONSTRAINT "page_webhook_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_webhook_delivery" ADD CONSTRAINT "page_webhook_delivery_webhook_id_page_webhook_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."page_webhook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_webhook_delivery" ADD CONSTRAINT "page_webhook_delivery_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_webhook_pending" ADD CONSTRAINT "page_webhook_pending_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_webhook_pending" ADD CONSTRAINT "page_webhook_pending_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_verification_workspace_idx" ON "page_verification" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "page_verification_expires_idx" ON "page_verification" USING btree ("expires_at") WHERE "page_verification"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "page_webhook_workspace_idx" ON "page_webhook" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "page_webhook_delivery_due_idx" ON "page_webhook_delivery" USING btree ("next_attempt_at") WHERE "page_webhook_delivery"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "page_webhook_delivery_log_idx" ON "page_webhook_delivery" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "page_webhook_delivery_created_idx" ON "page_webhook_delivery" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "page_webhook_pending_due_idx" ON "page_webhook_pending" USING btree ("due_at");