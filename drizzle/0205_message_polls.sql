CREATE TABLE "message_poll" (
	"message_id" text PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"multiple" boolean DEFAULT false NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"closes_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" text
);
--> statement-breakpoint
CREATE TABLE "message_poll_vote" (
	"message_id" text NOT NULL,
	"option_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_poll_vote_message_id_user_id_option_id_pk" PRIMARY KEY("message_id","user_id","option_id")
);
--> statement-breakpoint
ALTER TABLE "message_poll" ADD CONSTRAINT "message_poll_message_id_channel_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."channel_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_poll" ADD CONSTRAINT "message_poll_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_poll_vote" ADD CONSTRAINT "message_poll_vote_message_id_message_poll_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message_poll"("message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_poll_vote" ADD CONSTRAINT "message_poll_vote_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_poll_vote_user_idx" ON "message_poll_vote" USING btree ("user_id");