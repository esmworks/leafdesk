/**
 * The websocket a desktop app opens on DESKTOP_BRIDGE_PATH (server.ts routes the upgrade here):
 * signed in with the session cookie the app's window holds for this server, and refused before the
 * upgrade without one, or without the app's header (lib/desktop-bridge.ts), which no web page can
 * send. Each open socket is a connection of the registry (registry.ts), which does the rest.
 */
import type { Hooks, Peer } from "crossws";
import { auth } from "@/lib/auth";
import { isStrongSession } from "@/lib/auth-security";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { DESKTOP_BRIDGE_HEADER } from "@/lib/desktop-bridge";
import { connectDesktop, type DesktopFacts, type DesktopLink } from "./registry";

/** Who an upgrade request signed in as, and what the workspaces' policies look at; null when no one. */
export async function authenticateDesktop(headers: Headers): Promise<{ userId: string; sessionId: string; facts: DesktopFacts } | null> {
  if (headers.get(DESKTOP_BRIDGE_HEADER) !== "1") return null;
  // From the database each time: a session ended elsewhere isn't taken from the signed cookie alone.
  const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } }).catch(() => null);
  if (!session) return null;
  const ip = headers.get(CLIENT_IP_HEADER);
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    facts: {
      strong: isStrongSession(session),
      ssoProviderId: (session.session as { ssoProviderId?: string | null }).ssoProviderId ?? null,
      ip: ip && ip !== "unknown" ? ip : null,
    },
  };
}

/** The bridge's websocket hooks, for server.ts's second crossws server. */
export function desktopBridgeHooks(): Partial<Hooks> {
  const links = new WeakMap<Peer, DesktopLink>();
  return {
    async upgrade(request) {
      const who = await authenticateDesktop(request.headers);
      if (!who) throw new Response("Unauthorized", { status: 401 });
      return { context: { desktop: who } };
    },
    open(peer) {
      const who = peer.context.desktop as Awaited<ReturnType<typeof authenticateDesktop>>;
      if (!who) return peer.close(4401, "Unauthorized");
      links.set(
        peer,
        connectDesktop({
          ...who,
          transport: {
            send: (message) => peer.send(JSON.stringify(message)),
            close: (code, reason) => peer.close(code, reason),
          },
        }),
      );
    },
    message(peer, message) {
      links.get(peer)?.receive(message.text());
    },
    close(peer) {
      links.get(peer)?.closed();
      links.delete(peer);
    },
    error(peer, error) {
      console.error("desktop bridge websocket error", peer.id, error);
    },
  };
}
