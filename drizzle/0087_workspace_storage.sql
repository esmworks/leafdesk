CREATE TABLE "workspace_storage" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"credentials" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"verified_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_storage_kind_check" CHECK ("workspace_storage"."kind" in ('s3', 'gdrive', 'dropbox')),
	CONSTRAINT "workspace_storage_status_check" CHECK ("workspace_storage"."status" in ('active', 'broken', 'disconnected'))
);
--> statement-breakpoint
ALTER TABLE "storage_deletion" DROP CONSTRAINT "storage_deletion_pkey";--> statement-breakpoint
ALTER TABLE "file" ADD COLUMN "storage_id" text;--> statement-breakpoint
ALTER TABLE "file" ADD COLUMN "storage_object_id" text;--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD COLUMN "id" bigserial PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD COLUMN "storage_id" text;--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD COLUMN "storage_object_id" text;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD CONSTRAINT "workspace_storage_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD CONSTRAINT "workspace_storage_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_storage_current_idx" ON "workspace_storage" USING btree ("workspace_id") WHERE "workspace_storage"."status" <> 'disconnected';--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_storage_id_workspace_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."workspace_storage"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD CONSTRAINT "storage_deletion_storage_id_workspace_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."workspace_storage"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_storage_idx" ON "file" USING btree ("storage_id");--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD CONSTRAINT "storage_deletion_object_key" UNIQUE NULLS NOT DISTINCT("storage_id","storage_key");