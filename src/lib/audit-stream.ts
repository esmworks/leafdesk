/**
 * Audit log streaming (server/audit-stream.ts): a workspace's new audit events go to an https
 * address of its owners' choosing as signed JSON batches, the way page webhooks are signed. Pure:
 * the event and batch shapes (also what the REST API's audit log answers), batching and backoff.
 */

import { auditCategoryOf, type AuditCategory, type AuditEvent } from "./audit";

/** X-Leafdesk-Event of a batch of events, and of a test (*Send test event*). */
export const AUDIT_STREAM_EVENT = "audit.events";
export const AUDIT_STREAM_PING = "ping";

/** A batch holds at most this many events. */
export const STREAM_BATCH_SIZE = 100;
/** A batch goes out once it is full, or once its oldest event has waited this long. */
export const STREAM_BATCH_WAIT_MS = 30_000;
/** Events not taken by the address within this many days are given up on (and counted). */
export const STREAM_KEEP_DAYS = 7;

/**
 * Why a batch didn't go through: the address (`invalidUrl`, `blocked`: a private address the
 * server may not reach), the way to it (`unreachable`, `timeout`), or its answer (`redirect`,
 * `http`: anything but 2xx).
 */
export type AuditStreamErrorCode = "invalidUrl" | "blocked" | "unreachable" | "timeout" | "redirect" | "http";

/**
 * How long to wait before trying a batch again after `failures` failed tries in a row: growing,
 * up to an hour. Batches are tried until they go through or STREAM_KEEP_DAYS pass.
 */
export function streamRetryDelayMs(failures: number) {
  const steps = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
  return steps[Math.min(Math.max(failures, 1), steps.length) - 1];
}

/** One audit event as it is streamed and as the REST API reads it. */
export type StreamedAuditEvent = {
  id: string;
  time: string;
  action: string;
  /** The settings tab's category of the action; null for one this version doesn't know. */
  category: AuditCategory | null;
  actor: {
    kind: AuditEvent["actorKind"];
    id: string | null;
    name: string;
    email: string | null;
    /** The API token's, connected app's, SCIM token's or automation's name. */
    via: string | null;
    ip: string | null;
    user_agent: string | null;
  };
  target: { type: string; id: string | null; label: string } | null;
  details: Record<string, unknown>;
};

export function streamedAuditEvent(event: AuditEvent): StreamedAuditEvent {
  return {
    id: event.id,
    time: event.createdAt.toISOString(),
    action: event.action,
    category: auditCategoryOf(event.action),
    actor: {
      kind: event.actorKind,
      id: event.actorUserId,
      name: event.actorName,
      email: event.actorEmail,
      via: event.actorVia,
      ip: event.ip,
      user_agent: event.userAgent,
    },
    target: event.targetType ? { type: event.targetType, id: event.targetId, label: event.targetLabel } : null,
    details: event.details,
  };
}

/**
 * The body of one batch: `id` is its delivery id (the X-Leafdesk-Delivery header, the same each
 * time the batch is tried again), `events` oldest first. A test carries `test: true`.
 */
export function auditStreamBody(input: { deliveryId: string; workspaceId: string; sentAt: Date; events: StreamedAuditEvent[]; test?: boolean }) {
  return JSON.stringify({
    id: input.deliveryId,
    type: input.test ? AUDIT_STREAM_PING : AUDIT_STREAM_EVENT,
    workspace_id: input.workspaceId,
    sent_at: input.sentAt.toISOString(),
    ...(input.test ? { test: true } : {}),
    events: input.events,
  });
}

/** Whether a batch is due: full, or its oldest event waited long enough, or it is being tried again. */
export function batchDue({ waiting, oldestAt, failures }: { waiting: number; oldestAt: Date | null; failures: number }, now: Date) {
  if (!waiting || !oldestAt) return false;
  return failures > 0 || waiting >= STREAM_BATCH_SIZE || now.getTime() - oldestAt.getTime() >= STREAM_BATCH_WAIT_MS;
}
