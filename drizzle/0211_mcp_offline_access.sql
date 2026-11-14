-- Apps that registered asking only for the MCP scopes listed in the protected-resource metadata
-- were never given offline_access, so they got no refresh token and fell out after an hour.
-- Authorizations now ask for it on their behalf (server/mcp/offline-access.ts), which the
-- provider allows only within a client's own scopes: widen the clients registered before.
-- Clients read from a metadata document (an https client_id) keep what their document says.
UPDATE "oauth_client"
SET "scopes" = array_append("scopes", 'offline_access')
WHERE "scopes" IS NOT NULL
  AND NOT ('offline_access' = ANY ("scopes"))
  AND "client_id" NOT LIKE 'https://%'
  AND ("grant_types" IS NULL OR cardinality("grant_types") = 0 OR 'authorization_code' = ANY ("grant_types"));
