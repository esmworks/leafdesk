import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_DELIVERY_HEADER, WEBHOOK_EVENT_HEADER, WEBHOOK_SIGNATURE_HEADER, signedContent } from "@/lib/automations";
import { EVENT_TOLERANCE_SECONDS, type EventPreset } from "@/lib/connections";

/**
 * Checking a connection's event: its signature as the connection's preset says (see events.ts),
 * how fresh it is, its type and its delivery id. No database here, so it can be tested alone.
 */

const hmacHex = (secret: string, text: string) => createHmac("sha256", secret).update(text).digest("hex");

function sameHex(a: string, b: string) {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function freshTimestamp(seconds: number, now = Date.now()) {
  return Number.isFinite(seconds) && Math.abs(now / 1000 - seconds) <= EVENT_TOLERANCE_SECONDS;
}

export type Verified = { ok: true; type: string; deliveryId: string; payload: unknown; reply?: Record<string, unknown> } | { ok: false; status: number; error: string };

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Checks an event's signature as its preset says, and names its type and delivery. */
export function verifyEvent(preset: EventPreset, secret: string, headers: Headers, body: string, now = Date.now()): Verified {
  const refused = (error: string, status = 401): Verified => ({ ok: false, status, error });
  if (preset === "hmac") {
    const header = headers.get(WEBHOOK_SIGNATURE_HEADER) ?? "";
    const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
    const t = Number(parts.t);
    if (!parts.t || !parts.v1) return refused("Missing signature");
    if (!freshTimestamp(t, now)) return refused("Stale timestamp");
    if (!sameHex(hmacHex(secret, signedContent(t, body)), parts.v1)) return refused("Bad signature");
    const deliveryId = headers.get(WEBHOOK_DELIVERY_HEADER)?.trim() || parts.v1;
    const type = headers.get(WEBHOOK_EVENT_HEADER)?.trim() || "event";
    return { ok: true, type, deliveryId, payload: parse(body) };
  }
  if (preset === "slack") {
    const signature = headers.get("x-slack-signature") ?? "";
    const t = Number(headers.get("x-slack-request-timestamp"));
    if (!signature || !freshTimestamp(t, now)) return refused(signature ? "Stale timestamp" : "Missing signature");
    if (!sameHex(`v0=${hmacHex(secret, `v0:${t}:${body}`)}`, signature)) return refused("Bad signature");
    const payload = asRecord(parse(body));
    if (payload.type === "url_verification") {
      return { ok: true, type: "url_verification", deliveryId: `url_verification:${t}`, payload, reply: { challenge: payload.challenge } };
    }
    const event = asRecord(payload.event);
    const type = typeof event.type === "string" ? event.type : typeof payload.type === "string" ? payload.type : "event";
    const deliveryId = typeof payload.event_id === "string" ? payload.event_id : `${t}:${signature}`;
    return { ok: true, type, deliveryId, payload };
  }
  const signature = headers.get("x-hub-signature-256") ?? "";
  if (!signature) return refused("Missing signature");
  if (!sameHex(`sha256=${hmacHex(secret, body)}`, signature)) return refused("Bad signature");
  const deliveryId = headers.get("x-github-delivery")?.trim();
  if (!deliveryId) return refused("Missing delivery id", 400);
  const payload = parse(body);
  const action = asRecord(payload).action;
  const name = headers.get("x-github-event")?.trim() || "event";
  return { ok: true, type: typeof action === "string" ? `${name}.${action}` : name, deliveryId, payload };
}

/** Whether a trigger's type takes an event's: any, the same, or its family ("issues" takes "issues.opened"). */
export function triggerMatches(triggerType: string | null, eventType: string) {
  return !triggerType || triggerType === eventType || eventType.startsWith(`${triggerType}.`);
}
