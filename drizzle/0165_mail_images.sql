CREATE TABLE "mail_image_sender" (
	"mailbox_id" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_image_sender_mailbox_id_address_pk" PRIMARY KEY("mailbox_id","address")
);
--> statement-breakpoint
ALTER TABLE "mail_message" ADD COLUMN "images_shown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_image_sender" ADD CONSTRAINT "mail_image_sender_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;