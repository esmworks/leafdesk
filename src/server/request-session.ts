/**
 * The browser session behind the request being served, for the checks deep in the data layer that
 * only get a user id (see access.ts, which holds sessions to the workspaces' sign-in policies).
 *
 * Null outside a Next request (the collab server, scripts, tests) and without a sign-in. Only the
 * session cookie counts: an Authorization header proves nothing here. Requests a token actually
 * authenticated (MCP's OAuth tokens, the REST API's personal access tokens) run as connected apps,
 * which access.ts holds to their own setting instead. Looked up once per request.
 */
export type RequestSession = {
  userId: string;
  /** Passes a "require two-step verification" policy (see isStrongSession). */
  strong: boolean;
  /** The SSO provider it was signed in through, for "SSO only" workspaces. */
  ssoProviderId: string | null;
  /** Per workspace id: which of its policies holds this session back, if any. Filled by access.ts. */
  heldBack: Map<string, Promise<"two-factor" | "sso" | null>>;
};

const byRequest = new WeakMap<object, Promise<RequestSession | null>>();

export async function requestSession(): Promise<RequestSession | null> {
  let requestHeaders: Headers;
  try {
    // Loaded on demand: this module is imported by code that also runs outside Next.
    const { headers } = await import("next/headers");
    requestHeaders = await headers();
  } catch (error) {
    // Next's own control flow (dynamic rendering bailouts and the like) must go through.
    const { unstable_rethrow } = await import("next/navigation");
    unstable_rethrow(error);
    return null; // "called outside a request scope"
  }
  let found = byRequest.get(requestHeaders);
  if (!found) {
    found = lookUp(requestHeaders);
    byRequest.set(requestHeaders, found);
  }
  return found;
}

async function lookUp(requestHeaders: Headers): Promise<RequestSession | null> {
  const [{ auth }, { isStrongSession }] = await Promise.all([import("@/lib/auth"), import("@/lib/auth-security")]);
  const session = await auth.api.getSession({ headers: requestHeaders }).catch(() => null);
  if (!session) return null;
  return {
    userId: session.user.id,
    strong: isStrongSession(session),
    ssoProviderId: (session.session as { ssoProviderId?: string | null }).ssoProviderId ?? null,
    heldBack: new Map(),
  };
}
