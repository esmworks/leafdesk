import { describe, expect, it } from "vitest";
import { COMPUTER_EARLIER, COMPUTER_TOOL_NAMES, type AgentStepRecord } from "./agents";
import { firstLocalRead, readLocalFiles } from "./local-reads";

const tool = (name: string, outcome: "done" | "failed" | "declined", connectionId: string | null = null): AgentStepRecord => ({ kind: "tool", connectionId, tool: name, input: "", outcome });

describe("local reads", () => {
  it("counts a folder listed or a file read on the computer, done", () => {
    expect(readLocalFiles([tool(COMPUTER_TOOL_NAMES.list, "done")])).toBe(true);
    expect(readLocalFiles([tool(COMPUTER_TOOL_NAMES.read, "done")])).toBe(true);
  });

  it("doesn't count a failed read, a write or trash, or another connection's tool of the same name", () => {
    expect(readLocalFiles([tool(COMPUTER_TOOL_NAMES.read, "failed")])).toBe(false);
    expect(readLocalFiles([tool(COMPUTER_TOOL_NAMES.write, "done"), tool(COMPUTER_TOOL_NAMES.trash, "declined")])).toBe(false);
    expect(readLocalFiles([tool(COMPUTER_TOOL_NAMES.read, "done", "conn-1")])).toBe(false);
    expect(readLocalFiles(undefined)).toBe(false);
  });

  it("counts a turn that went on from one that read there (COMPUTER_EARLIER), never a connection's tool of that name", () => {
    expect(readLocalFiles([tool(COMPUTER_EARLIER, "done")])).toBe(true);
    expect(readLocalFiles([tool(COMPUTER_EARLIER, "done", "conn-1")])).toBe(false);
    expect(firstLocalRead([{ steps: [] as AgentStepRecord[] }, { steps: [tool(COMPUTER_EARLIER, "done")] }])).toBe(1);
  });

  it("finds where a conversation first holds something read on the computer, a summary of such turns too", () => {
    const plain = { steps: [] as AgentStepRecord[] };
    const read = { steps: [tool(COMPUTER_TOOL_NAMES.read, "done")] };
    expect(firstLocalRead([plain, plain])).toBe(-1);
    expect(firstLocalRead([plain, read, plain, read])).toBe(1);
    expect(firstLocalRead([{ localRead: true as const }, plain])).toBe(0);
  });
});
