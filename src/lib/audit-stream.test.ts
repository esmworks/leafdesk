import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "./audit";
import {
  AUDIT_STREAM_EVENT,
  AUDIT_STREAM_PING,
  auditStreamBody,
  batchDue,
  STREAM_BATCH_SIZE,
  STREAM_BATCH_WAIT_MS,
  streamedAuditEvent,
  streamRetryDelayMs,
} from "./audit-stream";

vi.mock("@/lib/env", () => ({ env: { authSecret: "test-secret", automationWebhookAllowedHosts: [] } }));
const { signWebhook } = await import("@/server/automations/webhook");

const event = (extra: Partial<AuditEvent> = {}): AuditEvent => ({
  id: "ev-1",
  action: "member.role_changed",
  actorKind: "user",
  actorUserId: "u-1",
  actorName: "Ada",
  actorEmail: "ada@example.com",
  actorVia: null,
  targetType: "member",
  targetId: "u-2",
  targetLabel: "Bob",
  details: { from: "member", to: "owner" },
  ip: "192.0.2.1",
  userAgent: "Mozilla/5.0",
  createdAt: new Date("2026-10-24T10:00:00.123Z"),
  ...extra,
});

/** What a receiver does: recompute the HMAC of "<t>.<body>" and compare, within a few minutes of t. */
function verify(secret: string, header: string, body: string, nowSeconds: number) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(parts.v1 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

describe("streamedAuditEvent", () => {
  it("names each field as the stream and the REST API send it", () => {
    expect(streamedAuditEvent(event())).toEqual({
      id: "ev-1",
      time: "2026-10-24T10:00:00.123Z",
      action: "member.role_changed",
      category: "members",
      actor: { kind: "user", id: "u-1", name: "Ada", email: "ada@example.com", via: null, ip: "192.0.2.1", user_agent: "Mozilla/5.0" },
      target: { type: "member", id: "u-2", label: "Bob" },
      details: { from: "member", to: "owner" },
    });
  });

  it("has no target for an event without one, and no category for an action this version doesn't know", () => {
    const streamed = streamedAuditEvent(event({ action: "future.thing", targetType: null, targetId: null, targetLabel: "" }));
    expect(streamed.target).toBeNull();
    expect(streamed.category).toBeNull();
  });
});

describe("auditStreamBody", () => {
  const sentAt = new Date("2026-10-24T10:00:30Z");

  it("wraps the events, oldest first, with the delivery id", () => {
    const events = [streamedAuditEvent(event({ id: "a" })), streamedAuditEvent(event({ id: "b" }))];
    const body = JSON.parse(auditStreamBody({ deliveryId: "d-1", workspaceId: "w-1", sentAt, events }));
    expect(body).toEqual({ id: "d-1", type: AUDIT_STREAM_EVENT, workspace_id: "w-1", sent_at: "2026-10-24T10:00:30.000Z", events });
    expect(Object.keys(body)).toEqual(["id", "type", "workspace_id", "sent_at", "events"]);
  });

  it("marks a test", () => {
    const body = JSON.parse(auditStreamBody({ deliveryId: "d-2", workspaceId: "w-1", sentAt, events: [], test: true }));
    expect(body.type).toBe(AUDIT_STREAM_PING);
    expect(body.test).toBe(true);
  });

  it("is signed so the receiver can check it", () => {
    const body = auditStreamBody({ deliveryId: "d-1", workspaceId: "w-1", sentAt, events: [streamedAuditEvent(event())] });
    const t = Math.floor(sentAt.getTime() / 1000);
    const header = signWebhook("whsec_abc", t, body);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verify("whsec_abc", header, body, t + 5)).toBe(true);
    expect(verify("whsec_other", header, body, t + 5)).toBe(false);
    expect(verify("whsec_abc", header, body.replace("Ada", "Eve"), t + 5)).toBe(false);
    expect(verify("whsec_abc", header, body, t + 3600)).toBe(false);
  });
});

describe("batching", () => {
  const now = new Date("2026-10-24T10:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("sends a full batch at once, a smaller one after it waited", () => {
    expect(batchDue({ waiting: 0, oldestAt: null, failures: 0 }, now)).toBe(false);
    expect(batchDue({ waiting: 3, oldestAt: ago(1_000), failures: 0 }, now)).toBe(false);
    expect(batchDue({ waiting: 3, oldestAt: ago(STREAM_BATCH_WAIT_MS), failures: 0 }, now)).toBe(true);
    expect(batchDue({ waiting: STREAM_BATCH_SIZE, oldestAt: ago(1_000), failures: 0 }, now)).toBe(true);
  });

  it("tries a failed batch again without waiting for more", () => {
    expect(batchDue({ waiting: 1, oldestAt: ago(1_000), failures: 2 }, now)).toBe(true);
  });

  it("backs off, up to an hour", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 50].map(streamRetryDelayMs);
    expect(delays.slice(0, 3)).toEqual([30_000, 60_000, 120_000]);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    expect(Math.max(...delays)).toBe(3_600_000);
    expect(streamRetryDelayMs(0)).toBe(30_000);
  });
});

describe("streamed page events", () => {
  it("carry who could reach the page, and only page events do", () => {
    const page = event({ action: "page.published", targetType: "page", targetId: "p-1", targetLabel: "Docs", details: { audience: { kind: "web" } } });
    expect(streamedAuditEvent(page).target).toMatchObject({ type: "page", id: "p-1", audience: { kind: "web" } });
    expect(streamedAuditEvent(event()).target).not.toHaveProperty("audience");
    const bad = event({ targetType: "page", targetId: "p-1", details: { audience: "everyone" } });
    expect(streamedAuditEvent(bad).target).not.toHaveProperty("audience");
  });
});
