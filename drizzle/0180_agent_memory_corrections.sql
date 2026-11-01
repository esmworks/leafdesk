ALTER TABLE "ai_memory" ADD COLUMN "kind" text DEFAULT 'note' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD COLUMN "said_by" text;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD CONSTRAINT "ai_memory_said_by_user_id_fk" FOREIGN KEY ("said_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;