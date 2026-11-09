CREATE TABLE "channel_webhook" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"hint" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channel_webhook" ADD CONSTRAINT "channel_webhook_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_webhook" ADD CONSTRAINT "channel_webhook_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_webhook" ADD CONSTRAINT "channel_webhook_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_webhook_channel_idx" ON "channel_webhook" USING btree ("channel_id");