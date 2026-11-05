CREATE TABLE "memory_summary" (
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"text" text NOT NULL,
	"written_by" text NOT NULL,
	"sources" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_summary_user_id_workspace_id_pk" PRIMARY KEY("user_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "account_memory" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_memory" ADD COLUMN "details" text;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memory" ADD COLUMN "details" text;--> statement-breakpoint
ALTER TABLE "shared_memory" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory" ADD COLUMN "details" text;--> statement-breakpoint
ALTER TABLE "memory_summary" ADD CONSTRAINT "memory_summary_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_summary" ADD CONSTRAINT "memory_summary_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;