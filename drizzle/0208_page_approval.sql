CREATE TABLE "page_approval" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"page_id" text NOT NULL,
	"snapshot_id" text,
	"requested_by" text,
	"rule" text NOT NULL,
	"note" text,
	"due_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "page_approval_decision" (
	"approval_id" text NOT NULL,
	"user_id" text NOT NULL,
	"decision" text,
	"comment" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "page_approval_decision_approval_id_user_id_pk" PRIMARY KEY("approval_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "approval_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "approval_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "approval_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "approval_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "page_approval" ADD CONSTRAINT "page_approval_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_approval" ADD CONSTRAINT "page_approval_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_approval" ADD CONSTRAINT "page_approval_snapshot_id_page_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."page_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_approval" ADD CONSTRAINT "page_approval_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_approval_decision" ADD CONSTRAINT "page_approval_decision_approval_id_page_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."page_approval"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_approval_decision" ADD CONSTRAINT "page_approval_decision_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_approval_page_idx" ON "page_approval" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE INDEX "page_approval_snapshot_idx" ON "page_approval" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_approval_open_idx" ON "page_approval" USING btree ("page_id") WHERE "page_approval"."status" = 'open';--> statement-breakpoint
CREATE INDEX "page_approval_decision_user_idx" ON "page_approval_decision" USING btree ("user_id");