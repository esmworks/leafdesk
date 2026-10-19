/**
 * Which provider failures mark an own AI account's key as refused (refusesKey): a refused key is
 * shown to its owner as broken, so a passing outage or a model the key may not use must not count.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/access", () => ({ findMembership: vi.fn() }));

const { refusesKey } = await import("./account-target");

describe("a refused key", () => {
  it.each([
    "401 Unauthorized",
    "401 invalid x-api-key",
    "authentication_error: invalid x-api-key",
    "Incorrect API key provided: sk-abc",
    "API key not valid. Please pass a valid API key.",
    "invalid_api_key",
  ])("is told from %j", (message) => {
    expect(refusesKey(message)).toBe(true);
  });

  it.each([
    "403 You do not have access to model gpt-x",
    "403 Forbidden: this model is not available in your region",
    "503 authentication service unavailable",
    "429 Too many requests",
    "500 Internal server error",
  ])("is not read into %j", (message) => {
    expect(refusesKey(message)).toBe(false);
  });
});
