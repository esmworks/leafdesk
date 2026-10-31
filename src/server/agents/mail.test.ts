/**
 * Mailboxes opened to agents (mail.ts): only the mailbox's owner opens or closes one, only in the
 * agent's workspace, and a run gets the mailboxes of the person it works for while the Mail tab is theirs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as object[],
  inserted: [] as object[],
  deleted: 0,
  mailTabShown: vi.fn(async () => true),
  requireOwnMailbox: vi.fn(async (): Promise<object> => ({ id: "box-1", workspaceId: "ws-1" })),
  agentWithLevel: vi.fn(async (): Promise<object> => ({ agent: { id: "a1", workspaceId: "ws-1", archivedAt: null }, level: "interact", owner: false })),
}));
vi.mock("@/db", () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    then: (ok: (v: object[]) => unknown) => Promise.resolve(mocks.rows).then(ok),
  };
  return {
    db: {
      select: () => chain,
      insert: () => ({ values: (v: object) => ({ onConflictDoNothing: async () => void mocks.inserted.push(v) }) }),
      delete: () => ({ where: async () => void (mocks.deleted += 1) }),
    },
  };
});
vi.mock("@/server/mail-client/read", () => ({ mailTabShown: mocks.mailTabShown }));
vi.mock("@/server/mail-client/access", () => ({ requireOwnMailbox: mocks.requireOwnMailbox }));
vi.mock("./sharing", () => ({ agentWithLevel: mocks.agentWithLevel }));

const { runMailboxes, setAgentMailbox } = await import("./mail");
const { RowMailError } = await import("@/server/row-mail/settings");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.inserted = [];
  mocks.deleted = 0;
  mocks.mailTabShown.mockResolvedValue(true);
});

describe("setAgentMailbox", () => {
  it("opens and closes the person's own mailbox to an agent they may use", async () => {
    await setAgentMailbox("u1", "a1", "box-1", true);
    expect(mocks.agentWithLevel).toHaveBeenCalledWith("u1", "a1", "interact");
    expect(mocks.requireOwnMailbox).toHaveBeenCalledWith("u1", "box-1");
    expect(mocks.inserted).toEqual([{ agentId: "a1", mailboxId: "box-1" }]);
    await setAgentMailbox("u1", "a1", "box-1", false);
    expect(mocks.deleted).toBe(1);
  });

  it("refuses someone else's mailbox, or one of another workspace", async () => {
    mocks.requireOwnMailbox.mockRejectedValueOnce(new RowMailError("noMailbox"));
    await expect(setAgentMailbox("u2", "a1", "box-1", true)).rejects.toBeInstanceOf(RowMailError);
    mocks.requireOwnMailbox.mockResolvedValueOnce({ id: "box-9", workspaceId: "ws-2" });
    await expect(setAgentMailbox("u1", "a1", "box-9", true)).rejects.toBeInstanceOf(RowMailError);
    expect(mocks.inserted).toEqual([]);
  });

  it("opens none to an archived agent, but still closes one", async () => {
    const archived = { agent: { id: "a1", workspaceId: "ws-1", archivedAt: new Date() }, level: "interact", owner: false };
    mocks.agentWithLevel.mockResolvedValueOnce(archived);
    await expect(setAgentMailbox("u1", "a1", "box-1", true)).rejects.toMatchObject({ code: "archived" });
    expect(mocks.inserted).toEqual([]);
    mocks.agentWithLevel.mockResolvedValueOnce(archived);
    await setAgentMailbox("u1", "a1", "box-1", false);
    expect(mocks.deleted).toBe(1);
  });
});

describe("runMailboxes", () => {
  const agent = { id: "a1", workspaceId: "ws-1" };

  it("gives the mailboxes of the person the run works for that are opened to the agent", async () => {
    mocks.rows = [{ id: "box-1" }, { id: "box-2" }];
    expect(await runMailboxes(agent, "u1")).toEqual(["box-1", "box-2"]);
  });

  it("gives none to a run that works for no one, or once the Mail tab isn't theirs", async () => {
    mocks.rows = [{ id: "box-1" }];
    expect(await runMailboxes(agent, null)).toEqual([]);
    mocks.mailTabShown.mockResolvedValueOnce(false);
    expect(await runMailboxes(agent, "u1")).toEqual([]);
  });
});
