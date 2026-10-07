import { describe, expect, it } from "vitest";
import { AGENT_EMAIL_DOMAIN, agentEmail, isAgentEmail } from "./agents";

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
