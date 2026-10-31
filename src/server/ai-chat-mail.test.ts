import { beforeEach, describe, expect, it, vi } from "vitest";

// The AI chat's tools on the person's own mail (server/ai-chat-mail.ts): who gets them, what a
// search and a read give the model, and what a draft is before and after the person decides.

const mocks = vi.hoisted(() => ({
  connectedAppCall: vi.fn((): object | null => null),
  mailTabShown: vi.fn(async () => true),
  listThreads: vi.fn(),
  listMailboxes: vi.fn(async (): Promise<object[]> => [{ id: "box-1", folders: [], status: "ok" }]),
  openMailbox: vi.fn(async () => ({})),
  ownMessage: vi.fn(),
  threadForAi: vi.fn(),
  saveDraft: vi.fn(async () => ({ id: "d-1", messageId: "<d@x>", attachments: [] })),
  boxes: [] as object[],
}));
vi.mock("@/db", () => {
  const rows = () => mocks.boxes;
  const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => rows(), then: (ok: (v: object[]) => unknown) => Promise.resolve([{ id: "folder-drafts" }]).then(ok) };
  return { db: { select: () => chain } };
});
vi.mock("@/server/connected-app", async (original) => ({ ...(await original<typeof import("@/server/connected-app")>()), connectedAppCall: mocks.connectedAppCall }));
vi.mock("@/server/mail-client/read", () => ({ listMailboxes: mocks.listMailboxes, listThreads: mocks.listThreads, mailTabShown: mocks.mailTabShown, openMailbox: mocks.openMailbox, ownMessage: mocks.ownMessage }));
vi.mock("@/server/mail-client/ai", () => ({ threadForAi: mocks.threadForAi }));
vi.mock("@/server/mail-client/drafts", () => ({ saveDraft: mocks.saveDraft }));
vi.mock("@/server/mail/locale", () => ({ recipientLocale: async () => "en" }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string, values: Record<string, string>) => `${key}: ${values.name} ${values.date}` }));

const { chatMailToolset, prepareMailDraft, runChatMailTool, saveMailDraft } = await import("./ai-chat-mail");
const { RowMailError } = await import("@/server/row-mail/settings");

const box = { id: "box-1", workspaceId: "ws-1", address: "me@example.test", signature: "<p>Ada</p>" };
const registry = () => ({ sources: [], byKey: new Map() });
const thread = (over: object = {}) => ({
  threadId: "t-1",
  mailboxId: "box-1",
  folderId: "f-1",
  messageId: "m-1",
  senders: [{ address: "ayse@acme.test", name: "Ayşe Kaya" }],
  subject: "Teklif",
  preview: "Cuma gününe kadar fiyat",
  sentAt: "2026-10-30T09:15:00.000Z",
  count: 2,
  unread: true,
  hasAttachments: false,
  hasDraft: false,
  row: { rowId: "row-1", databaseId: "db-1", title: "Acme", icon: null },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectedAppCall.mockReturnValue(null);
  mocks.mailTabShown.mockResolvedValue(true);
  mocks.boxes = [box];
});

describe("chatMailToolset", () => {
  it("offers the reading tools, and draft_mail where changes are on", async () => {
    expect((await chatMailToolset("u1", "ws-1", { writes: false })).map((t) => t.name)).toEqual(["search_mail", "read_mail"]);
    expect((await chatMailToolset("u1", "ws-1", { writes: true })).map((t) => t.name)).toEqual(["search_mail", "read_mail", "draft_mail"]);
  });

  it("offers nothing without the Mail tab, or to a connected app such as the Telegram bot", async () => {
    mocks.mailTabShown.mockResolvedValueOnce(false);
    expect(await chatMailToolset("u1", "ws-1", { writes: true })).toEqual([]);
    mocks.connectedAppCall.mockReturnValueOnce({ userId: "u1" });
    expect(await chatMailToolset("u1", "ws-1", { writes: true })).toEqual([]);
  });
});

