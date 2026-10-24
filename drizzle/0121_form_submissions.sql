CREATE TABLE "form_submission" (
	"row_id" text PRIMARY KEY NOT NULL,
	"view_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_row_id_page_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_view_id_database_view_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."database_view"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_submission_view_user_idx" ON "form_submission" USING btree ("view_id","user_id","created_at" DESC NULLS LAST);