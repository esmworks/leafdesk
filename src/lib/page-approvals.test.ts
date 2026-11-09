import { describe, expect, it } from "vitest";
import { badgeState, checkApprovalRequest, checkDecision, isDay, MAX_APPROVAL_NOTE, MAX_APPROVERS, roundOutcome, roundStuck } from "./page-approvals";

describe("roundOutcome", () => {
  it("waits until everyone approved", () => {
    expect(roundOutcome("all", [null, null])).toBe("open");
    expect(roundOutcome("all", ["approved", null])).toBe("open");
    expect(roundOutcome("all", ["approved", "approved"])).toBe("approved");
  });
  it("ends on the first approval when any one is enough", () => {
    expect(roundOutcome("any", [null, null])).toBe("open");
    expect(roundOutcome("any", [null, "approved"])).toBe("approved");
  });
  it("ends when anyone asks for changes, whatever the rule", () => {
    expect(roundOutcome("all", ["approved", "changes_requested"])).toBe("changes_requested");
    expect(roundOutcome("any", ["changes_requested", null])).toBe("changes_requested");
  });
});

describe("checkApprovalRequest", () => {
  const today = "2026-11-09";
  it("takes approvers, a rule, a due day and a note", () => {
    expect(checkApprovalRequest({ approverIds: ["a", "b", "a"], rule: "any", dueDate: "2026-11-20", note: "  Pricing changed  " }, "me", today)).toEqual({
      ok: true,
      value: { approverIds: ["a", "b"], rule: "any", dueDate: "2026-11-20", note: "Pricing changed" },
    });
  });
  it("defaults to everyone, no due day and no note", () => {
    expect(checkApprovalRequest({ approverIds: ["a"] }, "me", today)).toEqual({ ok: true, value: { approverIds: ["a"], rule: "all", dueDate: null, note: null } });
    expect(checkApprovalRequest({ approverIds: ["a"], dueDate: "", note: "   " }, "me", today)).toMatchObject({ ok: true, value: { dueDate: null, note: null } });
  });
  it("needs one to twenty approvers, never the requester", () => {
    expect(checkApprovalRequest({ approverIds: [] }, "me", today)).toEqual({ ok: false, code: "approvers" });
    expect(checkApprovalRequest({ approverIds: "a" }, "me", today)).toEqual({ ok: false, code: "approvers" });
    expect(checkApprovalRequest({ approverIds: ["a", 3] }, "me", today)).toEqual({ ok: false, code: "approvers" });
    expect(checkApprovalRequest({ approverIds: ["me"] }, "me", today)).toEqual({ ok: false, code: "approvers" });
    const many = Array.from({ length: MAX_APPROVERS + 1 }, (_, i) => `p${i}`);
    expect(checkApprovalRequest({ approverIds: many }, "me", today)).toEqual({ ok: false, code: "approvers" });
    expect(checkApprovalRequest({ approverIds: many.slice(1) }, "me", today).ok).toBe(true);
  });
  it("refuses an unknown rule, a bad or past due day and a long note", () => {
    expect(checkApprovalRequest({ approverIds: ["a"], rule: "most" }, "me", today)).toEqual({ ok: false, code: "rule" });
    expect(checkApprovalRequest({ approverIds: ["a"], dueDate: "2026-02-30" }, "me", today)).toEqual({ ok: false, code: "due" });
    expect(checkApprovalRequest({ approverIds: ["a"], dueDate: "2026-11-07" }, "me", today)).toEqual({ ok: false, code: "due" });
    expect(checkApprovalRequest({ approverIds: ["a"], dueDate: "2026-11-08" }, "me", today).ok).toBe(true);
    expect(checkApprovalRequest({ approverIds: ["a"], dueDate: "2040-01-01" }, "me", today)).toEqual({ ok: false, code: "due" });
    expect(checkApprovalRequest({ approverIds: ["a"], note: "x".repeat(MAX_APPROVAL_NOTE + 1) }, "me", today)).toEqual({ ok: false, code: "note" });
    expect(checkApprovalRequest({ approverIds: ["a"], note: 5 }, "me", today)).toEqual({ ok: false, code: "note" });
  });
});

describe("checkDecision", () => {
  it("needs a comment to ask for changes", () => {
    expect(checkDecision("changes_requested", " ")).toEqual({ ok: false, code: "commentNeeded" });
    expect(checkDecision("changes_requested", "Fix the prices")).toEqual({ ok: true, decision: "changes_requested", comment: "Fix the prices" });
  });
  it("approves with or without one", () => {
    expect(checkDecision("approved", undefined)).toEqual({ ok: true, decision: "approved", comment: null });
    expect(checkDecision("approved", "Looks right")).toEqual({ ok: true, decision: "approved", comment: "Looks right" });
  });
  it("refuses anything else", () => {
    expect(checkDecision("maybe", null)).toEqual({ ok: false, code: "decision" });
    expect(checkDecision("approved", "x".repeat(MAX_APPROVAL_NOTE + 1))).toEqual({ ok: false, code: "note" });
  });
});

describe("isDay", () => {
  it("knows real days", () => {
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("2027-02-29")).toBe(false);
    expect(isDay("2027-2-1")).toBe(false);
    expect(isDay(20270201)).toBe(false);
  });
});

describe("badgeState and roundStuck", () => {
  it("reads an approved page that changed since as changed", () => {
    expect(badgeState({ status: "approved", changed: false })).toBe("approved");
    expect(badgeState({ status: "approved", changed: true })).toBe("changed");
    expect(badgeState({ status: "open", changed: true })).toBe("open");
  });
  const person = (decision: "approved" | null, canOpen: boolean) => ({ userId: "u", name: null, decision, comment: null, decidedAt: null, canOpen });
  it("is stuck when someone everyone needs can no longer open the page", () => {
    expect(roundStuck({ status: "open", rule: "all", decisions: [person("approved", true), person(null, false)] })).toBe(true);
    expect(roundStuck({ status: "open", rule: "all", decisions: [person(null, true), person("approved", false)] })).toBe(false);
    expect(roundStuck({ status: "open", rule: "any", decisions: [person(null, true), person(null, false)] })).toBe(false);
    expect(roundStuck({ status: "open", rule: "any", decisions: [person(null, false)] })).toBe(true);
    expect(roundStuck({ status: "approved", rule: "all", decisions: [person(null, false)] })).toBe(false);
  });
});
