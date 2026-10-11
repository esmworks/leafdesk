-- A file reference lets the page's viewers read the file only once a write by someone who could
-- read it already authorizes it (see src/server/files.ts). References made before this existed were
-- made under the old rules and stay readable: the column is added as true for them, then defaults
-- to false for every reference the trigger records from now on.
ALTER TABLE "file_reference" ADD COLUMN "authorized" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "file_reference" ALTER COLUMN "authorized" SET DEFAULT false;
