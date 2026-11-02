CREATE TABLE "mail_sender_rule" (
	"user_id" text NOT NULL,
	"sender" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_sender_rule_user_id_sender_pk" PRIMARY KEY("user_id","sender"),
	CONSTRAINT "mail_sender_rule_kind" CHECK ("mail_sender_rule"."kind" in ('focus', 'other', 'block'))
);
--> statement-breakpoint
ALTER TABLE "mail_sender_rule" ADD CONSTRAINT "mail_sender_rule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;