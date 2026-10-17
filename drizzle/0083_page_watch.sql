-- Watching pages: page_watch holds who chose to watch a page or edited it, and who muted it;
-- teamspace_watch who watches every page of a teamspace. page_update_pending holds one person's
-- edits to a page until they leave it alone, and page_update_email the page-update emails sent, for
-- their cooldown and daily cap. Page updates are on in the inbox, by email and as push notifications
-- until people turn them off.
CREATE TABLE "page_update_email" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"page_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_watch" (
	"page_id" text NOT NULL,
	"user_id" text NOT NULL,
	"watching" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_watch_page_id_user_id_pk" PRIMARY KEY("page_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "page_update_pending" (
	"page_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"locale" text,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	CONSTRAINT "page_update_pending_page_id_actor_id_pk" PRIMARY KEY("page_id","actor_id")
);
--> statement-breakpoint
CREATE TABLE "teamspace_watch" (
	"teamspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teamspace_watch_teamspace_id_user_id_pk" PRIMARY KEY("teamspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "page_update_emails" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "page_update_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "page_update_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "page_update_email" ADD CONSTRAINT "page_update_email_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_update_email" ADD CONSTRAINT "page_update_email_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_watch" ADD CONSTRAINT "page_watch_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_watch" ADD CONSTRAINT "page_watch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_update_pending" ADD CONSTRAINT "page_update_pending_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_update_pending" ADD CONSTRAINT "page_update_pending_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teamspace_watch" ADD CONSTRAINT "teamspace_watch_teamspace_id_teamspace_id_fk" FOREIGN KEY ("teamspace_id") REFERENCES "public"."teamspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teamspace_watch" ADD CONSTRAINT "teamspace_watch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_update_email_user_idx" ON "page_update_email" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "page_watch_user_idx" ON "page_watch" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "page_update_pending_due_idx" ON "page_update_pending" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "teamspace_watch_user_idx" ON "teamspace_watch" USING btree ("user_id");