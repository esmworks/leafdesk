CREATE TABLE "work_block" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"page_id" text NOT NULL,
	"block_id" text,
	"title" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_block_length_check" CHECK ("work_block"."ends_at" >= "work_block"."starts_at" + interval '15 minutes' and "work_block"."ends_at" <= "work_block"."starts_at" + interval '12 hours')
);
--> statement-breakpoint
ALTER TABLE "work_block" ADD CONSTRAINT "work_block_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_block" ADD CONSTRAINT "work_block_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_block" ADD CONSTRAINT "work_block_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_block_user_idx" ON "work_block" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE INDEX "work_block_page_idx" ON "work_block" USING btree ("page_id");