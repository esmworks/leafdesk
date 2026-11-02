CREATE TABLE "account_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"oauth_client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"teamspace_id" text,
	"text" text NOT NULL,
	"created_by" text,
	"updated_by" text,
	"oauth_client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_memory" ADD CONSTRAINT "account_memory_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory" ADD CONSTRAINT "shared_memory_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory" ADD CONSTRAINT "shared_memory_teamspace_id_teamspace_id_fk" FOREIGN KEY ("teamspace_id") REFERENCES "public"."teamspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory" ADD CONSTRAINT "shared_memory_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory" ADD CONSTRAINT "shared_memory_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_memory_user_idx" ON "account_memory" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "shared_memory_place_idx" ON "shared_memory" USING btree ("workspace_id","teamspace_id","created_at");