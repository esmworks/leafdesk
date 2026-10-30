DROP INDEX "mailbox_member_idx";--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_address_idx" ON "mailbox" USING btree ("workspace_id","user_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_default_idx" ON "mailbox" USING btree ("workspace_id","user_id") WHERE "mailbox"."is_default";--> statement-breakpoint
-- Members had one mailbox in a workspace before: it is their default.
UPDATE "mailbox" SET "is_default" = true;