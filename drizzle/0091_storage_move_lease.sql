ALTER TABLE "storage_move" ADD COLUMN "lease_id" text;--> statement-breakpoint
CREATE INDEX "file_storage_key_idx" ON "file" USING btree ("storage_key");