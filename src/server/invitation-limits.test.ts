import { beforeEach, describe, expect, it } from "vitest";
import { sharedLimiter } from "@/lib/rate-limit";
import { INVITATION_EMAIL_LIMITS, takeInvitationEmail } from "./invitation-limits";

const HOUR = 60 * 60_000;

beforeEach(() => {
  for (const [kind, [count, windowMs]] of Object.entries(INVITATION_EMAIL_LIMITS)) {
    sharedLimiter(`invitation-email:${kind}`, count, windowMs).reset();
  }
});

describe("takeInvitationEmail", () => {
  it("sends a few invitations to one address an hour, from any workspace", () => {
    const now = 1_000_000;
    expect(takeInvitationEmail("a1", "w1", "someone@example.com", now)).toBe(true);
    expect(takeInvitationEmail("a1", "w1", "someone@example.com", now)).toBe(true);
    expect(takeInvitationEmail("a2", "w2", "Someone@Example.com", now)).toBe(true);
    expect(takeInvitationEmail("a3", "w3", "someone@example.com", now)).toBe(false);
    // Other addresses still get theirs, and the address again an hour later.
    expect(takeInvitationEmail("a1", "w1", "other@example.com", now)).toBe(true);
    expect(takeInvitationEmail("a3", "w3", "someone@example.com", now + HOUR + 1)).toBe(true);
  });

  it("limits how many one person sends, across their workspaces", () => {
    const now = 1_000_000;
    for (let i = 0; i < 100; i++) expect(takeInvitationEmail("a1", `w${i % 3}`, `p${i}@example.com`, now)).toBe(true);
    expect(takeInvitationEmail("a1", "w9", "one-more@example.com", now)).toBe(false);
    expect(takeInvitationEmail("a2", "w9", "one-more@example.com", now)).toBe(true);
  });

  it("limits how many one workspace sends, whoever invites", () => {
    const now = 1_000_000;
    for (let i = 0; i < 200; i++) expect(takeInvitationEmail(`a${i % 4}`, "w1", `p${i}@example.com`, now)).toBe(true);
    expect(takeInvitationEmail("a9", "w1", "one-more@example.com", now)).toBe(false);
  });

  it("uses up no limit when one of them refuses", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) takeInvitationEmail(`a${i}`, `w${i}`, "busy@example.com", now);
    for (let i = 0; i < 10; i++) expect(takeInvitationEmail("a1", "w1", "busy@example.com", now)).toBe(false);
    // a1 took one hit above; the refused ones took none.
    const [count, windowMs] = INVITATION_EMAIL_LIMITS.actor;
    expect(sharedLimiter("invitation-email:actor", count, windowMs).count("a1", now)).toBe(1);
  });
});
