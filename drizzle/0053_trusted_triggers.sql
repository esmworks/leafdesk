-- Triggers that exist already start out untrusted: their runs ask an owner before every connection
-- tool call until an owner marks the trigger trusted.
ALTER TABLE "connection_trigger" ADD COLUMN "trusted" boolean DEFAULT false NOT NULL;
