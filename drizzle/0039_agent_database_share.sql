CREATE TABLE "agent_database_share" (
	"agent_id" text NOT NULL,
	"database_id" text NOT NULL,
	"previous_level" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_database_share_agent_id_database_id_pk" PRIMARY KEY("agent_id","database_id")
);
--> statement-breakpoint
ALTER TABLE "agent_database_share" ADD CONSTRAINT "agent_database_share_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_database_share" ADD CONSTRAINT "agent_database_share_database_id_page_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;