CREATE TABLE "audit_stream" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"batch_id" text,
	"next_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"last_error" text,
	"last_http_status" integer,
	"failing_since" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"sent_events" integer DEFAULT 0 NOT NULL,
	"dropped_events" integer DEFAULT 0 NOT NULL,
	"last_dropped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_stream_outbox" (
	"event_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sensitive_finding" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"page_id" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"excerpt" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"found_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" text,
	"notified_at" timestamp with time zone,
	CONSTRAINT "sensitive_finding_status_check" CHECK ("sensitive_finding"."status" in ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "sensitive_scan" (
	"page_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_stream" ADD CONSTRAINT "audit_stream_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_stream" ADD CONSTRAINT "audit_stream_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_stream_outbox" ADD CONSTRAINT "audit_stream_outbox_event_id_audit_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."audit_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_stream_outbox" ADD CONSTRAINT "audit_stream_outbox_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_finding" ADD CONSTRAINT "sensitive_finding_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_finding" ADD CONSTRAINT "sensitive_finding_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_finding" ADD CONSTRAINT "sensitive_finding_dismissed_by_user_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_scan" ADD CONSTRAINT "sensitive_scan_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_scan" ADD CONSTRAINT "sensitive_scan_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_stream_outbox_order_idx" ON "audit_stream_outbox" USING btree ("workspace_id","created_at","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sensitive_finding_value_idx" ON "sensitive_finding" USING btree ("page_id","kind","fingerprint");--> statement-breakpoint
CREATE INDEX "sensitive_finding_workspace_idx" ON "sensitive_finding" USING btree ("workspace_id","status","found_at");--> statement-breakpoint
CREATE INDEX "sensitive_scan_workspace_idx" ON "sensitive_scan" USING btree ("workspace_id");--> statement-breakpoint
-- Each new audit event of a workspace whose stream is on waits in the outbox, in the transaction
-- that records it (server/audit-stream.ts sends and deletes them).
CREATE OR REPLACE FUNCTION audit_stream_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM audit_stream WHERE workspace_id = NEW.workspace_id AND enabled) THEN
    INSERT INTO audit_stream_outbox (event_id, workspace_id, created_at) VALUES (NEW.id, NEW.workspace_id, NEW.created_at);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_stream_enqueue AFTER INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION audit_stream_enqueue();
