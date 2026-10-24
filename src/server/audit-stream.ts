import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, lt, min, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvent, auditStream, auditStreamOutbox, user } from "@/db/schema";
import { MAX_WEBHOOK_URL } from "@/lib/automations";
import {
  AUDIT_STREAM_EVENT,
  AUDIT_STREAM_PING,
  STREAM_BATCH_SIZE,
  STREAM_BATCH_WAIT_MS,
  STREAM_KEEP_DAYS,
  auditStreamBody,
  batchDue,
  streamRetryDelayMs,
  streamedAuditEvent,
  type AuditStreamErrorCode,
} from "@/lib/audit-stream";
import { redactError } from "@/lib/redact";
import { requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { allowedHost, parseWebhookUrl, sendWebhook, WebhookError } from "@/server/automations/webhook";
import { open, seal } from "@/server/secret-box";
import { startSweep } from "@/server/sweep";

/**
 * Audit log streaming (Settings > Audit log): a workspace's owners send its new audit events to an
 * https address, such as their security tools' collector. A trigger on audit_event puts each new
 * event of a workspace whose stream is on into audit_stream_outbox, in the transaction recording
 * it; the sender here takes them from there oldest first, up to STREAM_BATCH_SIZE at a time, once
 * a batch is full or its oldest event waited STREAM_BATCH_WAIT_MS, and deletes them only when the
 * address answered 2xx. So events go in order and at least once: a batch whose answer was lost is
 * sent again, with the same delivery id. A failing address is tried again with growing waits, up
 * to an hour, for STREAM_KEEP_DAYS; events older than that are given up on and counted.
 *
 * Batches go as signed JSON POSTs the way page webhooks do (server/automations/webhook.ts: the
 * address checks, AUTOMATION_WEBHOOK_ALLOWED_HOSTS, X-Leafdesk-Signature). The signing secret is
 * random, sealed (server/secret-box.ts) and shown once. The stream belongs to the workspace, not
 * to the owner who saved it: events are no one's page content, and a security log mustn't stop
 * because someone left.
 */

/** How often the server looks for batches that are due. */
const SWEEP_INTERVAL_MS = 5_000;
/** Streams one round serves at most, and batches it sends to each. */
const ROUND_STREAMS = 20;
const ROUND_BATCHES = 10;
/** A claimed stream is held this long; one whose send never finished (the server stopped) is tried again after. */
const CLAIM_MS = 2 * 60_000;

export type AuditStreamErrorKind = "invalidUrl" | "httpsOnly" | "notFound";

export class AuditStreamError extends Error {
  constructor(
    readonly code: AuditStreamErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export type AuditStreamView = {
  url: string;
  enabled: boolean;
  updatedBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  /** How sending goes. */
  status: {
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    lastErrorCode: AuditStreamErrorCode | null;
    lastError: string | null;
    lastHttpStatus: number | null;
    failingSince: string | null;
    failures: number;
    nextAttemptAt: string | null;
    sentEvents: number;
    droppedEvents: number;
    lastDroppedAt: string | null;
    /** Events waiting to be sent, and since when the oldest of them. */
    waiting: number;
    oldestWaitingAt: string | null;
  };
};

const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

/** An address a stream may go to: https, or plain http for a host on AUTOMATION_WEBHOOK_ALLOWED_HOSTS. */
export function checkedStreamUrl(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_WEBHOOK_URL) throw new AuditStreamError("invalidUrl", "The stream needs an https address");
  let url: URL;
  try {
    url = parseWebhookUrl(text);
  } catch (error) {
    if (error instanceof WebhookError) throw new AuditStreamError("invalidUrl", error.message);
    throw error;
  }
  if (url.protocol !== "https:" && !allowedHost(url)) throw new AuditStreamError("httpsOnly", "Audit events go to https addresses");
  return url.toString();
}

/** The address as the audit log names it: its host, never its path or query (they can hold a key). */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

async function viewOf(workspaceId: string): Promise<AuditStreamView | null> {
  const [row] = await db
    .select({ stream: auditStream, updatedByName: user.name })
    .from(auditStream)
    .leftJoin(user, eq(user.id, auditStream.updatedBy))
    .where(eq(auditStream.workspaceId, workspaceId))
    .limit(1);
  if (!row) return null;
  const [waiting] = await db
    .select({ n: count(), oldest: min(auditStreamOutbox.createdAt) })
    .from(auditStreamOutbox)
    .where(eq(auditStreamOutbox.workspaceId, workspaceId));
  const s = row.stream;
  const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
  return {
    url: s.url,
    enabled: s.enabled,
    updatedBy: s.updatedBy ? { id: s.updatedBy, name: row.updatedByName ?? "" } : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    status: {
      lastSuccessAt: iso(s.lastSuccessAt),
      lastErrorAt: iso(s.lastErrorAt),
      lastErrorCode: s.lastErrorCode,
      lastError: s.lastError,
      lastHttpStatus: s.lastHttpStatus,
      failingSince: iso(s.failingSince),
      failures: s.failures,
      // Only a wait after failing; a claim held while sending isn't one.
      nextAttemptAt: s.failures > 0 ? iso(s.nextAttemptAt) : null,
      sentEvents: s.sentEvents,
      droppedEvents: s.droppedEvents,
      lastDroppedAt: iso(s.lastDroppedAt),
      waiting: waiting?.n ?? 0,
      oldestWaitingAt: iso(waiting?.oldest ?? null),
    },
  };
}

/** The workspace's stream and how it goes, or null without one. Owners only. */
export async function getAuditStream(actorId: string, workspaceId: string) {
  await requireMembership(actorId, workspaceId, "owner");
  return viewOf(workspaceId);
}

/**
 * Sets the stream up, or changes its address or whether it is on. A new stream gets its signing
 * secret, returned this once. Events recorded while it is off aren't sent later: turning it off
 * drops those waiting. A new address starts with a clean slate (no failures to back off from).
 * Owners only.
 */
export async function saveAuditStream(actorId: string, workspaceId: string, input: { url?: unknown; enabled?: unknown }) {
  await requireMembership(actorId, workspaceId, "owner");
  const [existing] = await db.select().from(auditStream).where(eq(auditStream.workspaceId, workspaceId)).limit(1);
  const url = input.url !== undefined || !existing ? checkedStreamUrl(input.url) : existing.url;
  const enabled = typeof input.enabled === "boolean" ? input.enabled : (existing?.enabled ?? true);
  let secret: string | null = null;
  if (!existing) {
    secret = newSecret();
    await db.insert(auditStream).values({ workspaceId, url, secret: seal(secret), enabled, updatedBy: actorId });
  } else {
    const fresh = url !== existing.url || (enabled && !existing.enabled);
    await db.transaction(async (tx) => {
      await tx
        .update(auditStream)
        .set({
          url,
          enabled,
          updatedBy: actorId,
          updatedAt: new Date(),
          ...(fresh ? { failures: 0, failingSince: null, nextAttemptAt: null, batchId: null } : {}),
        })
        .where(eq(auditStream.workspaceId, workspaceId));
      if (!enabled) await tx.delete(auditStreamOutbox).where(eq(auditStreamOutbox.workspaceId, workspaceId));
    });
  }
  await recordAudit({
    workspaceId,
    actorId,
    action: existing ? "audit_stream.updated" : "audit_stream.created",
    target: { type: "audit_stream", id: workspaceId, label: hostOf(url) },
    details: { enabled, ...(existing ? { previous: { enabled: existing.enabled }, addressChanged: url !== existing.url } : {}) },
  });
  return { stream: (await viewOf(workspaceId))!, secret };
}

/** A new signing secret, returned this once; the old one stops signing at once. Owners only. */
export async function replaceAuditStreamSecret(actorId: string, workspaceId: string) {
  await requireMembership(actorId, workspaceId, "owner");
  const secret = newSecret();
  const updated = await db
    .update(auditStream)
    .set({ secret: seal(secret), updatedBy: actorId, updatedAt: new Date() })
    .where(eq(auditStream.workspaceId, workspaceId))
    .returning({ url: auditStream.url });
  if (!updated.length) throw new AuditStreamError("notFound", "The workspace streams no audit events");
  await recordAudit({
    workspaceId,
    actorId,
    action: "audit_stream.secret_replaced",
    target: { type: "audit_stream", id: workspaceId, label: hostOf(updated[0].url) },
  });
  return secret;
}

/** Stops streaming for good: the address and secret go, and the events still waiting. Owners only. */
export async function removeAuditStream(actorId: string, workspaceId: string) {
  await requireMembership(actorId, workspaceId, "owner");
  const removed = await db.transaction(async (tx) => {
    const rows = await tx.delete(auditStream).where(eq(auditStream.workspaceId, workspaceId)).returning({ url: auditStream.url });
    await tx.delete(auditStreamOutbox).where(eq(auditStreamOutbox.workspaceId, workspaceId));
    return rows;
  });
  if (!removed.length) return false;
  await recordAudit({
    workspaceId,
    actorId,
    action: "audit_stream.removed",
    target: { type: "audit_stream", id: workspaceId, label: hostOf(removed[0].url) },
  });
  return true;
}

export type StreamSendResult =
  | { ok: true; httpStatus: number }
  | { ok: false; code: AuditStreamErrorCode; httpStatus: number | null; error: string };

async function post(url: string, sealedSecret: string, deliveryId: string, event: string, body: string): Promise<StreamSendResult> {
  try {
    const httpStatus = await sendWebhook(url, { id: deliveryId, event, body, secret: open(sealedSecret) });
    return { ok: true, httpStatus };
  } catch (error) {
    if (!(error instanceof WebhookError)) throw error;
    return { ok: false, code: error.code, httpStatus: error.httpStatus, error: error.message };
  }
}

/**
 * Sends a test batch now (*Send test event*): one made-up event, `test: true`, X-Leafdesk-Event
 * `ping`, signed like the rest. It says how the address answered and changes nothing else (it
 * isn't tried again, nor counted in the stream's status). Owners only.
 */
export async function sendAuditStreamTest(actorId: string, workspaceId: string): Promise<StreamSendResult> {
  await requireMembership(actorId, workspaceId, "owner");
  const [stream] = await db.select().from(auditStream).where(eq(auditStream.workspaceId, workspaceId)).limit(1);
  if (!stream) throw new AuditStreamError("notFound", "The workspace streams no audit events");
  const now = new Date();
  const [actor] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, actorId)).limit(1);
  const deliveryId = randomUUID();
  const body = auditStreamBody({
    deliveryId,
    workspaceId,
    sentAt: now,
    test: true,
    events: [
      {
        id: randomUUID(),
        time: now.toISOString(),
        action: "audit_stream.test",
        category: null,
        actor: { kind: "user", id: actorId, name: actor?.name ?? "", email: actor?.email ?? null, via: null, ip: null, user_agent: null },
        target: { type: "audit_stream", id: workspaceId, label: hostOf(stream.url) },
        details: {},
      },
    ],
  });
  return post(stream.url, stream.secret, deliveryId, AUDIT_STREAM_PING, body);
}

