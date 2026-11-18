CREATE TABLE "external_agent_binding" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text,
	"token_id" text,
	"bound_by" text,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_tool" text,
	CONSTRAINT "external_agent_binding_kind_check" CHECK (("external_agent_binding"."client_id" is not null) <> ("external_agent_binding"."token_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "external_agent_mention" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"page_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"comment_id" text NOT NULL,
	"mentioned_by" text,
	"excerpt" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone,
	"handled_by" text
);
--> statement-breakpoint
ALTER TABLE "workspace_agent" ADD COLUMN "kind" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "external_agent_binding" ADD CONSTRAINT "external_agent_binding_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_binding" ADD CONSTRAINT "external_agent_binding_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_binding" ADD CONSTRAINT "external_agent_binding_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_binding" ADD CONSTRAINT "external_agent_binding_token_id_api_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_binding" ADD CONSTRAINT "external_agent_binding_bound_by_user_id_fk" FOREIGN KEY ("bound_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_mention" ADD CONSTRAINT "external_agent_mention_agent_id_workspace_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_mention" ADD CONSTRAINT "external_agent_mention_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_mention" ADD CONSTRAINT "external_agent_mention_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_mention" ADD CONSTRAINT "external_agent_mention_mentioned_by_user_id_fk" FOREIGN KEY ("mentioned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_mention" ADD CONSTRAINT "external_agent_mention_handled_by_user_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_agent_binding_app_idx" ON "external_agent_binding" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "external_agent_binding_token_idx" ON "external_agent_binding" USING btree ("token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_agent_mention_comment_idx" ON "external_agent_mention" USING btree ("agent_id","comment_id");--> statement-breakpoint
CREATE INDEX "external_agent_mention_open_idx" ON "external_agent_mention" USING btree ("agent_id","handled_at");--> statement-breakpoint
CREATE INDEX "external_agent_mention_page_idx" ON "external_agent_mention" USING btree ("page_id");--> statement-breakpoint
ALTER TABLE "workspace_agent" ADD CONSTRAINT "workspace_agent_kind_check" CHECK ("workspace_agent"."kind" in ('internal', 'external'));