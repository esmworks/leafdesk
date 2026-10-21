CREATE TABLE "agent_helper" (
	"agent_id" text NOT NULL,
	"helper_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_helper_agent_id_helper_id_pk" PRIMARY KEY("agent_id","helper_id")
);
--> statement-breakpoint
ALTER TABLE "agent_helper" ADD CONSTRAINT "agent_helper_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_helper" ADD CONSTRAINT "agent_helper_helper_id_workspace_agent_id_fk" FOREIGN KEY ("helper_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_helper_helper_idx" ON "agent_helper" USING btree ("helper_id");