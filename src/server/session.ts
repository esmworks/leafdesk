import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/lib/auth";
import { isStrongSession } from "@/lib/auth-security";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { policyHoldFor, type PolicyHold } from "@/server/access";

export const getSession = cache(async () => {
  // Headers first: while `next build` prerenders, reading them ends the attempt before Better
  // Auth is created (it queries the database as it sets up; see lib/auth).
  const requestHeaders = await headers();
  return auth.api.getSession({ headers: requestHeaders });
});

/** Set by src/proxy.ts on app routes: the path being requested, to come back to after signing in. */
const PATH_HEADER = "x-leafdesk-path";

/** For pages and layouts: redirects to sign-in when there is no session. */
export async function requireSession() {
  const session = await getSession();
  if (!session) {
    const path = (await headers()).get(PATH_HEADER);
    // The sign-in page only follows same-origin paths (safeNext), so this can't point elsewhere.
    redirect(path ? `/sign-in?next=${encodeURIComponent(path)}` : "/sign-in");
  }
  return session;
}

/** For pages and layouts under the app routes (see src/proxy.ts): the path being requested, with its query. */
export async function requestedPath(): Promise<string | null> {
  return (await headers()).get(PATH_HEADER);
}

/** For pages and layouts: the signed-in user, or a redirect to sign-in. */
export async function requireUser() {
  return (await requireSession()).user;
}

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/** The address of the request being served (set by server.ts, see lib/client-ip); null when unknown. */
export async function requestIp(): Promise<string | null> {
  const ip = (await headers()).get(CLIENT_IP_HEADER);
  return ip && ip !== "unknown" ? ip : null;
}

/** What the workspace policies look at in a session and this request (see SessionFacts in access.ts). */
export async function sessionFacts(session: Session) {
  return {
    strong: isStrongSession(session),
    ssoProviderId: (session.session as { ssoProviderId?: string | null }).ssoProviderId ?? null,
    ip: await requestIp(),
  };
}

/**
 * Which of the workspace's sign-in policies holds back this session: its approved networks (the
 * request's address), two-step verification (isStrongSession) or "SSO only". Non-members get null:
 * their own access checks turn them away, without learning the workspace's policy.
 */
export async function blockedByWorkspacePolicy(session: Session, workspaceId: string): Promise<PolicyHold | null> {
  return policyHoldFor(session.user.id, workspaceId, await sessionFacts(session));
}

/**
 * For the pages under /w/[workspaceId] (the layout and each page, as Next renders them in
 * parallel): a session a workspace policy turns away goes to the page where it can meet it. Server
 * actions and API routes get a WorkspacePolicyError from the access checks instead (see access.ts).
 * Connected apps (MCP) and REST API tokens reach data with bearer tokens and aren't affected.
 */
export async function requireWorkspaceSession(workspaceId: string) {
  const session = await requireSession();
  const hold = await blockedByWorkspacePolicy(session, workspaceId);
  if (hold) redirect(policyGatePath(workspaceId, hold));
  return session;
}

export const twoStepPath = (workspaceId: string) => `/two-step/${encodeURIComponent(workspaceId)}`;
export const ssoRequiredPath = (workspaceId: string) => `/sso-required/${encodeURIComponent(workspaceId)}`;
export const networkRequiredPath = (workspaceId: string) => `/network-required/${encodeURIComponent(workspaceId)}`;

/** The 403 body of routes that answer a held-back session without a page. */
export const policyRefusal = (hold: PolicyHold) =>
  hold === "ip" ? "Not on an approved network" : hold === "sso" ? "Single sign-on required" : "Two-step verification required";

/** Where a session held back by `hold` goes to meet the policy (or, for `ip`, to learn why it can't). */
export const policyGatePath = (workspaceId: string, hold: PolicyHold) =>
  hold === "ip" ? networkRequiredPath(workspaceId) : hold === "sso" ? ssoRequiredPath(workspaceId) : twoStepPath(workspaceId);

/** For server actions: throws instead of redirecting. */
export async function requireUserId() {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  return session.user.id;
}
