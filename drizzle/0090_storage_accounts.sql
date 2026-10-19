CREATE TABLE "storage_account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"credentials" text NOT NULL,
	"label" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_account_kind_check" CHECK ("storage_account"."kind" in ('s3', 'gdrive', 'dropbox')),
	CONSTRAINT "storage_account_status_check" CHECK ("storage_account"."status" in ('active', 'broken', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "storage_move" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"from_storage_ids" text[],
	"to_server" boolean DEFAULT false NOT NULL,
	"to_account_id" text,
	"to_storage_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text NOT NULL,
	"leaver_id" text,
	"files" integer DEFAULT 0 NOT NULL,
	"moved" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_until" timestamp with time zone,
	"started_by" text,
	"dismissed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "storage_move_status_check" CHECK ("storage_move"."status" in ('queued', 'running', 'done', 'failed', 'blocked')),
	CONSTRAINT "storage_move_reason_check" CHECK ("storage_move"."reason" in ('manual', 'left', 'removed', 'accountDeleted', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "storage_oauth" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"workspace_id" text,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD COLUMN "move_id" text;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD COLUMN "storage_account_id" text;--> statement-breakpoint
ALTER TABLE "storage_account" ADD CONSTRAINT "storage_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_move" ADD CONSTRAINT "storage_move_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_move" ADD CONSTRAINT "storage_move_to_account_id_storage_account_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."storage_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_move" ADD CONSTRAINT "storage_move_to_storage_id_workspace_storage_id_fk" FOREIGN KEY ("to_storage_id") REFERENCES "public"."workspace_storage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_move" ADD CONSTRAINT "storage_move_leaver_id_user_id_fk" FOREIGN KEY ("leaver_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_move" ADD CONSTRAINT "storage_move_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_oauth" ADD CONSTRAINT "storage_oauth_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_oauth" ADD CONSTRAINT "storage_oauth_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_account_user_idx" ON "storage_account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_account_default_idx" ON "storage_account" USING btree ("user_id") WHERE "storage_account"."is_default" and "storage_account"."status" <> 'disconnected';--> statement-breakpoint
CREATE INDEX "storage_move_workspace_idx" ON "storage_move" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_move_open_idx" ON "storage_move" USING btree ("workspace_id") WHERE "storage_move"."status" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD CONSTRAINT "storage_deletion_move_id_storage_move_id_fk" FOREIGN KEY ("move_id") REFERENCES "public"."storage_move"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD CONSTRAINT "workspace_storage_storage_account_id_storage_account_id_fk" FOREIGN KEY ("storage_account_id") REFERENCES "public"."storage_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_deletion_move_idx" ON "storage_deletion" USING btree ("move_id");--> statement-breakpoint
CREATE INDEX "workspace_storage_account_idx" ON "workspace_storage" USING btree ("storage_account_id");
--> statement-breakpoint
-- Each workspace's own storage becomes a storage account of whoever connected it, with its
-- credentials and how it is doing; the workspace keeps only its place there (a Drive folder).
INSERT INTO "storage_account" ("id", "user_id", "kind", "config", "credentials", "label", "is_default", "status", "last_error", "last_error_at", "verified_at", "created_at", "updated_at")
SELECT
	"id",
	"created_by",
	"kind",
	CASE WHEN "kind" = 'gdrive' THEN "config" - 'folderId' - 'folderName' ELSE "config" END,
	"credentials",
	coalesce(CASE WHEN "kind" = 's3' THEN "config" ->> 'bucket' ELSE "config" ->> 'account' END, "kind"),
	false,
	"status",
	"last_error",
	"last_error_at",
	"verified_at",
	"created_at",
	"updated_at"
FROM "workspace_storage";--> statement-breakpoint
UPDATE "workspace_storage" SET
	"storage_account_id" = "id",
	"config" = CASE WHEN "kind" = 'gdrive' THEN jsonb_build_object('folderId', "config" -> 'folderId', 'folderName', "config" -> 'folderName') ELSE '{}'::jsonb END,
	"status" = CASE WHEN "status" = 'broken' THEN 'active' ELSE "status" END;--> statement-breakpoint
ALTER TABLE "workspace_storage_oauth" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "workspace_storage_oauth" CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_storage" DROP CONSTRAINT "workspace_storage_status_check";--> statement-breakpoint
ALTER TABLE "workspace_storage" ALTER COLUMN "storage_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_storage" DROP COLUMN "credentials";--> statement-breakpoint
ALTER TABLE "workspace_storage" DROP COLUMN "last_error";--> statement-breakpoint
ALTER TABLE "workspace_storage" DROP COLUMN "last_error_at";--> statement-breakpoint
ALTER TABLE "workspace_storage" DROP COLUMN "verified_at";--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD CONSTRAINT "workspace_storage_status_check" CHECK ("workspace_storage"."status" in ('active', 'disconnected'));
