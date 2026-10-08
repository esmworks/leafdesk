import { describe, expect, it } from "vitest";
import { isDatabaseErrorCode } from "./properties";
import { assertPageUnlocked, isPageLocked } from "./page-lock";

describe("isPageLocked", () => {
  it("is about pages and rows: a database's lock is about its schema", () => {
    expect(isPageLocked({ kind: "page", lockedAt: new Date() })).toBe(true);
    expect(isPageLocked({ kind: "page", lockedAt: "2026-10-08T10:00:00.000Z" })).toBe(true);
    expect(isPageLocked({ kind: "database", lockedAt: new Date() })).toBe(false);
  });

  it("is off without a lock time", () => {
    expect(isPageLocked({ kind: "page", lockedAt: null })).toBe(false);
    expect(isPageLocked({ kind: "page" })).toBe(false);
  });
});

describe("assertPageUnlocked", () => {
  it("throws an error the actions translate", () => {
    let caught: unknown;
    try {
      assertPageUnlocked({ kind: "page", lockedAt: new Date() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // A plain Error with a known code: database actions and templates show database.errors.pageLocked.
    expect((caught as Error).constructor).toBe(Error);
    expect(isDatabaseErrorCode((caught as { code?: unknown }).code)).toBe(true);
  });

  it("lets unlocked pages and locked databases through", () => {
    expect(() => assertPageUnlocked({ kind: "page", lockedAt: null })).not.toThrow();
    expect(() => assertPageUnlocked({ kind: "database", lockedAt: new Date() })).not.toThrow();
  });
});
