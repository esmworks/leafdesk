CREATE TABLE "memory_embedding" (
	"id" text PRIMARY KEY NOT NULL,
	"ai_memory_id" text,
	"shared_memory_id" text,
	"account_memory_id" text,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" real[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_embedding_ai_memory_id_unique" UNIQUE("ai_memory_id"),
	CONSTRAINT "memory_embedding_shared_memory_id_unique" UNIQUE("shared_memory_id"),
	CONSTRAINT "memory_embedding_account_memory_id_unique" UNIQUE("account_memory_id"),
	CONSTRAINT "memory_embedding_one_note_check" CHECK (num_nonnulls("memory_embedding"."ai_memory_id", "memory_embedding"."shared_memory_id", "memory_embedding"."account_memory_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "memory_embedding" ADD CONSTRAINT "memory_embedding_ai_memory_id_ai_memory_id_fk" FOREIGN KEY ("ai_memory_id") REFERENCES "public"."ai_memory"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embedding" ADD CONSTRAINT "memory_embedding_shared_memory_id_shared_memory_id_fk" FOREIGN KEY ("shared_memory_id") REFERENCES "public"."shared_memory"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embedding" ADD CONSTRAINT "memory_embedding_account_memory_id_account_memory_id_fk" FOREIGN KEY ("account_memory_id") REFERENCES "public"."account_memory"("id") ON DELETE cascade ON UPDATE no action;