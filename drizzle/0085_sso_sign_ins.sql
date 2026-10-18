-- A sign-in through a single sign-on provider is on record under the provider's id: the account
-- linking the person to it (`account.provider_id`, with the id the identity provider gives them)
-- and the sessions it signed in (`session.sso_provider_id`). Neither column has a foreign key, so
-- they outlasted the provider. A workspace's provider id comes back with its next connection
-- (`ws-<workspace id>`), whose identity provider must not find those people by their old ids: when
-- a provider row goes, so do the sign-ins under its id. The app cuts a connection off before
-- removing it (src/server/sso.ts), to revoke those people's API tokens and connected apps too.
CREATE OR REPLACE FUNCTION sso_provider_forget_sign_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "account" WHERE "provider_id" = OLD."provider_id";
  DELETE FROM "session" WHERE "sso_provider_id" = OLD."provider_id";
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER sso_provider_forget_sign_ins AFTER DELETE ON "sso_provider"
  FOR EACH ROW EXECUTE FUNCTION sso_provider_forget_sign_ins();
