-- Sign-ins through a workspace's single sign-on connection (provider id `ws-<workspace id>`) that
-- earlier releases left on record: those whose connection is gone, and those older than the
-- workspace's connection, made through one it had before. The SSO plugin finds a person by the
-- provider id and the identity provider's id for them before it looks at the address, so a
-- connection set up again signed in as these people whoever its identity provider sent their ids
-- for. They go as when a connection is removed (cutOffConnection in server/sso.ts), with the
-- sessions under a connection that is gone or older than the workspace's, and any signed in through
-- a sign-in forgotten here; the API tokens and connected apps of the people they were for are
-- revoked, and when those were last used forgotten. account.created_at and session.created_at hold
-- UTC without a time zone.
WITH "forgotten" AS (
  DELETE FROM "account" a
  WHERE a."provider_id" LIKE 'ws-%'
    AND NOT EXISTS (
      SELECT 1 FROM "workspace_sso" c
      WHERE c."provider_id" = a."provider_id" AND c."created_at" <= a."created_at" AT TIME ZONE 'UTC'
    )
  RETURNING a."user_id", a."provider_id"
), "ended" AS (
  DELETE FROM "session" s
  WHERE s."sso_provider_id" LIKE 'ws-%'
    AND (
      NOT EXISTS (
        SELECT 1 FROM "workspace_sso" c
        WHERE c."provider_id" = s."sso_provider_id" AND c."created_at" <= s."created_at" AT TIME ZONE 'UTC'
      )
      OR EXISTS (SELECT 1 FROM "forgotten" f WHERE f."user_id" = s."user_id" AND f."provider_id" = s."sso_provider_id")
    )
  RETURNING s."user_id"
), "people" AS (
  SELECT "user_id" FROM "forgotten" UNION SELECT "user_id" FROM "ended"
), "api_tokens" AS (
  DELETE FROM "api_token" WHERE "user_id" IN (SELECT "user_id" FROM "people")
), "consents" AS (
  DELETE FROM "oauth_consent" WHERE "user_id" IN (SELECT "user_id" FROM "people")
), "refresh_tokens" AS (
  UPDATE "oauth_refresh_token" SET "revoked" = now() AT TIME ZONE 'UTC'
  WHERE "user_id" IN (SELECT "user_id" FROM "people") AND "revoked" IS NULL
), "access_tokens" AS (
  UPDATE "oauth_access_token" SET "revoked" = now() AT TIME ZONE 'UTC'
  WHERE "user_id" IN (SELECT "user_id" FROM "people") AND "revoked" IS NULL
)
DELETE FROM "connected_app_use" WHERE "user_id" IN (SELECT "user_id" FROM "people");
