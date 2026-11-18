import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

import { AccessError } from "@/server/access";
import { AgentError } from "@/server/agents/errors";
import { ExternalAgentError } from "@/server/agents/external-error";
import { CORE_TOOLS, toolCategory } from "./catalog";
import { callerOf, externalAgentInputs, withExternalErrors } from "./external-agents";
import { ToolInputError } from "./format";

describe("the work tools of outside agents", () => {
  it("stay outside the core list, in the agents category", () => {
    for (const name of ["list_assigned_work", "update_assigned_work"]) {
      expect(CORE_TOOLS.has(name)).toBe(false);
      expect(toolCategory(name)).toBe("agents");
    }
  });

  it("take an agent id only to pick among the agents the caller is bound to", () => {
    expect(externalAgentInputs.list.safeParse({}).success).toBe(true);
    expect(externalAgentInputs.list.safeParse({ agent_id: "a1" }).success).toBe(true);
    expect(externalAgentInputs.update.safeParse({ row_id: "r1", status: "Done", comment: "Fixed" }).success).toBe(true);
    expect(externalAgentInputs.update.safeParse({ row_id: "r1", comment: "" }).success).toBe(false);
  });

  it("identify the caller by its verified person and app, nothing the input says", () => {
    expect(callerOf({ userId: "u1", clientId: "c1" })).toEqual({ kind: "app", userId: "u1", clientId: "c1" });
  });

  it("turn the failures of an agent's work into errors that say what to do", async () => {
    await expect(withExternalErrors(() => Promise.reject(new ExternalAgentError("notBound", "This connection is not bound to an agent")))).rejects.toBeInstanceOf(ToolInputError);
    await expect(withExternalErrors(() => Promise.reject(new AccessError("no")))).rejects.toThrow(/shared with it/);
    await expect(withExternalErrors(() => Promise.reject(new AgentError("paused", "Agent is paused")))).rejects.toBeInstanceOf(ToolInputError);
    await expect(withExternalErrors(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});
