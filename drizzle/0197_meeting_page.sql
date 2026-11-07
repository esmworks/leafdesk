CREATE TABLE "meeting_page" (
	"page_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_page" ADD CONSTRAINT "meeting_page_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_page" ADD CONSTRAINT "meeting_page_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_page" ADD CONSTRAINT "meeting_page_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_page_owner_idx" ON "meeting_page" USING btree ("workspace_id","user_id");--> statement-breakpoint
-- Meeting notes made before: private top-level pages whose meeting block came with the page.
INSERT INTO "meeting_page" ("page_id", "workspace_id", "user_id", "created_at")
SELECT p."id", p."workspace_id", p."created_by", p."created_at"
FROM "page" p
WHERE p."parent_id" IS NULL
  AND p."teamspace_id" IS NULL
  AND p."created_by" IS NOT NULL
  AND p."kind" = 'page'
  AND NOT p."in_template"
  AND EXISTS (
    SELECT 1 FROM "meeting_note" m
    WHERE m."page_id" = p."id" AND m."created_at" < p."created_at" + interval '5 seconds'
  )
ON CONFLICT DO NOTHING;
