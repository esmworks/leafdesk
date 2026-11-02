/**
 * What connected apps get of an agent's run (agents.ts describeAgentRun): nothing of what a run
 * that read the user's email did and answered (lib/agents.ts readEmail).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

const { describeAgentRun, describeAgentStep } = await import("./agents");

const run = (steps: object[]) =>
  ({ id: "r1", status: "done", code: null, error: null, source: { kind: "chat", userId: "u1", conversationId: "c1" }, pending: null, steps, answer: "Ayşe teklif istiyor.", usage: null, createdAt: "2026-10-31T10:00:00.000Z", finishedAt: "2026-10-31T10:01:00.000Z" }) as unknown as Parameters<typeof describeAgentRun>[1];

describe("describeAgentRun", () => {
  it("leaves out the steps and answer of a run that read email", () => {
    const out = describeAgentRun("ws-1", run([{ kind: "mail", action: "read", subject: "Teklif", url: "/m" }]));
    expect(out).toMatchObject({ steps: [], answer: "", email: expect.stringMatching(/only in Leafdesk's app/) });
    expect(JSON.stringify(out)).not.toContain("Teklif");
  });

  it("does the same for a chat run that went on from one", () => {
    expect(describeAgentRun("ws-1", run([{ kind: "mail", action: "earlier" }]))).toMatchObject({ steps: [], answer: "" });
  });

  it("keeps a run that only drafted, describing its mail step without what it said", () => {
    const out = describeAgentRun("ws-1", run([{ kind: "mail", action: "draft", subject: "Gizli konu", to: ["a@b.test"], url: null, outcome: "done" }]));
    expect(out.answer).toBe("Ayşe teklif istiyor.");
    expect(out.steps).toEqual([{ kind: "mail", action: "draft", summary: "Saved an email draft" }]);
    expect(describeAgentStep({ kind: "mail", action: "search", query: "x", results: 2 })).toMatchObject({ summary: "Searched the user's email" });
  });
});

describe("describeAgentStep for email", () => {
  it("tells a report sent to the agent's recipients from a row's draft waiting for review", () => {
    const sent = describeAgentStep({ kind: "email", pageId: null, subject: "Geciken siparişler", outcome: "sent", to: ["a@b.test", "c@d.test"] });
    expect(sent).toMatchObject({ outcome: "sent", summary: 'Sent an email to a@b.test, c@d.test: "Geciken siparişler"' });
    expect(describeAgentStep({ kind: "email", pageId: null, subject: "Rapor", outcome: "failed", to: ["a@b.test"] })).toMatchObject({ summary: 'Failed to send an email to a@b.test: "Rapor"' });
    expect(describeAgentStep({ kind: "email", pageId: "row-1", subject: "Teklif", outcome: "proposed" })).toMatchObject({ summary: 'Drafted an email for its sender to review (not sent yet): "Teklif"' });
    expect(describeAgentStep({ kind: "email", pageId: "row-1", subject: "Teklif", outcome: "failed" })).toMatchObject({ summary: 'Failed to draft an email: "Teklif"' });
  });
});