// ------------------------------------------------------------------------------------- sender

type Stream = typeof auditStream.$inferSelect;

/** Claims streams with a batch due (see batchDue; one server at a time each), holding them for CLAIM_MS. */
async function claim(now: Date) {
  const nowIso = now.toISOString();
  const oldEnough = new Date(now.getTime() - STREAM_BATCH_WAIT_MS).toISOString();
  return db
    .update(auditStream)
    .set({ nextAttemptAt: new Date(now.getTime() + CLAIM_MS) })
    .where(
      inArray(
        auditStream.workspaceId,
        sql`(select s.workspace_id from ${auditStream} s
              where s.enabled and (s.next_attempt_at is null or s.next_attempt_at <= ${nowIso}::timestamptz)
                and exists (select 1 from ${auditStreamOutbox} o where o.workspace_id = s.workspace_id)
                and (s.failures > 0
                  or exists (select 1 from ${auditStreamOutbox} o where o.workspace_id = s.workspace_id and o.created_at <= ${oldEnough}::timestamptz)
                  or (select count(*) from (select 1 from ${auditStreamOutbox} o where o.workspace_id = s.workspace_id limit ${STREAM_BATCH_SIZE}) full_batch) >= ${STREAM_BATCH_SIZE})
              order by s.next_attempt_at nulls first
              limit ${ROUND_STREAMS}
              for update skip locked)`,
      ),
    )
    .returning();
}

