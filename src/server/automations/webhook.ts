import { createHmac, randomBytes } from "node:crypto";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import {
  MAX_WEBHOOK_URL,
  signatureHeader,
  signedContent,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "@/lib/automations";
import { env } from "@/lib/env";
import { checkTarget, LinkPreviewError, type PreviewGuard } from "../link-preview";

/**
 * Automation webhooks: a signed JSON POST to an address someone with full access to the database
 * typed. Guarded like link previews (server/link-preview): http(s) only, no credentials in the
 * URL, the usual web ports, and every address of the host public, with the connection pinned to
 * the checked address. Hosts in AUTOMATION_WEBHOOK_ALLOWED_HOSTS skip the address and port checks,
 * for services on the server's own network. Redirects aren't followed (a webhook that moved
 * should be changed), ten seconds in all, and only the status is read back.
 */

export const WEBHOOK_TIMEOUT_MS = 10_000;
const USER_AGENT = "Leafdesk-Webhook/1.0";

/** A fresh salt for a new automation, or to replace an automation's secret. */
export const newSecretSalt = () => randomBytes(18).toString("base64url");

/** The signing secret of an automation: derived from its salt and the server's secret, never stored. */
export function webhookSecret(salt: string) {
  return `whsec_${createHmac("sha256", env.authSecret).update(`automation-webhook:${salt}`).digest("base64url")}`;
}

/** The signature header value for `body`, sent at `timestamp` (Unix seconds). */
export function signWebhook(secret: string, timestamp: number, body: string) {
  const hex = createHmac("sha256", secret).update(signedContent(timestamp, body)).digest("hex");
  return signatureHeader(timestamp, hex);
}

export class WebhookError extends Error {
  constructor(
    readonly code: "invalidUrl" | "blocked" | "unreachable" | "timeout" | "redirect" | "http",
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

/** Whether `url` is on the allowed hosts list (by host name, or host and port). */
export function allowedHost(url: URL, allowed = env.automationWebhookAllowedHosts) {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return allowed.includes(host) || allowed.includes(`${host}:${port}`);
}

/** Parses and checks a webhook address when it's saved: the shape only (DNS is checked when sending). */
export function parseWebhookUrl(value: string) {
  const text = value.trim();
  if (!text || text.length > MAX_WEBHOOK_URL) throw new WebhookError("invalidUrl", "A webhook needs an http(s) address");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new WebhookError("invalidUrl", "Not a valid address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebhookError("invalidUrl", "Only http and https addresses");
  if (url.username || url.password) throw new WebhookError("invalidUrl", "Credentials in the address");
  return url;
}

/**
 * Checks where a webhook goes, right before it is sent; returns the address to connect to, or
 * null for an allowed host, which the system resolves as it would for any other program.
 */
export async function webhookTarget(url: URL, guard: Partial<PreviewGuard> = {}): Promise<LookupAddress | null> {
  if (allowedHost(url)) return null;
  return checkTarget(url, guard);
}

export type WebhookDelivery = { id: string; event: string; body: string; secret: string };

/** Sends one webhook; resolves with the status when it answers 2xx, throws a WebhookError otherwise. */
export async function sendWebhook(urlText: string, delivery: WebhookDelivery, guard: Partial<PreviewGuard> = {}) {
  const url = parseWebhookUrl(urlText);
  let address: LookupAddress | null;
  try {
    address = await webhookTarget(url, guard);
  } catch (error) {
    if (error instanceof LinkPreviewError) {
      throw new WebhookError(error.code === "blocked" ? "blocked" : error.code === "invalidUrl" ? "invalidUrl" : "unreachable", error.message);
    }
    throw error;
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    [WEBHOOK_EVENT_HEADER]: delivery.event,
    [WEBHOOK_DELIVERY_HEADER]: delivery.id,
    [WEBHOOK_SIGNATURE_HEADER]: signWebhook(delivery.secret, timestamp, delivery.body),
    "content-length": String(Buffer.byteLength(delivery.body)),
  };
  const pinned: LookupFunction | undefined = address
    ? (_hostname, options, callback) => {
        if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, [address]);
        else callback(null, address.address, address.family);
      }
    : undefined;
  const client = url.protocol === "https:" ? https : http;
  const signal = AbortSignal.timeout(WEBHOOK_TIMEOUT_MS);
  const status = await new Promise<number>((resolve, reject) => {
    const req = client.request(url, { method: "POST", ...(pinned ? { lookup: pinned } : {}), agent: false, signal, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", (error) =>
      reject(
        signal.aborted || (error as { name?: string }).name === "AbortError"
          ? new WebhookError("timeout", "No answer within 10 seconds")
          : new WebhookError("unreachable", error.message),
      ),
    );
    req.end(delivery.body);
  });
  if (status >= 300 && status < 400) throw new WebhookError("redirect", `Answered with a redirect (${status})`, status);
  if (status < 200 || status >= 300) throw new WebhookError("http", `Answered ${status}`, status);
  return status;
}
