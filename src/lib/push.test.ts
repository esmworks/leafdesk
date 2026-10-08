import { describe, expect, it } from "vitest";
import { encodePushPayload, MAX_PUSH_PAYLOAD, parsePushSubscription, pushLink, pushPayload, vapidFrom, type PushItem } from "./push";

const b64 = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64url");

describe("vapidFrom", () => {
  const keys = { VAPID_PUBLIC_KEY: b64(65), VAPID_PRIVATE_KEY: b64(32), VAPID_SUBJECT: "mailto:ops@example.com" };

  it("needs all three, with keys of the right size and a mailto: or https: subject", () => {
    expect(vapidFrom(keys)).toEqual({ publicKey: keys.VAPID_PUBLIC_KEY, privateKey: keys.VAPID_PRIVATE_KEY, subject: "mailto:ops@example.com" });
    expect(vapidFrom({ ...keys, VAPID_SUBJECT: "https://leafdesk.example.com" })?.subject).toBe("https://leafdesk.example.com");
    expect(vapidFrom({})).toBeNull();
    expect(vapidFrom({ ...keys, VAPID_PRIVATE_KEY: "" })).toBeNull();
    expect(vapidFrom({ ...keys, VAPID_SUBJECT: "ops@example.com" })).toBeNull();
    expect(vapidFrom({ ...keys, VAPID_SUBJECT: "http://example.com" })).toBeNull();
    expect(vapidFrom({ ...keys, VAPID_PUBLIC_KEY: b64(64) })).toBeNull();
    expect(vapidFrom({ ...keys, VAPID_PRIVATE_KEY: "not base64url!" })).toBeNull();
  });

  it("takes keys with padding or spaces around them", () => {
    expect(vapidFrom({ ...keys, VAPID_PUBLIC_KEY: ` ${keys.VAPID_PUBLIC_KEY}= ` })?.publicKey).toBe(keys.VAPID_PUBLIC_KEY);
  });
});

describe("parsePushSubscription", () => {
  const valid = { endpoint: "https://push.example.com/send/abc", p256dh: b64(65), auth: b64(16) };

  it("takes an https endpoint with a P-256 key and a 16-byte secret", () => {
    expect(parsePushSubscription(valid)).toEqual(valid);
  });

  it("refuses anything else", () => {
    expect(parsePushSubscription(null)).toBeNull();
    expect(parsePushSubscription({ ...valid, endpoint: "http://push.example.com/send/abc" })).toBeNull();
    expect(parsePushSubscription({ ...valid, endpoint: "https://user:pw@push.example.com/x" })).toBeNull();
    expect(parsePushSubscription({ ...valid, endpoint: "javascript:alert(1)" })).toBeNull();
    expect(parsePushSubscription({ ...valid, endpoint: `https://push.example.com/${"a".repeat(2100)}` })).toBeNull();
    expect(parsePushSubscription({ ...valid, p256dh: b64(33) })).toBeNull();
    expect(parsePushSubscription({ ...valid, auth: b64(8) })).toBeNull();
    expect(parsePushSubscription({ ...valid, auth: 16 })).toBeNull();
  });

  it("takes plain http only for allowed hosts", () => {
    const local = { ...valid, endpoint: "http://127.0.0.1:8080/push" };
    expect(parsePushSubscription(local)).toBeNull();
    expect(parsePushSubscription(local, ["127.0.0.1:8080"])?.endpoint).toBe("http://127.0.0.1:8080/push");
    expect(parsePushSubscription(local, ["127.0.0.1:9090"])).toBeNull();
  });
});

const texts: Record<string, string> = {
  assignment: "{actor} assigned you to “{property}”",
  pageShared: "{actor} shared this page with you",
  comment: "{actor} commented in a thread you're in",
  mention: "{actor} mentioned you",
  reminder: "Reminder: {date}",
  accessRequest: "{actor} asked for access to this page",
  automation: "Automation “{name}”: {actor} added or changed this row",
  someone: "Someone",
  joinRequestTitle: "Join request",
  joinRequest: "{actor} asked to join",
  inviteRequest: "{actor} asked to invite {email}",
  approvalTitle: "{agent} asks to go ahead",
  approval: "Wants to call “{tool}” on {connection}",
  untitled: "Untitled",
};
const t = (key: string, values: Record<string, string> = {}) => texts[key].replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
const date = (iso: string) => `on ${iso}`;