/** The events waiting for a stream, oldest first: the next batch. */
async function nextBatch(workspaceId: string) {
  return db
    .select({
      id: auditEvent.id,
      action: auditEvent.action,
      actorKind: auditEvent.actorKind,
      actorUserId: auditEvent.actorUserId,
      actorName: auditEvent.actorName,
      actorEmail: auditEvent.actorEmail,
      actorVia: auditEvent.actorVia,
      targetType: auditEvent.targetType,
      targetId: auditEvent.targetId,
      targetLabel: auditEvent.targetLabel,
      details: auditEvent.details,
      ip: auditEvent.ip,
      userAgent: auditEvent.userAgent,
      createdAt: auditEvent.createdAt,
    })
    .from(auditStreamOutbox)
    .innerJoin(auditEvent, eq(auditEvent.id, auditStreamOutbox.eventId))
    .where(eq(auditStreamOutbox.workspaceId, workspaceId))
    .orderBy(asc(auditStreamOutbox.createdAt), asc(auditStreamOutbox.eventId))
    .limit(STREAM_BATCH_SIZE);
}

/** Sends a claimed stream's due batches, until one fails or none is due; returns how many went through. */
async function serve(stream: Stream, now: Date) {
  let sent = 0;
  let { failures, batchId } = stream;
  for (let round = 0; round < ROUND_BATCHES; round++) {
    const events = await nextBatch(stream.workspaceId);
    if (!batchDue({ waiting: events.length, oldestAt: events[0]?.createdAt ?? null, failures }, now)) break;
    const deliveryId = batchId ?? randomUUID();
    if (!batchId) await db.update(auditStream).set({ batchId: deliveryId }).where(eq(auditStream.workspaceId, stream.workspaceId));
    const body = auditStreamBody({ deliveryId, workspaceId: stream.workspaceId, sentAt: new Date(), events: events.map(streamedAuditEvent) });
    const result = await post(stream.url, stream.secret, deliveryId, AUDIT_STREAM_EVENT, body);
    if (!result.ok) {
      failures += 1;
      await db
        .update(auditStream)
        .set({
          failures,
          failingSince: stream.failingSince ?? now,
          lastErrorAt: now,
          lastErrorCode: result.code,
          lastError: result.error.slice(0, 500),
          lastHttpStatus: result.httpStatus,
          nextAttemptAt: new Date(now.getTime() + streamRetryDelayMs(failures)),
        })
        .where(eq(auditStream.workspaceId, stream.workspaceId));
      return sent;
    }
    await db.transaction(async (tx) => {
      await tx.delete(auditStreamOutbox).where(
        and(
          eq(auditStreamOutbox.workspaceId, stream.workspaceId),
          inArray(
            auditStreamOutbox.eventId,
            events.map((e) => e.id),
          ),
        ),
      );
      await tx
        .update(auditStream)
        .set({
          batchId: null,
          failures: 0,
          failingSince: null,
          lastSuccessAt: now,
          lastHttpStatus: result.httpStatus,
          sentEvents: sql`${auditStream.sentEvents} + ${events.length}`,
        })
        .where(eq(auditStream.workspaceId, stream.workspaceId));
    });
    sent++;
    failures = 0;
    batchId = null;
  }
  // Free for the next round (a failure above keeps its wait instead).
  await db.update(auditStream).set({ nextAttemptAt: null }).where(and(eq(auditStream.workspaceId, stream.workspaceId), eq(auditStream.failures, 0)));
  return sent;
}

