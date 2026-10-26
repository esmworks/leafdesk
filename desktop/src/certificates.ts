import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import tls from "node:tls";
import type { Certificate, Session } from "electron";

/** A certificate this computer didn't trust, as last seen for a host. */
export type CertificateProblem = {
  host: string;
  /** SHA-256 of the certificate, as `openssl x509 -fingerprint -sha256` prints it. */
  fingerprint: string;
  subject: string;
  issuer: string;
  validUntil: string;
  error: string;
  /** The server it was met on, when known. */
  origin?: string;
  /**
   * The host had a good certificate before (one this computer trusts, or another one the person
   * trusted): someone may be in between, and the trust screen says so (certificateChanged).
   */
  changed: boolean;
  /**
   * Whether Chromium turned it down itself. The network service keeps that verdict for the rest
   * of the run, so trusting such a certificate takes effect after a restart.
   */
  seenByChromium: boolean;
};

const INSPECT_TIMEOUT_MS = 10_000;

/** What the trust is kept in (main.ts keeps it in the settings). */
export type TrustStore = {
  /** The certificates the person trusted although this computer doesn't: host → SHA-256 fingerprint. */
  trusted(): Readonly<Record<string, string>>;
  /** The hosts that had a certificate this computer trusts (as far as they were remembered). */
  validHosts(): readonly string[];
  /** A host's certificate passed this computer's own checks. */
  seenValid(host: string): void;
};

/**
 * Whether an untrusted certificate takes the place of a good one: the host had one this computer
 * trusts, or the person trusted another one for it. Either way the server may not have changed
 * its certificate at all, and someone may be in between.
 */
export function certificateChanged(host: string, fingerprint: string, trusted: Readonly<Record<string, string>>, validHosts: readonly string[]) {
  return validHosts.includes(host) || (Object.hasOwn(trusted, host) && trusted[host] !== fingerprint);
}

/**
 * Lets people trust their own server's certificate when this computer doesn't (a self-signed one,
 * or one from their own certificate authority): for that host and that exact certificate only (by
 * host name: Chromium's check isn't told the port). Everything else is verified as usual. The check covers every request of the session, the
 * collaboration WebSocket and the service worker included.
 */
export class CertificateTrust {
  readonly problems = new Map<string, CertificateProblem>();

  private readonly store: TrustStore;

  constructor(store: TrustStore) {
    this.store = store;
  }

  /** Whether the person trusted exactly this certificate for the host. */
  private isTrusted(host: string, fingerprint: string) {
    const trusted = this.store.trusted();
    return Object.hasOwn(trusted, host) && trusted[host] === fingerprint;
  }

  private changed(host: string, fingerprint: string) {
    return certificateChanged(host, fingerprint, this.store.trusted(), this.store.validHosts());
  }

  install(session: Session) {
    session.setCertificateVerifyProc((request, callback) => {
      if (request.errorCode === 0) {
        this.store.seenValid(request.hostname);
        return callback(-3);
      }
      const fingerprint = fingerprintOf(request.certificate);
      if (fingerprint && this.isTrusted(request.hostname, fingerprint)) return callback(0);
      if (fingerprint) {
        this.problems.set(request.hostname, {
          host: request.hostname,
          fingerprint,
          subject: request.certificate.subjectName,
          issuer: request.certificate.issuerName,
          validUntil: new Date(request.certificate.validExpiry * 1000).toISOString(),
          error: request.verificationResult,
          changed: this.changed(request.hostname, fingerprint),
          seenByChromium: true,
        });
      }
      // -3: the verification result Chromium came to.
      callback(-3);
    });
  }

  /**
   * Looks at an HTTPS server's certificate before Chromium does, so that a certificate someone is
   * about to trust isn't turned down (and remembered as turned down) first. Null when there is
   * nothing to say: no HTTPS, no answer, or a certificate this computer or the person trusts.
   */
  inspect(origin: string): Promise<CertificateProblem | null> {
    const url = new URL(origin);
    if (url.protocol !== "https:") return Promise.resolve(null);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return new Promise((resolve) => {
      const socket = tls.connect({
        host,
        port: Number(url.port || 443),
        servername: isIP(host) ? undefined : host,
        ca: trustedAuthorities(),
        rejectUnauthorized: false,
        timeout: INSPECT_TIMEOUT_MS,
      });
      const done = (problem: CertificateProblem | null) => {
        socket.destroy();
        resolve(problem);
      };
      socket.once("secureConnect", () => {
        const peer = socket.getPeerCertificate();
        const error = socket.authorized ? tls.checkServerIdentity(host, peer)?.message : String(socket.authorizationError ?? "");
        const fingerprint = peer.fingerprint256;
        if (!error) {
          this.store.seenValid(url.hostname);
          return done(null);
        }
        if (!fingerprint || this.isTrusted(url.hostname, fingerprint)) return done(null);
        const problem: CertificateProblem = {
          host: url.hostname,
          fingerprint,
          subject: nameOf(peer.subject),
          issuer: nameOf(peer.issuer),
          validUntil: new Date(peer.valid_to).toISOString(),
          error,
          origin,
          changed: this.changed(url.hostname, fingerprint),
          seenByChromium: false,
        };
        this.problems.set(problem.host, problem);
        done(problem);
      });
      socket.once("error", () => done(null));
      socket.once("timeout", () => done(null));
    });
  }
}

/** The authorities Chromium trusts too: Node's bundled ones and the system's (keychain, Windows store). */
function trustedAuthorities() {
  try {
    return [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])];
  } catch {
    return [...tls.rootCertificates];
  }
}

function nameOf(name: tls.PeerCertificate["subject"] | undefined) {
  if (!name) return "";
  const value = name.CN ?? name.O ?? "";
  return Array.isArray(value) ? value.join(", ") : value;
}

function fingerprintOf(certificate: Certificate) {
  try {
    return new X509Certificate(certificate.data).fingerprint256;
  } catch {
    return null;
  }
}

/** Whether a network error is about the server's certificate. */
export function isCertificateError(message: string) {
  return /ERR_CERT_/.test(message);
}
