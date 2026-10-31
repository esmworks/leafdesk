/**
 * A chat run's history (chat-store.ts chatRunHistory): a turn that read email holds the run that
 * takes it as one that read it, and a run sent from a connected app leaves such turns out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ results: [] as object[][] }));
vi.mock("@/db", () => {
  const chain = () => {
    const next = () => Promise.resolve(mocks.results.shift() ?? []);
    const c: Record<string, unknown> = {};
    for (const name of ["from", "where", "orderBy", "limit", "innerJoin"]) c[name] = () => c;
    c.then = (ok: (v: object[]) => unknown, bad?: (e: unknown) => unknown) => next().then(ok, bad);
    return c;
  };
  return { db: { select: chain } };
});

const { chatRunHistory, chatRunTyped } = await import("./chat-store");

const at = (minute: number) => `2026-10-31T10:${String(minute).padStart(2, "0")}:00.000Z`;
const conversation = (chatId: string | null) => ({
  chatId,
  agentId: "a1",
  messages: [
    { role: "user", content: "Ayşe'nin e-postasını özetle", runId: "r1", at: at(1) },
    { role: "assistant", content: "Ayşe teklif istiyor.", runId: "r1", steps: [{ kind: "mail", action: "read", subject: "Teklif", url: "/m" }], at: at(2) },
    { role: "user", content: "Toplantı notlarını bul", runId: "r2", at: at(3) },
    { role: "assistant", content: "Notlar burada.", runId: "r2", steps: [{ kind: "search", query: "toplantı", results: 1 }], at: at(4) },
    { role: "user", content: "Şimdi bir sayfa aç", runId: "r3", at: at(5) },
  ],
});
const run = (fromApp = false) => ({ id: "r3", steps: [], source: { kind: "chat" as const, userId: "u1", conversationId: "c1", ...(fromApp ? { fromApp: true } : {}) } });

beforeEach(() => {
  mocks.results = [];
});

describe("chatRunHistory", () => {
  it("holds a run whose history read email as one that read it", async () => {
    mocks.results = [[conversation("chat-1")]];
    const history = await chatRunHistory(run(), 10_000);
    expect(history.mailRead).toBe(true);
    expect(history.messages.map((m) => m.content).join("\n")).toContain("Ayşe teklif istiyor.");
  });

  it("leaves turns that read email out of a run sent from a connected app", async () => {
    mocks.results = [[conversation("chat-1")]];
    const history = await chatRunHistory(run(true), 10_000);
    expect(history.mailRead).toBe(false);
    const text = history.messages.map((m) => m.content).join("\n");
    expect(text).not.toContain("Ayşe");
    expect(text).toContain("Notlar burada.");
  });

  it("counts a schedule's run that read email among the agent's own chat", async () => {
    const plain = { ...conversation(null), messages: conversation(null).messages.slice(2) };
    const scheduled = { source: { kind: "schedule", scheduleId: "s1", scheduledBy: "u1" }, prompt: "Postayı özetle", answer: "Üç yeni e-posta var.", steps: [{ kind: "mail", action: "search", query: "x", results: 3 }], createdAt: new Date(at(0)) };
    mocks.results = [[plain], [scheduled]];
    expect((await chatRunHistory(run(), 10_000)).mailRead).toBe(true);
  });

  it("isn't held when nothing before it read email", async () => {
    const plain = { ...conversation("chat-1"), messages: conversation("chat-1").messages.slice(2) };
    mocks.results = [[plain]];
    expect((await chatRunHistory(run(), 10_000)).mailRead).toBe(false);
  });
});

describe("chatRunTyped", () => {
  it("gives what the person wrote before in the conversation, not the run's own message", async () => {
    mocks.results = [[conversation("chat-1")]];
    expect(await chatRunTyped(run())).toEqual(["Ayşe'nin e-postasını özetle", "Toplantı notlarını bul"]);
  });
});
