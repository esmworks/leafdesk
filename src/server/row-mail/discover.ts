import { resolveMx as dnsMx, resolveSrv as dnsSrv } from "node:dns/promises";
import { normalizeAddress } from "@/lib/mail";
import {
  MAX_AUTOCONFIG_BYTES,
  MICROSOFT_SERVERS,
  mxDomain,
  pickSrv,
  readAutoconfig,
  signInOfAddress,
  signInOfMx,
  type DiscoveredMailServers,
  type MailSignIn,
  type SrvRecord,
} from "@/lib/mail-discover";
import { capResponse, connectionFetch } from "@/server/connections/fetch";

/**
 * The servers of the mailbox an address names, for the connect form to fill in (lib/mail-discover.ts
 * reads what comes back). Asked at once: the domain's own autoconfig file (two places, https
 * only), the public provider database mail clients share, the domain's mail exchangers and its
 * service records. The first that answers in that order wins; mail exchangers of Google and
 * Microsoft say the mailbox takes their sign-in. Only the domain leaves this server, never the
 * address; the domain's own servers are reached like any address a member gives
 * (connections/fetch.ts, public addresses only). Null when nothing is found.
 */

const ISPDB = "https://autoconfig.thunderbird.net/v1.1/";
const STEP_MS = 5_000;

export type DiscoverDeps = {
  fetch: (url: string) => Promise<string | null>;
  resolveMx: (domain: string) => Promise<{ exchange: string; priority: number }[]>;
  resolveSrv: (name: string) => Promise<SrvRecord[]>;
};

async function fetchConfig(url: string): Promise<string | null> {
  try {
    const response = await connectionFetch(url, { headers: { accept: "application/xml, text/xml" }, signal: AbortSignal.timeout(STEP_MS) }, { untrusted: true });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return await capResponse(response, MAX_AUTOCONFIG_BYTES).text();
  } catch {
    return null;
  }
}

const withTimeout = <T>(work: Promise<T>, fallback: T) =>
  Promise.race([work.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), STEP_MS).unref())]);

const systemDeps: DiscoverDeps = { fetch: fetchConfig, resolveMx: dnsMx, resolveSrv: dnsSrv };

const DOMAIN = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

/** Google's servers, for a domain whose mail Google takes. */
const GOOGLE_SERVERS = { imapHost: "imap.gmail.com", imapPort: 993, imapSecure: true, smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true };

/** The sign-in servers in an autoconfig file point to, when they are Google's or Microsoft's. */
function signInOfServers(imapHost: string): MailSignIn | null {
  if (imapHost === "imap.gmail.com") return "google";
  if (imapHost === "outlook.office365.com" || imapHost.endsWith(".outlook.com")) return "microsoft";
  return null;
}

export async function discoverMailServers(value: string, deps: DiscoverDeps = systemDeps): Promise<DiscoveredMailServers | null> {
  const address = normalizeAddress(value);
  const domain = address?.split("@")[1];
  if (!address || !domain || domain.length > 253 || !DOMAIN.test(domain)) return null;
  const fromFile = (xml: string | null, source: "autoconfig" | "ispdb"): DiscoveredMailServers | null => {
    const found = xml ? readAutoconfig(xml, address) : null;
    return found && { servers: found.servers, username: found.username, source, signIn: signInOfServers(found.servers.imapHost) ?? signInOfAddress(address) };
  };
  const srv = (name: string) => withTimeout(deps.resolveSrv(name), []).then(pickSrv);
  const [own, wellKnown, ispdb, mx, imaps, imap, submissions, submission] = await Promise.all([
    withTimeout(deps.fetch(`https://autoconfig.${domain}/mail/config-v1.1.xml`), null),
    withTimeout(deps.fetch(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`), null),
    withTimeout(deps.fetch(ISPDB + domain), null),
    withTimeout(deps.resolveMx(domain), []),
    srv(`_imaps._tcp.${domain}`),
    srv(`_imap._tcp.${domain}`),
    srv(`_submissions._tcp.${domain}`),
    srv(`_submission._tcp.${domain}`),
  ]);
  const found = fromFile(own, "autoconfig") ?? fromFile(wellKnown, "autoconfig") ?? fromFile(ispdb, "ispdb");
  if (found) return found;

  const exchanger = [...mx].sort((a, b) => a.priority - b.priority)[0]?.exchange;
  if (exchanger) {
    const signIn = signInOfMx(exchanger);
    if (signIn) return { servers: signIn === "google" ? GOOGLE_SERVERS : MICROSOFT_SERVERS, username: address, source: "mx", signIn };
    // A domain hosted by a provider: the provider's settings (yandex.net for mx.yandex.net).
    const host = mxDomain(exchanger);
    const byHost = host && host !== domain ? fromFile(await withTimeout(deps.fetch(ISPDB + host), null), "ispdb") : null;
    if (byHost) return { ...byHost, source: "mx" };
  }

  const incoming = imaps ? { ...imaps, secure: true } : imap ? { ...imap, secure: false } : null;
  const outgoing = submissions ? { ...submissions, secure: true } : submission ? { ...submission, secure: false } : null;
  if (incoming && outgoing) {
    return {
      servers: { imapHost: incoming.host, imapPort: incoming.port, imapSecure: incoming.secure, smtpHost: outgoing.host, smtpPort: outgoing.port, smtpSecure: outgoing.secure },
      username: address,
      source: "srv",
      signIn: null,
    };
  }
  return null;
}
