CREATE TABLE "page_view" (
	"page_id" text NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"last_viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_view_page_id_user_id_day_pk" PRIMARY KEY("page_id","user_id","day")
);
--> statement-breakpoint
ALTER TABLE "workspace_member" ADD COLUMN "page_views" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "page_view" ADD CONSTRAINT "page_view_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_view" ADD CONSTRAINT "page_view_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_view_user_idx" ON "page_view" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "page_view_day_idx" ON "page_view" USING btree ("day");