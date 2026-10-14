CREATE TABLE "agent_skill" (
	"agent_id" text NOT NULL,
	"page_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skill_agent_id_page_id_pk" PRIMARY KEY("agent_id","page_id")
);
--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_skill_page_idx" ON "agent_skill" USING btree ("page_id");