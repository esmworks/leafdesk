CREATE TABLE "thread_mute" (
	"page_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_mute_page_id_thread_id_user_id_pk" PRIMARY KEY("page_id","thread_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "thread_mute" ADD CONSTRAINT "thread_mute_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_mute" ADD CONSTRAINT "thread_mute_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_mute_user_idx" ON "thread_mute" USING btree ("user_id");