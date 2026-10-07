import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { triggerMatches, verifyEvent } from "./verify";

const SECRET = "whsec_test_secret";
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const t = Math.floor(NOW / 1000);
const hmac = (text: string, secret = SECRET) => createHmac("sha256", secret).update(text).digest("hex");

describe("verifyEvent: hmac", () => {
  const body = JSON.stringify({ lead: "Ada" });
  const headers = (extra: Record<string, string> = {}) =>
    new Headers({ "X-Leafdesk-Signature": `t=${t},v1=${hmac(`${t}.${body}`)}`, "X-Leafdesk-Event": "lead.created", "X-Leafdesk-Delivery": "d-1", ...extra });

  it("takes a signed event, with its type, delivery and body", () => {
    expect(verifyEvent("hmac", SECRET, headers(), body, NOW)).toEqual({
      ok: true,
      type: "lead.created",
      deliveryId: "d-1",
      signature: `${t}.${hmac(`${t}.${body}`)}`,
      payload: { lead: "Ada" },
    });
  });

  it("gives the same signature for the same request whatever its unsigned delivery id, and a new one when signed again", () => {
    const first = verifyEvent("hmac", SECRET, headers(), body, NOW);
    const renamed = verifyEvent("hmac", SECRET, headers({ "X-Leafdesk-Delivery": "d-2" }), body, NOW);
    const later = t + 1;
    const resigned = verifyEvent("hmac", SECRET, headers({ "X-Leafdesk-Signature": `t=${later},v1=${hmac(`${later}.${body}`)}` }), body, NOW);
    expect(first.ok && renamed.ok && first.signature === renamed.signature && first.deliveryId !== renamed.deliveryId).toBe(true);
    expect(resigned.ok && first.ok && resigned.signature !== first.signature && resigned.deliveryId === first.deliveryId).toBe(true);
  });

  it("refuses a missing, wrong or stale signature", () => {
    expect(verifyEvent("hmac", SECRET, new Headers(), body, NOW)).toMatchObject({ ok: false, status: 401 });
    expect(verifyEvent("hmac", "other", headers(), body, NOW)).toMatchObject({ ok: false, status: 401 });
    expect(verifyEvent("hmac", SECRET, headers(), `${body} `, NOW)).toMatchObject({ ok: false, status: 401 });
    expect(verifyEvent("hmac", SECRET, headers(), body, NOW + 6 * 60_000)).toMatchObject({ ok: false, error: "Stale timestamp" });
    expect(verifyEvent("hmac", SECRET, headers({ "X-Leafdesk-Signature": `t=${t},v1=zz` }), body, NOW)).toMatchObject({ ok: false });
  });

  it("names an untyped event `event`, and keys a delivery without an id by its signature", () => {
    const sig = hmac(`${t}.${body}`);
    const result = verifyEvent("hmac", SECRET, new Headers({ "X-Leafdesk-Signature": `t=${t},v1=${sig}` }), body, NOW);
    expect(result).toMatchObject({ ok: true, type: "event", deliveryId: sig });
  });
});

describe("verifyEvent: slack", () => {
  const signed = (body: string, at = t) => new Headers({ "X-Slack-Signature": `v0=${hmac(`v0:${at}:${body}`)}`, "X-Slack-Request-Timestamp": String(at) });

  it("answers Slack's URL check once its signature holds", () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    expect(verifyEvent("slack", SECRET, signed(body), body, NOW)).toMatchObject({ ok: true, reply: { challenge: "abc" } });
    expect(verifyEvent("slack", "other", signed(body), body, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  it("takes an event callback by its inner type and event id", () => {
    const body = JSON.stringify({ type: "event_callback", event_id: "Ev1", event: { type: "app_mention", text: "hi" } });
    expect(verifyEvent("slack", SECRET, signed(body), body, NOW)).toMatchObject({ ok: true, type: "app_mention", deliveryId: "Ev1" });
  });

  it("refuses a stale request", () => {
    const body = "{}";
    expect(verifyEvent("slack", SECRET, signed(body, t - 600), body, NOW)).toMatchObject({ ok: false, error: "Stale timestamp" });
  });
});

describe("verifyEvent: github", () => {
  const body = JSON.stringify({ action: "opened", issue: { number: 1 } });
  const headers = (extra: Record<string, string> = {}) =>
    new Headers({ "X-Hub-Signature-256": `sha256=${hmac(body)}`, "X-GitHub-Event": "issues", "X-GitHub-Delivery": "g-1", ...extra });

  it("takes a signed delivery, typed by event and action", () => {
    expect(verifyEvent("github", SECRET, headers(), body, NOW)).toMatchObject({ ok: true, type: "issues.opened", deliveryId: "g-1" });
  });

  it("refuses a wrong signature or a delivery without an id", () => {
    expect(verifyEvent("github", "other", headers(), body, NOW)).toMatchObject({ ok: false, status: 401 });
    const noId = new Headers({ "X-Hub-Signature-256": `sha256=${hmac(body)}`, "X-GitHub-Event": "issues" });
    expect(verifyEvent("github", SECRET, noId, body, NOW)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("triggerMatches", () => {
  it("takes any event, the same type, or a type of its family", () => {
    expect(triggerMatches(null, "issues.opened")).toBe(true);
    expect(triggerMatches("issues", "issues")).toBe(true);
    expect(triggerMatches("issues", "issues.opened")).toBe(true);
    expect(triggerMatches("issues.opened", "issues.closed")).toBe(false);
    expect(triggerMatches("issue", "issues.opened")).toBe(false);
  });
});
