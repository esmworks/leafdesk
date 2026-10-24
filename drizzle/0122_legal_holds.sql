CREATE TABLE "legal_hold" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_hold_person" (
	"hold_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "legal_hold_person_hold_id_user_id_pk" PRIMARY KEY("hold_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold_person" ADD CONSTRAINT "legal_hold_person_hold_id_legal_hold_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."legal_hold"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold_person" ADD CONSTRAINT "legal_hold_person_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_hold_workspace_idx" ON "legal_hold" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "legal_hold_person_user_idx" ON "legal_hold_person" USING btree ("user_id");