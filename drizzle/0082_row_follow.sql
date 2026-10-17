-- Following database rows: row_follower holds who follows a row besides its creator and the people
-- its person properties name (commenters, people mentioned on it, those who chose to), and who
-- chose not to. row_update_pending holds one person's changes to a row until they leave it alone,
-- and notification.changes what a row_update notification tells. Row updates are on in the inbox,
-- by email and as push notifications until people turn them off.
CREATE TABLE "row_update_pending" (
	"row_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"changes" jsonb NOT NULL,
	"locale" text,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	CONSTRAINT "row_update_pending_row_id_actor_id_pk" PRIMARY KEY("row_id","actor_id")
);
--> statement-breakpoint
CREATE TABLE "row_follower" (
	"row_id" text NOT NULL,
	"user_id" text NOT NULL,
	"following" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "row_follower_row_id_user_id_pk" PRIMARY KEY("row_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "changes" jsonb;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "row_update_emails" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "row_update_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "row_update_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "row_update_pending" ADD CONSTRAINT "row_update_pending_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_update_pending" ADD CONSTRAINT "row_update_pending_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_follower" ADD CONSTRAINT "row_follower_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_follower" ADD CONSTRAINT "row_follower_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "row_update_pending_due_idx" ON "row_update_pending" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "row_follower_user_idx" ON "row_follower" USING btree ("user_id");