/** Gives up on events that waited longer than STREAM_KEEP_DAYS, counting them on their streams. */
async function dropStale(now: Date) {
  const before = new Date(now.getTime() - STREAM_KEEP_DAYS * 86_400_000);
  const dropped = await db.delete(auditStreamOutbox).where(lt(auditStreamOutbox.createdAt, before)).returning({ workspaceId: auditStreamOutbox.workspaceId });
  const counts = new Map<string, number>();
  for (const { workspaceId } of dropped) counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
  for (const [workspaceId, n] of counts) {
    await db
      .update(auditStream)
      .set({ droppedEvents: sql`${auditStream.droppedEvents} + ${n}`, lastDroppedAt: now })
      .where(eq(auditStream.workspaceId, workspaceId));
  }
}

/** One round as of `now`: stale events are given up on, and due batches sent. Returns how many batches went through. */
export async function runAuditStreams(now: Date = new Date()) {
  await dropStale(now);
  const streams = await claim(now);
  let sent = 0;
  for (const stream of streams) {
    try {
      sent += await serve(stream, now);
    } catch (error) {
      console.error("[audit-stream] could not send a batch", redactError(error));
      // Tried again after the claim runs out.
    }
  }
  return sent;
}

/** Starts the sender. */
export function startAuditStreams() {
  return startSweep(SWEEP_INTERVAL_MS, () => runAuditStreams(), "could not stream audit events");
}
