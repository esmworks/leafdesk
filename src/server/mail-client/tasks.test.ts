import { beforeEach, describe, expect, it, vi } from "vitest";

// Tasks found in a thread, added as the person's to-dos (server/mail-client/tasks.ts): where they
// go, what each block holds, and what is refused.

vi.mock("@/db", () => ({ db: { select: () => ({ from: () => ({ where: async () => [{ name: "Ada Demir" }] }) }) } }));
const mocks = vi.hoisted(() => ({
  requireOwnMailbox: vi.fn(async () => ({ id: "box-1", workspaceId: "ws-1" })),
  getThread: vi.fn(),
  requirePageAccess: vi.fn(),
  getOrCreateDailyNote: vi.fn(async () => ({ pageId: "note-1" })),
  appendBlocks: vi.fn(async () => {}),
}));
vi.mock("./access", () => ({ requireOwnMailbox: mocks.requireOwnMailbox }));
vi.mock("./read", () => ({ getThread: mocks.getThread }));
vi.mock("@/server/access", async (original) => ({ ...(await original<typeof import("@/server/access")>()), requirePageAccess: mocks.requirePageAccess }));
vi.mock("@/server/journal", () => ({ getOrCreateDailyNote: mocks.getOrCreateDailyNote }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: () => ({ appendBlocks: mocks.appendBlocks }) }));

const { addMailTasks } = await import("./tasks");
const { AccessError } = await import("@/server/access");

const input = { mailboxId: "box-1", folderId: "f-1", threadId: "t-1", today: "2026-10-31", tasks: [{ text: "Teklifi gönder", date: "2026-11-06" }, { text: "Listeyi ekle", date: null }] };
const row = { rowId: "row-1", databaseId: "db-1", title: "Acme", icon: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getThread.mockResolvedValue({ row });
  mocks.requirePageAccess.mockResolvedValue({ id: "row-1", kind: "page", archivedAt: null, lockedAt: null });
});

describe("addMailTasks", () => {
  it("adds to-dos on the row's page that mention the person, link back to the mail and carry the day", async () => {
    expect(await addMailTasks("u1", input)).toEqual({ pageId: "row-1", row: true, workspaceId: "ws-1", count: 2 });
    expect(mocks.requirePageAccess).toHaveBeenCalledWith("u1", "row-1", "content");
    const [pageId, blocks, actor] = mocks.appendBlocks.mock.calls[0] as unknown as [string, { type: string; content: { type: string; props?: Record<string, string>; href?: string }[] }[], object];
    expect(pageId).toBe("row-1");
    expect(actor).toEqual({ userId: "u1", model: true });
    expect(blocks[0].type).toBe("checkListItem");
    expect(blocks[0].content[0].props).toMatchObject({ kind: "user", userId: "u1", name: "Ada Demir" });
    expect(blocks[0].content[2].href).toMatch(/\/w\/ws-1\/mail\?box=box-1&f=f-1&t=t-1$/);
    expect(blocks[0].content.at(-1)?.props).toMatchObject({ kind: "date", date: "2026-11-06" });
    expect(blocks[1].content).toHaveLength(3);
  });

  it("uses the daily note, in the person's language, when the row can't take them", async () => {
    mocks.requirePageAccess.mockRejectedValueOnce(new AccessError());
    expect(await addMailTasks("u1", input, { locale: "tr" })).toMatchObject({ pageId: "note-1", row: false });
    expect(mocks.getOrCreateDailyNote).toHaveBeenCalledWith({ userId: "u1", model: true }, "ws-1", "2026-10-31", { locale: "tr" });

    mocks.requirePageAccess.mockResolvedValueOnce({ id: "row-1", kind: "page", archivedAt: null, lockedAt: new Date() });
    expect(await addMailTasks("u1", input)).toMatchObject({ row: false });
    mocks.getThread.mockResolvedValueOnce({ row: null });
    expect(await addMailTasks("u1", input)).toMatchObject({ row: false });
  });

  it("refuses no tasks, too many, or a day that isn't one, before anything is read", async () => {
    await expect(addMailTasks("u1", { ...input, tasks: [{ text: " ", date: null }] })).rejects.toMatchObject({ code: "invalid" });
    await expect(addMailTasks("u1", { ...input, tasks: Array.from({ length: 11 }, () => ({ text: "x", date: null })) })).rejects.toMatchObject({ code: "invalid" });
    await expect(addMailTasks("u1", { ...input, today: "dün" })).rejects.toMatchObject({ code: "invalid" });
    expect(mocks.getThread).not.toHaveBeenCalled();
    expect(mocks.appendBlocks).not.toHaveBeenCalled();
  });
});
