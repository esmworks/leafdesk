import { beforeEach, describe, expect, it, vi } from "vitest";

// Link codes for Telegram (server/telegram/links.ts): the linked chat reaches every workspace of
// the person outside the sign-in policies, so a session one of them holds back can't make one.

const inserted = vi.hoisted(() => [] as unknown[]);
vi.mock("@/db", () => {
  const insert = () => {
    const chain = {
      values: (values: unknown) => (inserted.push(values), chain),
      onConflictDoUpdate: () => Promise.resolve([]),
    };
    return chain;
  };
  return { db: { insert } };
});
vi.mock("@/lib/env", () => ({ env: { telegramBotToken: "123:token" } }));
vi.mock("./api", () => ({ callApi: vi.fn(async () => ({ id: 1, username: "leafdesk_bot" })), sendMessage: vi.fn() }));
const access = vi.hoisted(() => ({
  memberWorkspaceIds: vi.fn(async () => ["ws-1", "ws-2"]),
  signInPolicyRefusal: vi.fn(async (): Promise<Error | null> => null),
}));
vi.mock("@/server/access", () => access);

const { createLinkCode } = await import("./links");

beforeEach(() => {
  inserted.length = 0;
  vi.clearAllMocks();
});

describe("createLinkCode", () => {
  it("makes a code for a session no workspace holds back", async () => {
    const { url } = await createLinkCode("u1");
    expect(url).toMatch(/^https:\/\/t\.me\/leafdesk_bot\?start=[\w-]+$/);
    expect(access.signInPolicyRefusal).toHaveBeenCalledWith("u1", ["ws-1", "ws-2"]);
    expect(inserted).toHaveLength(1);
  });

  it("refuses a session a policy of any of the person's workspaces holds back, and stores nothing", async () => {
    const held = new Error("This workspace only allows sign-in from approved networks");
    access.signInPolicyRefusal.mockResolvedValueOnce(held);
    await expect(createLinkCode("u1")).rejects.toBe(held);
    expect(inserted).toHaveLength(0);
  });
});
