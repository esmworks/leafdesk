import { describe, expect, it } from "vitest";
import { AGENT_EMAIL_DOMAIN, agentEmail, callToSend, INBOX_CALL_CHARS, inboxCallInput, isAgentEmail } from "./agents";
import { redactValue } from "./redact";

describe("agents' addresses", () => {
  it("are in a domain that can't receive mail", () => {
    expect(agentEmail("abc")).toBe(`agent-abc@${AGENT_EMAIL_DOMAIN}`);
    expect(AGENT_EMAIL_DOMAIN.endsWith(".invalid")).toBe(true);
  });

  it("are told apart from people's, whatever the case or spacing", () => {
    expect(isAgentEmail(agentEmail("abc"))).toBe(true);
    expect(isAgentEmail(" Agent-X@Agents.Leafdesk.Invalid ")).toBe(true);
    expect(isAgentEmail("agent@leafdesk.invalid")).toBe(false);
    expect(isAgentEmail("someone@agents.leafdesk.invalid.example.com")).toBe(false);
    expect(isAgentEmail(null)).toBe(false);
    expect(isAgentEmail(undefined)).toBe(false);
  });
});

describe("a waiting call, as approvers see it", () => {
  const queue = [
    { id: "call-1", name: "crm__search", arguments: { query: "first" } },
    { id: "call-2", name: "crm__fetch", arguments: { url: "https://example.test/?sig=abc" } },
  ];

  it("is the call the run will send, from its saved queue", () => {
    expect(callToSend({ callId: "call-2" }, queue)).toEqual({ url: "https://example.test/?sig=abc" });
    expect(callToSend({ callId: "gone" }, queue)).toBeNull();
    expect(callToSend({ callId: "call-1" }, null)).toBeNull();
  });

  it("may be approved in the inbox when what it shows is all of what would be sent", () => {
    const args = { title: "A lead", tags: ["new"] };
    expect(inboxCallInput(redactValue(args), args)).toEqual({ input: JSON.stringify(args, null, 2), whole: true });
  });

  it("isn't, when a value is masked there: the masked text could hide what is sent", () => {
    const args = { url: "https://example.test/hook?api_key=secret-data-here", note: "ok" };
    const shown = redactValue(args);
    const { input, whole } = inboxCallInput(shown, args);
    expect(input).toContain("[redacted]");
    expect(input).not.toContain("secret-data-here");
    expect(whole).toBe(false);
  });

  it("isn't, when it is cut short", () => {
    const args = { body: `${"x".repeat(INBOX_CALL_CHARS)} hidden tail` };
    const { input, whole } = inboxCallInput(args, args);
    expect(input).toHaveLength(INBOX_CALL_CHARS);
    expect(input).not.toContain("hidden tail");
    expect(whole).toBe(false);
  });

  it("isn't, when the run no longer holds the call", () => {
    expect(inboxCallInput({ a: 1 }, null).whole).toBe(false);
  });
});
