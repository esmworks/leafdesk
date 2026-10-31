import { beforeEach, describe, expect, it, vi } from "vitest";

// The Mail tab's AI (server/mail-client/ai.ts): who may ask, what is refused before a model is
// asked, which messages a summary reads, and where the summary is kept.

const updates = vi.hoisted(() => [] as { set: unknown }[]);
vi.mock("@/db", () => ({
  db: {
    update: () => {
      const entry = { set: null as unknown };
      updates.push(entry);
      const chain = {
        set: (value: unknown) => ((entry.set = value), chain),
        where: () => chain,
        returning: async () => [{ mailboxId: "box-1", threadId: "t-1" }],
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
      };
      return chain;
    },
  },
}));
const box = { id: "box-1", workspaceId: "ws-1", address: "me@example.test" };
const mocks = vi.hoisted(() => ({
  requireOwnMailbox: vi.fn(),
  aiAvailable: vi.fn(async () => true),
  getThread: vi.fn(),
  messageForAi: vi.fn(),
  stream: vi.fn(async () => ({ result: async () => ({ stopReason: "stop" }) })),
}));
vi.mock("./access", () => ({ requireOwnMailbox: mocks.requireOwnMailbox }));
vi.mock("@/server/ai-writing", () => ({ aiAvailable: mocks.aiAvailable }));
vi.mock("./read", () => ({ getThread: mocks.getThread, messageForAi: mocks.messageForAi }));
vi.mock("@/server/ai", async (original) => ({ ...(await original<typeof import("@/server/ai")>()), stream: mocks.stream }));

const { startMailAi } = await import("./ai");

const message = (id: string, from = "ada@example.test") => ({ id, from: { address: from, name: null }, sentAt: "2026-10-01T09:00:00.000Z", preview: `preview ${id}` });
const read = (id: string, from = "ada@example.test") => ({ box, message: { id, fromAddress: from, fromName: null, sentAt: new Date("2026-10-01T09:00:00Z") }, text: `text of ${id}` });

beforeEach(() => {
  updates.length = 0;
  vi.clearAllMocks();
  mocks.requireOwnMailbox.mockResolvedValue(box);
  mocks.aiAvailable.mockResolvedValue(true);
});

describe("startMailAi", () => {
  it("is refused when the workspace has AI off, before any mail is read", async () => {
    mocks.aiAvailable.mockResolvedValue(false);
    await expect(startMailAi("u1", { kind: "write", mailboxId: "box-1", action: "custom", draft: "", instruction: "x" })).rejects.toMatchObject({ code: "disabled" });
    expect(mocks.messageForAi).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("asks the mailbox's owner check first", async () => {
    mocks.requireOwnMailbox.mockRejectedValue(new Error("noMailbox"));
    await expect(startMailAi("u2", { kind: "summary", mailboxId: "box-1", folderId: "f", threadId: "t-1" })).rejects.toThrow("noMailbox");
    expect(mocks.requireOwnMailbox).toHaveBeenCalledWith("u2", "box-1");
  });

  it("refuses requests that can't be done", async () => {
    const write = (input: object) => startMailAi("u1", { kind: "write", mailboxId: "box-1", draft: "", ...input } as never);
    await expect(write({ action: "improve" })).rejects.toMatchObject({ code: "invalid" });
    await expect(write({ action: "translate", draft: "x", language: "xx" })).rejects.toMatchObject({ code: "invalid" });
    await expect(write({ action: "custom" })).rejects.toMatchObject({ code: "invalid" });
    await expect(write({ action: "reply" })).rejects.toMatchObject({ code: "invalid" });
    await expect(write({ action: "fix", draft: "a".repeat(100_000) })).rejects.toMatchObject({ code: "tooLarge" });
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("writes a reply from the answered message, as the person, in the mailbox's workspace", async () => {
    mocks.messageForAi.mockResolvedValue(read("m-9"));
    await startMailAi("u1", { kind: "write", mailboxId: "box-1", action: "reply", draft: "", answering: "m-9" });
    expect(mocks.messageForAi).toHaveBeenCalledWith("u1", "m-9");
    expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ feature: "mail.write", userId: "u1", workspaceId: "ws-1" }));
    expect(JSON.stringify(mocks.stream.mock.calls[0])).toContain("text of m-9");
  });

  it("summarizes the newest messages and keeps the summary on the newest", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m-${i}`);
    mocks.getThread.mockResolvedValue({ threadId: "t-1", subject: "Teklif", messages: ids.map((id) => message(id)), row: null, summary: null });
    mocks.messageForAi.mockImplementation(async (_user: string, id: string) => (id === "m-5" ? Promise.reject(new Error("gone")) : read(id)));
    const { finished } = await startMailAi("u1", { kind: "summary", mailboxId: "box-1", folderId: "f-1", threadId: "t-1", language: "tr" });
    expect(mocks.messageForAi.mock.calls.map((call) => call[1])).toEqual(ids.slice(2));
    const prompt = JSON.stringify(mocks.stream.mock.calls[0]);
    expect(prompt).toContain("mail.summary");
    expect(prompt).toContain("Write in Turkish.");
    // A message that can't be read is summed up from its first line.
    expect(prompt).toContain("preview m-5");
    expect(prompt).not.toContain("text of m-1");
    await finished!("  Ada fiyat soruyor.  ");
    expect(updates.map((u) => u.set)).toEqual([{ summary: "Ada fiyat soruyor." }, { summary: null }]);
  });
});