describe("search_mail", () => {
  it("lists all the person's inboxes' threads as data from outside, each with the message_id to read", async () => {
    mocks.listThreads.mockResolvedValue({ items: [thread()], next: null });
    const out = await runChatMailTool("u1", "ws-1", { name: "search_mail", arguments: { query: "from:ayse teklif" } }, registry(), 10_000);
    expect(mocks.listThreads).toHaveBeenCalledWith("u1", { mailboxId: "all", folderId: "", workspaceId: "ws-1", search: "from:ayse teklif" });
    expect(out.content).toMatch(/<<<EXTERNAL DATA [0-9a-f]{12}\nmessage_id: m-1\nSubject: Teklif\nFrom: Ayşe Kaya <ayse@acme.test>\nDate: 2026-10-30 09:15 UTC · 2 messages · unread\nRow: Acme \(page_id row-1\)/);
    expect(out.step).toEqual({ kind: "mail", action: "search", query: "from:ayse teklif", results: 1 });
  });

  it("reads a mailbox the Mail tab never opened first, and says so when that takes too long", async () => {
    mocks.listThreads.mockResolvedValue({ items: [], next: null });
    mocks.listMailboxes.mockResolvedValueOnce([{ id: "box-1", folders: null, status: "ok" }, { id: "box-2", folders: null, status: "error" }]);
    expect((await runChatMailTool("u1", "ws-1", { name: "search_mail", arguments: { query: "x" } }, registry(), 10_000)).content).not.toMatch(/still being read/);
    expect(mocks.openMailbox).toHaveBeenCalledTimes(1);
    expect(mocks.openMailbox).toHaveBeenCalledWith("u1", "box-1");

    vi.useFakeTimers();
    mocks.listMailboxes.mockResolvedValueOnce([{ id: "box-1", folders: null, status: "ok" }]);
    mocks.openMailbox.mockReturnValueOnce(new Promise(() => {}));
    const slow = runChatMailTool("u1", "ws-1", { name: "search_mail", arguments: { query: "x" } }, registry(), 10_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await slow).content).toMatch(/still being read for the first time/);
    vi.useRealTimers();
  });

  it("refuses an argument it doesn't take, and says when nothing matched", async () => {
    expect((await runChatMailTool("u1", "ws-1", { name: "search_mail", arguments: { query: "x", folder: "inbox" } }, registry(), 10_000)).isError).toBe(true);
    mocks.listThreads.mockResolvedValue({ items: [], next: null });
    expect((await runChatMailTool("u1", "ws-1", { name: "search_mail", arguments: { query: "x" } }, registry(), 10_000)).content).toMatch(/^No email matched/);
  });
});

describe("read_mail", () => {
  it("reads the thread as a numbered source at its Mail tab address, with the other party's row", async () => {
    mocks.ownMessage.mockResolvedValue({ box, message: { id: "m-1", folderId: "f-1", threadId: "t-1" } });
    mocks.threadForAi.mockResolvedValue({
      subject: "Teklif",
      messages: [{ from: { address: "ayse@acme.test", name: "Ayşe Kaya" }, sentAt: new Date("2026-10-30T09:15:00Z"), text: "Fiyatı gönderir misin?", mine: false }],
      newestId: "m-1",
      row: { rowId: "row-1", title: "Acme" },
    });
    const reg = registry();
    const out = await runChatMailTool("u1", "ws-1", { name: "read_mail", arguments: { message_id: "m-1" } }, reg, 10_000);
    expect(mocks.threadForAi).toHaveBeenCalledWith("u1", { mailboxId: "box-1", folderId: "f-1", threadId: "t-1" });
    expect(reg.sources).toHaveLength(1);
    expect(reg.sources[0]).toMatchObject({ n: 1, title: "Teklif" });
    expect((reg.sources[0] as { url: string }).url).toMatch(/\/w\/ws-1\/mail\?box=box-1&f=f-1&t=t-1$/);
    expect(out.content).toContain("Fiyatı gönderir misin?");
    expect(out.content).toContain('database row "Acme" (page_id row-1)');
    expect(out.content).toMatch(/EXTERNAL DATA/);
    expect(out.step).toEqual({ kind: "mail", action: "read", subject: "Teklif", url: "/w/ws-1/mail?box=box-1&f=f-1&t=t-1" });
  });

  it("can't read mail of another workspace's mailbox, or one that isn't the person's", async () => {
    mocks.ownMessage.mockResolvedValueOnce({ box: { ...box, workspaceId: "ws-2" }, message: { id: "m-1", folderId: "f-1", threadId: "t-1" } });
    expect(await runChatMailTool("u1", "ws-1", { name: "read_mail", arguments: { message_id: "m-1" } }, registry(), 10_000)).toMatchObject({ isError: true });
    mocks.ownMessage.mockRejectedValueOnce(new RowMailError("gone"));
    expect(await runChatMailTool("u1", "ws-1", { name: "read_mail", arguments: { message_id: "m-2" } }, registry(), 10_000)).toMatchObject({ isError: true });
    expect(mocks.threadForAi).not.toHaveBeenCalled();
  });
});

