CREATE TABLE "api_idempotency_key" (
	"token_id" text NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" integer,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_idempotency_key_token_id_operation_key_pk" PRIMARY KEY("token_id","operation","key")
);
--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "legacy_scopes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_idempotency_key" ADD CONSTRAINT "api_idempotency_key_token_id_api_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_idempotency_key_created_idx" ON "api_idempotency_key" USING btree ("created_at");--> statement-breakpoint
-- Every token made before scopes were per resource keeps its access: pages:read read everything, pages:write wrote everything.
UPDATE "api_token" SET "legacy_scopes" = true;
