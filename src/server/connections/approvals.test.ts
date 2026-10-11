import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Answering an agent's call: who may (owners, held to the workspace's sign-in policies like every
 * owner's action). The database answers from queues: one for selects, one for updates.
 */
const selects: unknown[][] = [];
const updates: unknown[][] = [];

function selectChain() {
  const node: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin"]) node[method] = () => node;
  node.where = () => Object.assign(Promise.resolve(selects.shift() ?? []), node);
  node.limit = async () => selects.shift() ?? [];
  return node;
}
const update = vi.fn(() => ({ set: () => ({ where: () => ({ returning: async () => updates.shift() ?? [] }) }) }));

vi.mock("@/db", () => ({
  db: {
    select: () => selectChain(),
    update: () => update(),
    delete: () => ({ where: () => ({ returning: async () => [] }) }),
  },
}));
vi.mock("@/server/agents/kick", () => ({ kickAgents: vi.fn() }));
vi.mock("@/server/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/server/notifications", () => ({ signalInbox: vi.fn() }));
vi.mock("@/server/push", () => ({ pushNotifications: vi.fn() }));
vi.mock("./tools", () => ({ inputSummary: (args: unknown) => JSON.stringify(args) }));

const requireMembership = vi.fn();
vi.mock("@/server/access", async () => {
  const actual = await vi.importActual<typeof import("@/server/access")>("@/server/access");
  return { ...actual, requireMembership: (...args: unknown[]) => requireMembership(...args), workspaceOwnerIds: async () => ["owner-1"] };
});

const { AccessError, TwoFactorRequiredError } = await import("@/server/access");
const { ApprovalError, decideApproval } = await import("./approvals");

const waiting = { id: "run-1", workspaceId: "ws-1", status: "awaiting_approval", agentId: "agent-1", pending: { callId: "call-1", connectionId: "conn-1", tool: "send", arguments: {}, askedAt: "" } };

beforeEach(() => {
  selects.length = 0;
  updates.length = 0;
  update.mockClear();
  requireMembership.mockReset();
});

describe("decideApproval", () => {
  it("asks for an owner through the policy-enforcing membership check", async () => {
    selects.push([waiting], [{ name: "CRM" }], [{ name: "Agent" }]);
    updates.push([{ id: "run-1", pending: waiting.pending }]);
    requireMembership.mockResolvedValue({ role: "owner" });
    await expect(decideApproval("owner-1", { runId: "run-1", callId: "call-1", decision: "approve" })).resolves.toEqual({ runId: "run-1" });
    expect(requireMembership).toHaveBeenCalledWith("owner-1", "ws-1", "owner");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses someone who isn't an owner, taking nothing", async () => {
    selects.push([waiting]);
    requireMembership.mockRejectedValue(new AccessError());
    const error = await decideApproval("member-1", { runId: "run-1", callId: "call-1", decision: "approve" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as InstanceType<typeof ApprovalError>).code).toBe("forbidden");
    expect(update).not.toHaveBeenCalled();
  });

  it("holds an owner to the workspace's two-step policy: the policy's error comes through, nothing is taken", async () => {
    selects.push([waiting]);
    requireMembership.mockRejectedValue(new TwoFactorRequiredError("ws-1"));
    await expect(decideApproval("owner-1", { runId: "run-1", callId: "call-1", decision: "approve" })).rejects.toBeInstanceOf(TwoFactorRequiredError);
    expect(update).not.toHaveBeenCalled();
  });
});
