import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { connection, connectionEvent, connectionTrigger, workspaceAgent } from "@/db/schema";
import { MAX_EVENT_BYTES, MAX_TRIGGER_EVENT } from "@/lib/connections";
import { queueAgentRun } from "@/server/agents/run";
import { open } from "../secret-box";
import { triggerMatches, verifyEvent } from "./verify";

/**
 * Events a connection receives at `/api/connections/<id>/events`, signed as its preset says:
 * - `hmac`: `X-Leafdesk-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, as
 *   Leafdesk's own webhooks sign, with `X-Leafdesk-Event` (the type) and `X-Leafdesk-Delivery`;
 * - `slack`: Slack's `X-Slack-Signature` (`v0=` HMAC of `v0:<timestamp>:<body>`) and
 *   `X-Slack-Request-Timestamp`; Slack's URL check is answered once its signature holds;
 * - `github`: GitHub's `X-Hub-Signature-256`, `X-GitHub-Event` and `X-GitHub-Delivery` (GitHub
 *   sends no timestamp: its delivery id alone keeps a replay out).
 * A timestamp more than EVENT_TOLERANCE_SECONDS away is refused, and so is a delivery id seen
 * before. Each accepted event runs the agents of the connection's triggers that match its type
 * (a trigger for "issues" also takes "issues.opened").
 */

export type EventResponse = { status: number; body: Record<string, unknown> };

/** Events a connection takes per minute; more are refused with 429. */
const EVENTS_PER_MINUTE = 120;
const EVENT_BODY_CHARS = 8_000;

const g = globalThis as typeof globalThis & { __leafdeskEventRate?: Map<string, { minute: number; n: number }> };
const rate = (g.__leafdeskEventRate ??= new Map());

function overRate(connectionId: string) {
  const minute = Math.floor(Date.now() / 60_000);
  const entry = rate.get(connectionId);
  if (!entry || entry.minute !== minute) {
    rate.set(connectionId, { minute, n: 1 });
    if (rate.size > 10_000) rate.clear();
    return false;
  }
  entry.n += 1;
  return entry.n > EVENTS_PER_MINUTE;
}

/** Reads a request's body, refusing one over MAX_EVENT_BYTES. */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_EVENT_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_EVENT_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Takes an event for a connection: verifies it, keeps it, and queues the runs of matching triggers. */
export async function receiveEvent(connectionId: string, request: Request): Promise<EventResponse> {
  const [conn] = await db.select().from(connection).where(eq(connection.id, connectionId)).limit(1);
  if (!conn) return { status: 404, body: { error: "Unknown connection" } };
  if (overRate(conn.id)) return { status: 429, body: { error: "Too many events; slow down" } };
  const body = await readBody(request);
  if (body === null) return { status: 413, body: { error: "The event is too large" } };
  let secret: string;
  try {
    secret = open(conn.eventSecret);
  } catch {
    return { status: 500, body: { error: "The connection's signing secret can't be read" } };
  }
  const verified = verifyEvent(conn.eventPreset, secret, request.headers, body);
  if (!verified.ok) return { status: verified.status, body: { error: verified.error } };
  if (verified.reply) return { status: 200, body: verified.reply };
  const eventType = verified.type.slice(0, MAX_TRIGGER_EVENT);

  const [event] = await db
    .insert(connectionEvent)
    .values({ connectionId: conn.id, deliveryId: verified.deliveryId.slice(0, 200), eventType, status: "ignored", note: "" })
    .onConflictDoNothing()
    .returning({ id: connectionEvent.id });
  // Seen before (a retry, or a replay): already handled.
  if (!event) return { status: 200, body: { ok: true, duplicate: true } };

  const triggers = await db
    .select({ trigger: connectionTrigger, agentEnabled: workspaceAgent.enabled })
    .from(connectionTrigger)
    .innerJoin(workspaceAgent, and(eq(workspaceAgent.id, connectionTrigger.agentId), isNull(workspaceAgent.archivedAt)))
    .where(and(eq(connectionTrigger.connectionId, conn.id), eq(connectionTrigger.enabled, true)));
  const matching = triggers.filter((t) => t.agentEnabled && triggerMatches(t.trigger.eventType, eventType));
  const text = typeof verified.payload === "string" ? verified.payload : JSON.stringify(verified.payload, null, 1);
  const runIds: string[] = [];
  for (const { trigger } of matching) {
    runIds.push(
      await queueAgentRun({
        agentId: trigger.agentId,
        workspaceId: conn.workspaceId,
        source: { kind: "connection", connectionId: conn.id, triggerId: trigger.id, eventId: event.id },
        context: { eventType, body: text.slice(0, EVENT_BODY_CHARS) },
        prompt: trigger.prompt,
      }),
    );
  }
  await db
    .update(connectionEvent)
    .set(runIds.length ? { status: "queued", note: String(runIds.length) } : { status: "ignored", note: triggers.length ? "noMatch" : "noTrigger" })
    .where(eq(connectionEvent.id, event.id));
  return { status: 202, body: { ok: true, runs: runIds.length } };
}
