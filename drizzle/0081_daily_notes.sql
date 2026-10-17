CREATE TABLE "daily_note" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"page_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_note_workspace_id_user_id_day_pk" PRIMARY KEY("workspace_id","user_id","day")
);
--> statement-breakpoint
CREATE TABLE "journal" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"page_id" text,
	"start" text DEFAULT 'default' NOT NULL,
	"template_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "journal_start_check" CHECK ("journal"."start" in ('default', 'blank', 'template'))
);
--> statement-breakpoint
ALTER TABLE "daily_note" ADD CONSTRAINT "daily_note_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_note" ADD CONSTRAINT "daily_note_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_note" ADD CONSTRAINT "daily_note_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal" ADD CONSTRAINT "journal_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal" ADD CONSTRAINT "journal_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal" ADD CONSTRAINT "journal_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal" ADD CONSTRAINT "journal_template_id_page_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."page"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_note_page_idx" ON "daily_note" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "journal_user_idx" ON "journal" USING btree ("user_id");