ALTER TABLE "account_memory" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;