describe("draft_mail", () => {
  it("shows every recipient, the subject and the text, asked each time, from the default mailbox with its signature", async () => {
    const prepared = await prepareMailDraft("u1", "ws-1", { to: ["Ayse@Acme.test"], cc: ["ayse@acme.test", "ali@acme.test"], subject: "Teklif", body: "Merhaba,\n\n- fiyat\n- **süre**" });
    if (!("action" in prepared)) throw new Error(prepared.content);
    expect(prepared.action).toMatchObject({ action: "draftMail", eachTime: true, title: "Teklif", content: "Merhaba,\n\n- fiyat\n- süre", mail: { from: "me@example.test", to: ["ayse@acme.test"], cc: ["ali@acme.test"] } });
    expect(prepared.input.html).toContain("<strong>süre</strong>");
    expect(prepared.input.html).toMatch(/<div data-signature="">.*Ada.*<\/div>$/);
    expect(prepared.input.replyTo).toBeNull();
  });

  it("answers a message from its own mailbox, under the earlier mail with the composer's line", async () => {
    mocks.ownMessage.mockResolvedValue({ box: { ...box, id: "box-2", address: "sales@example.test", signature: null }, message: { id: "m-1", fromName: "Ayşe Kaya", fromAddress: "ayse@acme.test", sentAt: new Date("2026-10-30T09:15:00Z") } });
    const prepared = await prepareMailDraft("u1", "ws-1", { to: ["ayse@acme.test"], subject: "Re: Teklif", body: "Gönderiyorum.", reply_to: "m-1" }, "Europe/Istanbul");
    if (!("action" in prepared)) throw new Error(prepared.content);
    expect(prepared.box).toEqual({ id: "box-2", address: "sales@example.test" });
    expect(prepared.input.replyTo).toBe("m-1");
    expect(prepared.input.quote?.header[0]).toMatch(/^replyHeader: Ayşe Kaya .*12:15/);
  });

  it("refuses what isn't an address, too many recipients, or an answer to mail it can't read", async () => {
    expect(await prepareMailDraft("u1", "ws-1", { to: ["not an address"], subject: "x", body: "y" })).toMatchObject({ isError: true });
    expect(await prepareMailDraft("u1", "ws-1", { to: Array.from({ length: 21 }, (_, i) => `p${i}@x.test`), subject: "x", body: "y" })).toMatchObject({ isError: true });
    mocks.ownMessage.mockResolvedValueOnce({ box: { ...box, workspaceId: "ws-2" }, message: { id: "m-1" } });
    expect(await prepareMailDraft("u1", "ws-1", { to: ["a@x.test"], subject: "x", body: "y", reply_to: "m-1" })).toMatchObject({ isError: true });
    expect(await prepareMailDraft("u1", "ws-1", { to: ["a@x.test"], subject: "x", body: "y", bcc: ["b@x.test"] })).toMatchObject({ isError: true });
  });

  it("saves only what the person approved, never sending, and links to the Drafts folder", async () => {
    const prepared = await prepareMailDraft("u1", "ws-1", { to: ["a@x.test"], subject: "Merhaba", body: "Selam" });
    if (!("action" in prepared)) throw new Error(prepared.content);
    const declined = await saveMailDraft("u1", prepared, "decline");
    expect(declined.step).toMatchObject({ kind: "mail", action: "draft", outcome: "declined", url: null });
    expect(mocks.saveDraft).not.toHaveBeenCalled();

    const saved = await saveMailDraft("u1", prepared, "approve");
    expect(mocks.saveDraft).toHaveBeenCalledWith("u1", expect.objectContaining({ mailboxId: "box-1", to: ["a@x.test"], cc: [], bcc: [], subject: "Merhaba", replyTo: null }));
    expect(saved.step).toEqual({ kind: "mail", action: "draft", subject: "Merhaba", to: ["a@x.test"], outcome: "done", url: "/w/ws-1/mail?box=box-1&f=folder-drafts" });
    expect(saved.content).toMatch(/not sent/);

    mocks.saveDraft.mockRejectedValueOnce(new RowMailError("unreachable"));
    expect((await saveMailDraft("u1", prepared, "approve")).step).toMatchObject({ outcome: "failed" });
  });
});
