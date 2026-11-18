import { env } from "@/lib/env";

/** Whether this server has a Teams bot: the app, its secret and its directory (TEAMS_APP_ID, TEAMS_APP_PASSWORD, TEAMS_TENANT_ID). */
export const teamsOn = () => Boolean(env.teamsAppId && env.teamsAppPassword && env.teamsTenantId);

/**
 * Microsoft's public Bot Connector hosts: the address a conversation's calls go to, the
 * `serviceUrl` of Teams' own calls (regional and tenant paths follow it, so only the host counts).
 * Other clouds (GCC, GCC High, DoD) sign in and publish keys elsewhere and aren't covered unless
 * the owner points TEAMS_LOGIN_URL, TEAMS_OPENID_URL and TEAMS_SERVICE_URL_HOSTS at them.
 */
const CONNECTOR_HOSTS = ["smba.trafficmanager.net", "smba.infra.teams.microsoft.com"];

/**
 * A conversation's service address when it is one the bot may send its token to: https (or http on
 * a loopback host named in TEAMS_SERVICE_URL_HOSTS), no credentials, no other port, and a host on
 * the list above or TEAMS_SERVICE_URL_HOSTS. Returned with a closing slash; null otherwise.
 */
export function trustedServiceUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const extra = env.teamsServiceUrlHosts;
  const allowed = CONNECTOR_HOSTS.includes(url.hostname) || extra.includes(url.host.toLowerCase()) || extra.includes(url.hostname.toLowerCase());
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const scheme = url.protocol === "https:" || (url.protocol === "http:" && loopback && allowed);
  if (!allowed || !scheme || url.username || url.password || url.search || url.hash) return null;
  if (CONNECTOR_HOSTS.includes(url.hostname) && url.port) return null;
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}
