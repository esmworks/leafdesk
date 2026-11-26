import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendRaw: vi.fn(), keepAsDraft: vi.fn(), sentDraft: vi.fn() }));

vi.mock("@/db", () => ({
  db: {
    insert: () => ({ values: async () => {} }),
    delete: () => ({ where: async () => {} }),
    // No sent folder: the send keeps no copy and looks for none.
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));
vi.mock("@/server/row-mail/send", () => ({ sendRaw: mocks.sendRaw, keepSent: vi.fn(), SAVES_SENT: [] }));
vi.mock("@/server/row-mail/connect", () => ({ connectError: () => ({ code: "unreachable" }) }));
vi.mock("./drafts", () => ({ draftForSend: vi.fn(), keepAsDraft: mocks.keepAsDraft, sentDraft: mocks.sentDraft }));
vi.mock("./access", () => ({ requireOwnMailbox: vi.fn() }));
vi.mock("./compose", () => ({ buildMessage: vi.fn(), newMessageId: vi.fn(), written: vi.fn() }));
vi.mock("./folders", () => ({ makeFolder: vi.fn(), recount: vi.fn() }));
vi.mock("./indexer", () => ({ indexFolder: vi.fn() }));
vi.mock("./pool", () => ({ withImap: vi.fn() }));
vi.mock("./quote", () => ({ withQuote: vi.fn() }));

const { sendHeldNow, sendStatus } = await import("./write");

/** The map Next's copy of write.ts keeps the messages in; the server's copy calls sendHeldNow. */
const held = (globalThis as typeof globalThis & { __leafdeskMailHeld: Map<string, Record<string, unknown>> }).__leafdeskMailHeld;

function hold(id: string, timer: unknown = null) {
  held.set(id, {
    userId: "ada",
    box: { id: "box", imapHost: "imap.example.com" },
    draft: {},
    w: { to: ["ayse@example.com"], cc: [], bcc: [] },
    attachments: [],
    quote: null,
    raw: Buffer.from(""),
    messageId: `<${id}@example.com>`,
    timer,
    state: "held",
    error: null,
    sent: null,
    stopping: false,
  });
}

afterEach(() => {
  held.clear();
  vi.clearAllMocks();
});

describe("sendHeldNow", () => {
  it("sends at once a message another copy of the module holds for Undo, and its timer goes", async () => {
    mocks.sendRaw.mockResolvedValue(undefined);
    const due = vi.fn();
    hold("a", setTimeout(due, 30));
    expect(await sendHeldNow()).toBe(true);
    expect(mocks.sendRaw).toHaveBeenCalledTimes(1);
    expect(sendStatus("ada", "a").state).toBe("sent");
    await new Promise((done) => setTimeout(done, 50));
    expect(due).not.toHaveBeenCalled();
  });

  it("is done at once when nothing waits", async () => {
    expect(await sendHeldNow({ timeoutMs: 0 })).toBe(true);
  });

  it("waits for a message held while another is on its way", async () => {
    let release = () => {};
    mocks.sendRaw.mockImplementationOnce(() => new Promise<void>((done) => (release = done))).mockResolvedValue(undefined);
    hold("first");
    const stopped = sendHeldNow({ pollMs: 1 });
    await new Promise((done) => setTimeout(done, 5));
    // A Send request still running as the server stopped taking new ones.
    hold("late");
    release();
    expect(await stopped).toBe(true);
    expect(sendStatus("ada", "first").state).toBe("sent");
    expect(sendStatus("ada", "late").state).toBe("sent");
  });

  it("gives up after its time, leaving a send that hangs", async () => {
    mocks.sendRaw.mockImplementation(() => new Promise<void>(() => {}));
    hold("slow");
    expect(await sendHeldNow({ timeoutMs: 20, pollMs: 1 })).toBe(false);
    expect(sendStatus("ada", "slow").state).toBe("sending");
  });

  it("keeps a message it couldn't send as a draft", async () => {
    mocks.sendRaw.mockRejectedValue(new Error("refused"));
    mocks.keepAsDraft.mockResolvedValue({ id: "d" });
    hold("refused");
    expect(await sendHeldNow()).toBe(true);
    expect(sendStatus("ada", "refused").state).toBe("failed");
    expect(mocks.keepAsDraft).toHaveBeenCalledTimes(1);
  });
});
