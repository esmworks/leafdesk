/**
 * An agent's email to its recipients (send-mail.ts): a finished message goes to the agent's
 * addresses only, once a run; one that isn't finished, or a second, sends nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ calls: [] as { to: string[]; subject: string; text: string; fromName: string }[], fail: false }));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/workspaces", () => ({ workspaceSettings: async () => ({ email: true }) }));
vi.mock("@/server/row-mail/send", () => ({
  sendFromMailbox: async (_box: unknown, message: (typeof sent.calls)[number]) => {
    if (sent.fail) throw new Error("auth: Invalid credentials");
    sent.calls.push(message);
  },
}));

const { sendAgentEmail, sendEmailTool } = await import("./send-mail");

const sender = { userId: "u1", name: "Erhan", box: { address: "erhan@example.com" } as never };
const recipients = ["planning@example.com", "sales@example.com"];
const message = { subject: "Overdue orders, 29 October", text: "Good morning,\n\nThree orders are past their delivery date:\n- G-1\n- G-2\n- G-3\n\nErhan" };

describe("sendAgentEmail", () => {
  beforeEach(() => {
    sent.calls = [];
    sent.fail = false;
  });

  it("sends a finished message to the agent's recipients and records it", async () => {
    const out = await sendAgentEmail({ sender, recipients, args: { ...message, to: "someone@else.com" }, sentBefore: false });
    expect(out.isError).toBeUndefined();
    expect(sent.calls).toEqual([{ fromName: "Erhan", to: recipients, subject: message.subject, text: message.text }]);
    expect(out.step).toEqual({ kind: "email", pageId: null, subject: message.subject, outcome: "sent", to: recipients });
  });

  it("sends one a run", async () => {
    const out = await sendAgentEmail({ sender, recipients, args: message, sentBefore: true });
    expect(out.isError).toBe(true);
    expect(sent.calls).toEqual([]);
  });

  it("refuses a message without a subject or with placeholders", async () => {
    expect((await sendAgentEmail({ sender, recipients, args: { text: message.text }, sentBefore: false })).isError).toBe(true);
    const unfinished = await sendAgentEmail({ sender, recipients, args: { subject: "Report", text: "Hello [NAME],\n\nHere it is." }, sentBefore: false });
    expect(unfinished.isError).toBe(true);
    expect(unfinished.step).toBeUndefined();
    expect(sent.calls).toEqual([]);
  });

  it("records a message the server refused", async () => {
    sent.fail = true;
    const out = await sendAgentEmail({ sender, recipients, args: message, sentBefore: false });
    expect(out.isError).toBe(true);
    expect(out.step?.outcome).toBe("failed");
  });

  it("offers no address to the model", () => {
    const tool = sendEmailTool(sender, recipients);
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(["subject", "text"]);
    expect(tool.description).toContain("planning@example.com, sales@example.com");
  });
});
