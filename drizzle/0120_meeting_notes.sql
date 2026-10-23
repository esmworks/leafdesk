CREATE TABLE "meeting_note" (
	"page_id" text NOT NULL,
	"meeting_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"seconds" integer DEFAULT 0 NOT NULL,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"preview" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_note_page_id_meeting_id_pk" PRIMARY KEY("page_id","meeting_id")
);
--> statement-breakpoint
ALTER TABLE "meeting_note" ADD CONSTRAINT "meeting_note_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;