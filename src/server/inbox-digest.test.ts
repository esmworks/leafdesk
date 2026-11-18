/**
 * The inbox's Catch up (inbox-digest.ts): reads the person's unread notifications only (as
 * listNotifications gives them), frames them as data, needs AI on, and links only the
 * notifications it sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/server/ai";
import { installFauxAi, resetAi } from "@/server/ai/testing";
import { inboxDigest } from "./inbox-digest";

const state = vi.hoisted(() => ({ ai: true, items: [] as unknown[], unread: 0, asked: [] as unknown[] }));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/ai-writing", () => ({ aiAvailable: async () => state.ai }));
vi.mock("@/server/mail/locale", () => ({ recipientLocale: async () => "en" }));
vi.mock("@/server/mail/templates", () => ({
  emailTranslator: () => (key: string, values?: Record<string, string | number>) => `${key}${values?.actor ? `:${values.actor}` : ""}`,
}));
vi.mock("@/server/notifications", () => ({
  listNotifications: async (userId: string, options: unknown) => {
    state.asked.push({ userId, options });
    return state.items;
  },
  unreadCount: async () => state.unread,
}));

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "comment",
  workspaceId: "ws",
  createdAt: new Date("2026-11-19T09:00:00Z"),
  actorName: "Ayşe",
  pageId: `p-${id}`,
  pageTitle: `Offer ${id}`,
  threadId: null,
  reminderDate: null,
  reminderTimeZone: null,
  suggestion: null,
  databaseTitle: null,
  propertyName: null,
  automationName: null,
  automationMessage: null,
  accessRequest: null,
  rowUpdate: null,
  followUp: null,
  reaction: null,
  ...over,
});

describe("inboxDigest", () => {
  beforeEach(() => {
    state.ai = true;
    state.items = [item("n1"), item("n2", { kind: "automation", automationName: "Stock", automationMessage: "Stock is low" })];
    state.unread = 2;
    state.asked = [];
  });
  afterEach(() => resetAi());

  it("asks for the person's unread notifications of the workspace and sorts them", async () => {
    let prompt = "";
    installFauxAi((request) => {
      prompt = request.prompt;
      return JSON.stringify({ needsYou: [{ ref: 1, text: "Ayşe wants a reply" }], clearable: [{ ref: 2, text: "Stock alert" }, { ref: 99, text: "Made up" }] });
    });
    const digest = await inboxDigest("me", "ws", "tr");
    expect(state.asked).toEqual([{ userId: "me", options: { workspaceId: "ws", unreadOnly: true, limit: 100 } }]);
    expect(prompt).toContain("Turkish");
    expect(prompt).toMatch(/<<<EXTERNAL DATA [0-9a-f]{12}\n\[1\] /);
    expect(prompt).toContain("Offer n1");
    expect(prompt).toContain('"Stock is low"');
    expect(digest.groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ["needsYou", ["n1"]],
      ["clearable", ["n2"]],
    ]);
    expect(digest.groups[0].items[0].href).toBe("/w/ws/p/p-n1");
    expect(digest.left).toBe(0);
  });

  it("counts the unread ones beyond what it read", async () => {
    installFauxAi(() => "{}");
    state.unread = 130;
    const digest = await inboxDigest("me", "ws");
    expect(digest.read).toBe(2);
    expect(digest.left).toBe(128);
  });

  it("is empty, and asks no model, when nothing is unread", async () => {
    state.items = [];
    state.unread = 0;
    installFauxAi(() => {
      throw new Error("no model call expected");
    });
    expect(await inboxDigest("me", "ws")).toEqual({ groups: [], read: 0, left: 0 });
  });

  it("is refused where AI is off", async () => {
    state.ai = false;
    installFauxAi(() => "{}");
    await expect(inboxDigest("me", "ws")).rejects.toMatchObject({ code: "disabled" } satisfies Partial<AiError>);
  });
});
