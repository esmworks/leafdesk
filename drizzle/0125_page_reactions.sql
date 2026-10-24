CREATE TABLE "page_reaction" (
	"page_id" text NOT NULL,
	"user_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_reaction_page_id_user_id_emoji_pk" PRIMARY KEY("page_id","user_id","emoji")
);
--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "properties_beside" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "page_reaction" ADD CONSTRAINT "page_reaction_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_reaction" ADD CONSTRAINT "page_reaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_reaction_user_idx" ON "page_reaction" USING btree ("user_id");