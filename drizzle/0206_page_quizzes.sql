CREATE TABLE "quiz" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"page_id" text NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pass_mark" integer DEFAULT 80 NOT NULL,
	"max_attempts" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_assignment" (
	"quiz_id" text NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by" text,
	"due_date" date,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_assignment_quiz_id_user_id_pk" PRIMARY KEY("quiz_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "quiz_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"quiz_id" text NOT NULL,
	"user_id" text NOT NULL,
	"answers" jsonb NOT NULL,
	"right" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" integer NOT NULL,
	"passed" boolean NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "quiz_assigned_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "quiz_assigned_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "quiz_finished_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "quiz_finished_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "quiz_assigned_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "quiz_finished_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "quiz_assigned_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "quiz_finished_telegram" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz" ADD CONSTRAINT "quiz_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz" ADD CONSTRAINT "quiz_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz" ADD CONSTRAINT "quiz_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_assignment" ADD CONSTRAINT "quiz_assignment_quiz_id_quiz_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quiz"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_assignment" ADD CONSTRAINT "quiz_assignment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_assignment" ADD CONSTRAINT "quiz_assignment_assigned_by_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempt" ADD CONSTRAINT "quiz_attempt_quiz_id_quiz_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quiz"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempt" ADD CONSTRAINT "quiz_attempt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quiz_page_idx" ON "quiz" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "quiz_assignment_user_idx" ON "quiz_assignment" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "quiz_attempt_quiz_user_idx" ON "quiz_attempt" USING btree ("quiz_id","user_id","submitted_at");