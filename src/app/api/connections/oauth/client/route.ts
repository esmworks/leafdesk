import { oauthClientMetadata, oauthClientMetadataUrl } from "@/server/connections/client";

/**
 * Leafdesk's client metadata document: a service whose authorization server takes these fetches
 * it, and its address is Leafdesk's client ID there, with no registration (see
 * ConnectionOAuthProvider). Public: it says only what Leafdesk would register anyway.
 */
// APP_URL is read when asked, not when the app is built.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { client_id: oauthClientMetadataUrl(), ...oauthClientMetadata() },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
