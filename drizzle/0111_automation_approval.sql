ALTER TABLE "pending_change" DROP CONSTRAINT "pending_change_kind_check";--> statement-breakpoint
ALTER TABLE "pending_change" DROP CONSTRAINT "pending_change_row_check";--> statement-breakpoint
ALTER TABLE "pending_change" ADD COLUMN "automation_id" text;--> statement-breakpoint
ALTER TABLE "pending_change" ADD COLUMN "automation_run_id" text;--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_automation_id_database_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."database_automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_automation_run_id_automation_run_id_fk" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_change_automation_run_idx" ON "pending_change" USING btree ("automation_run_id");--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_kind_check" CHECK ("pending_change"."kind" in ('create_row', 'update_row', 'email_draft', 'automation_approval'));--> statement-breakpoint
ALTER TABLE "pending_change" ADD CONSTRAINT "pending_change_row_check" CHECK ("pending_change"."kind" in ('create_row', 'automation_approval') or "pending_change"."row_id" is not null);