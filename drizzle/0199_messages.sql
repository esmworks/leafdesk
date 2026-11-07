CREATE TABLE "channel" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"topic" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"direct_key" text,
	"posting" text DEFAULT 'everyone' NOT NULL,
	"join_new" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" text,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"rev" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "channel_kind_check" CHECK ("channel"."kind" in ('public', 'private', 'direct')),
	CONSTRAINT "channel_posting_check" CHECK ("channel"."posting" in ('everyone', 'admins')),
	CONSTRAINT "channel_name_check" CHECK (("channel"."kind" = 'direct') = ("channel"."name" is null) and ("channel"."kind" = 'direct') = ("channel"."direct_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "channel_member" (
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_seq" integer DEFAULT 0 NOT NULL,
	"mentions" integer DEFAULT 0 NOT NULL,
	"notify" text DEFAULT 'default' NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"section_id" text,
	"rev" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "channel_member_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id"),
	CONSTRAINT "channel_member_role_check" CHECK ("channel_member"."role" in ('admin', 'member')),
	CONSTRAINT "channel_member_notify_check" CHECK ("channel_member"."notify" in ('default', 'all', 'mentions', 'none'))
);
--> statement-breakpoint
CREATE TABLE "channel_message" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"seq" integer NOT NULL,
	"thread_id" text,
	"author_id" text,
	"kind" text DEFAULT 'message' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"plain" text DEFAULT '' NOT NULL,
	"data" jsonb,
	"also_in_channel" boolean DEFAULT false NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_seq" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone,
	"repliers" text[] DEFAULT '{}'::text[] NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"pinned_at" timestamp with time zone,
	"pinned_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', search_fold(left(plain, 20000))) || to_tsvector('simple', cjk_bigrams(left(plain, 20000)))) STORED,
	CONSTRAINT "channel_message_kind_check" CHECK ("channel_message"."kind" in ('message', 'system'))
);
--> statement-breakpoint
CREATE TABLE "channel_section" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"collapsed" boolean DEFAULT false NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_clock" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_draft" (
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text DEFAULT '' NOT NULL,
	"workspace_id" text NOT NULL,
	"body" text NOT NULL,
	"file_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "message_draft_user_id_channel_id_thread_id_pk" PRIMARY KEY("user_id","channel_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "message_file" (
	"file_id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"user_id" text,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_mention" (
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"broadcast" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_mention_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "message_reaction" (
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reaction_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "message_status" (
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"emoji" text,
	"text" text DEFAULT '' NOT NULL,
	"status_until" timestamp with time zone,
	"quiet_until" timestamp with time zone,
	"previews" boolean DEFAULT true NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "message_status_user_id_workspace_id_pk" PRIMARY KEY("user_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "message_thread" (
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"following" boolean DEFAULT true NOT NULL,
	"last_read_seq" integer DEFAULT 0 NOT NULL,
	"mentions" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone,
	"rev" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "message_thread_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "message_version" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"body" text NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_message" (
	"user_id" text NOT NULL,
	"message_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"remind_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"rev" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "saved_message_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_message" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text,
	"body" text NOT NULL,
	"file_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_archived_by_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_member" ADD CONSTRAINT "channel_member_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_member" ADD CONSTRAINT "channel_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_member" ADD CONSTRAINT "channel_member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_message" ADD CONSTRAINT "channel_message_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_message" ADD CONSTRAINT "channel_message_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_message" ADD CONSTRAINT "channel_message_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_message" ADD CONSTRAINT "channel_message_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_section" ADD CONSTRAINT "channel_section_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_section" ADD CONSTRAINT "channel_section_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_clock" ADD CONSTRAINT "message_clock_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_draft" ADD CONSTRAINT "message_draft_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_draft" ADD CONSTRAINT "message_draft_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_draft" ADD CONSTRAINT "message_draft_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_message_id_channel_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."channel_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mention" ADD CONSTRAINT "message_mention_message_id_channel_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."channel_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mention" ADD CONSTRAINT "message_mention_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mention" ADD CONSTRAINT "message_mention_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reaction" ADD CONSTRAINT "message_reaction_message_id_channel_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."channel_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reaction" ADD CONSTRAINT "message_reaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_status" ADD CONSTRAINT "message_status_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_status" ADD CONSTRAINT "message_status_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_thread_id_channel_message_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."channel_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_version" ADD CONSTRAINT "message_version_message_id_channel_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."channel_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_message" ADD CONSTRAINT "saved_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_message" ADD CONSTRAINT "saved_message_message_id_channel_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."channel_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_message" ADD CONSTRAINT "saved_message_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_workspace_idx" ON "channel" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "channel_rev_idx" ON "channel" USING btree ("workspace_id","rev");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_name_idx" ON "channel" USING btree ("workspace_id","name") WHERE "channel"."kind" <> 'direct';--> statement-breakpoint
CREATE UNIQUE INDEX "channel_direct_key_idx" ON "channel" USING btree ("workspace_id","direct_key") WHERE "channel"."kind" = 'direct';--> statement-breakpoint
CREATE INDEX "channel_member_user_idx" ON "channel_member" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "channel_member_rev_idx" ON "channel_member" USING btree ("workspace_id","rev");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_message_seq_idx" ON "channel_message" USING btree ("channel_id","seq");--> statement-breakpoint
CREATE INDEX "channel_message_thread_idx" ON "channel_message" USING btree ("thread_id","seq") WHERE "channel_message"."thread_id" is not null;--> statement-breakpoint
CREATE INDEX "channel_message_rev_idx" ON "channel_message" USING btree ("workspace_id","rev");--> statement-breakpoint
CREATE INDEX "channel_message_author_idx" ON "channel_message" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "channel_message_pinned_idx" ON "channel_message" USING btree ("channel_id") WHERE "channel_message"."pinned_at" is not null;--> statement-breakpoint
CREATE INDEX "channel_message_search_idx" ON "channel_message" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "channel_section_user_idx" ON "channel_section" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "message_draft_rev_idx" ON "message_draft" USING btree ("workspace_id","rev");--> statement-breakpoint
CREATE INDEX "message_file_message_idx" ON "message_file" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_file_channel_idx" ON "message_file" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "message_mention_user_idx" ON "message_mention" USING btree ("user_id","workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "message_reaction_user_idx" ON "message_reaction" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_status_rev_idx" ON "message_status" USING btree ("workspace_id","rev");--> statement-breakpoint
CREATE INDEX "message_thread_user_idx" ON "message_thread" USING btree ("user_id","workspace_id","last_reply_at");--> statement-breakpoint
CREATE INDEX "message_thread_rev_idx" ON "message_thread" USING btree ("workspace_id","rev");--> statement-breakpoint
CREATE INDEX "message_version_message_idx" ON "message_version" USING btree ("message_id","replaced_at");--> statement-breakpoint
CREATE INDEX "saved_message_rev_idx" ON "saved_message" USING btree ("workspace_id","rev");--> statement-breakpoint
CREATE INDEX "saved_message_remind_idx" ON "saved_message" USING btree ("remind_at") WHERE "saved_message"."reminded_at" is null and "saved_message"."done_at" is null;--> statement-breakpoint
CREATE INDEX "scheduled_message_due_idx" ON "scheduled_message" USING btree ("send_at") WHERE "scheduled_message"."failure" is null;--> statement-breakpoint
CREATE INDEX "scheduled_message_user_idx" ON "scheduled_message" USING btree ("user_id","workspace_id");