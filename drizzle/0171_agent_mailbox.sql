CREATE TABLE "agent_mailbox" (
	"agent_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_mailbox_agent_id_mailbox_id_pk" PRIMARY KEY("agent_id","mailbox_id")
);
--> statement-breakpoint
ALTER TABLE "agent_mailbox" ADD CONSTRAINT "agent_mailbox_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mailbox" ADD CONSTRAINT "agent_mailbox_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_mailbox_mailbox_idx" ON "agent_mailbox" USING btree ("mailbox_id");