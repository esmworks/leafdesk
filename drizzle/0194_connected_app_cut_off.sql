CREATE TABLE "connected_app_cut_off" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"app_kind" text NOT NULL,
	"app_id" text NOT NULL,
	"cut_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_app_cut_off_workspace_id_user_id_app_kind_app_id_pk" PRIMARY KEY("workspace_id","user_id","app_kind","app_id"),
	CONSTRAINT "connected_app_cut_off_kind_check" CHECK ("connected_app_cut_off"."app_kind" in ('connected_app', 'api_token'))
);
--> statement-breakpoint
ALTER TABLE "connected_app_cut_off" ADD CONSTRAINT "connected_app_cut_off_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_app_cut_off" ADD CONSTRAINT "connected_app_cut_off_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connected_app_cut_off_app_idx" ON "connected_app_cut_off" USING btree ("user_id","app_kind","app_id");