const item = (over: Partial<PushItem>): PushItem => ({
  id: "n1",
  kind: "mention",
  workspaceId: "ws1",
  actorName: "Ayşe",
  pageId: "p1",
  pageTitle: "Roadmap",
  databaseTitle: null,
  propertyName: null,
  reminderDate: null,
  automationName: null,
  accessRequest: null,
  requestKind: null,
  requestEmail: null,
  approval: null,
  ...over,
});

describe("pushPayload", () => {
  it("says what the inbox says: the page, then who did what", () => {
    expect(pushPayload(item({}), t, date)).toEqual({ title: "Roadmap", body: "Ayşe mentioned you", url: "/w/ws1/p/p1", tag: "n1" });
    expect(pushPayload(item({ kind: "comment", pageTitle: "  " }), t, date)).toMatchObject({ title: "Untitled", body: "Ayşe commented in a thread you're in" });
    expect(pushPayload(item({ kind: "page_shared", actorName: null }), t, date)?.body).toBe("Someone shared this page with you");
    expect(pushPayload(item({ kind: "reminder", actorName: null, reminderDate: "2026-10-09" }), t, date)?.body).toBe("Reminder: on 2026-10-09");
  });

  it("names the database of a row, and the property of an assignment", () => {
    const row = item({ kind: "assignment", pageTitle: "Fix login", databaseTitle: "Tasks", propertyName: "Owner" });
    expect(pushPayload(row, t, date)).toMatchObject({ title: "Fix login", body: "Ayşe assigned you to “Owner” · Tasks" });
    const automated = item({ kind: "automation", pageTitle: "Fix login", databaseTitle: "", automationName: "Done" });
    expect(pushPayload(automated, t, date)?.body).toBe("Automation “Done”: Ayşe added or changed this row · Untitled");
  });

  it("names a requester without a name by their email", () => {
    const request = item({ kind: "access_request", actorName: null, accessRequest: { requesterEmail: "vera@example.com" } });
    expect(pushPayload(request, t, date)?.body).toBe("vera@example.com asked for access to this page");
  });

  it("leads join requests to the members' requests, and agents' calls to the run", () => {
    const join = item({ kind: "join_request", pageId: null, pageTitle: null, requestKind: "invite", requestEmail: "new@example.com" });
    expect(pushPayload(join, t, date)).toEqual({
      title: "Join request",
      body: "Ayşe asked to invite new@example.com",
      url: "/w/ws1/settings?tab=members&view=requests",
      tag: "n1",
    });
    const approval = { agentId: "a1", runId: "r1", agentName: "Helper", tool: "send_mail", connectionName: "Mail" };
    const call = item({ kind: "agent_approval", pageId: null, pageTitle: null, approval });
    expect(pushPayload(call, t, date)).toEqual({
      title: "Helper asks to go ahead",
      body: "Wants to call “send_mail” on Mail",
      url: "/w/ws1/settings?tab=agents&agent=a1&run=r1",
      tag: "n1",
    });
    // Answered (or ran out of time) before the push went out: nothing to say.
    expect(pushPayload(item({ kind: "agent_approval", pageId: null, approval: null }), t, date)).toBeNull();
  });

  it("links like the inbox does", () => {
    expect(pushLink(item({ kind: "agent_approval", pageId: null }))).toBe("/w/ws1/settings?tab=agents");
  });
});

describe("encodePushPayload", () => {
  const payload = { title: "Roadmap", body: "Ayşe mentioned you", url: "https://leafdesk.example.com/w/ws1/p/p1", tag: "n1" };

  it("is the payload as JSON", () => {
    expect(JSON.parse(encodePushPayload(payload))).toEqual(payload);
  });

  it("cuts long texts to fit the limit, keeping the link and tag", () => {
    const long = { ...payload, title: "ğ".repeat(5_000), body: "ş".repeat(5_000) };
    const json = encodePushPayload(long);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD);
    const decoded = JSON.parse(json);
    expect(decoded.url).toBe(payload.url);
    expect(decoded.tag).toBe("n1");
    expect(decoded.title.endsWith("…")).toBe(true);
    expect(decoded.body.endsWith("…")).toBe(true);
  });
});
