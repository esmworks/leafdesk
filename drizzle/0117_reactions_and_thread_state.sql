CREATE TABLE "thread_state" (
	"page_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"marked_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	CONSTRAINT "thread_state_page_id_thread_id_user_id_pk" PRIMARY KEY("page_id","thread_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "comment_id" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "reactions" jsonb;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "reaction_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "reaction_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "reaction_push" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "reaction_telegram" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_state" ADD CONSTRAINT "thread_state_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_state" ADD CONSTRAINT "thread_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_state_user_idx" ON "thread_state" USING btree ("user_id");