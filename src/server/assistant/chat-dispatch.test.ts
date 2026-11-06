import { describe, expect, it, vi } from "vitest";
import type { ChatStepRecord } from "@/db/schema";

/**
 * What the AI chat asks about a change, and what "yes, don't ask again" covers: the rest of the
 * answer (`auto`) while nothing from outside the conversation was read; with files attached, or
 * after a connection's, the web's or mail's words, only changes like the one it was said to (the
 * same kind in the same database or page), and the ask says why (eachTimeReason).
 */
const applied = vi.hoisted(() => [] as string[]);
vi.mock("@/server/ai", () => ({
  AiError: class AiError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/server/connected-app", () => ({ withinWorkspace: (_u: string, _w: string, work: () => unknown) => work() }));
vi.mock("@/server/ai-chat-mail", () => ({ isChatMailTool: () => false, MAIL_TOOL_NAMES: { draft: "draft_mail" }, prepareMailDraft: vi.fn(), runChatMailTool: vi.fn(), saveMailDraft: vi.fn() }));
vi.mock("@/server/ai-chat-web", () => ({ isChatWebTool: () => false, PLAN_TOOL: { name: "plan" }, runChatWebTool: vi.fn(), runPlan: vi.fn() }));
vi.mock("@/server/ai-memory", () => ({ applyMemory: vi.fn(), MEMORY_TOOL_NAMES: new Set(["remember"]), prepareMemory: vi.fn(), READ_MEMORY_TOOL: { name: "read_memory" }, readChatMemory: vi.fn() }));
vi.mock("@/server/ai-reminders", () => ({ REMIND_TOOL_NAME: "remind_person", reminderWhen: vi.fn(), setReminder: vi.fn() }));
vi.mock("@/server/ai-more-tools", () => ({
  callMoreTool: vi.fn(),
  FIND_TOOLS: { name: "find_tools" },
  findTools: vi.fn(),
  isDocsAddress: () => false,
  lazyMoreTools: vi.fn(),
  MORE_TOOL_NAMES: new Set(["use_tool"]),
  moreToolStep: vi.fn(),
  pickMoreTool: vi.fn(),
  readDocsTopic: vi.fn(),
}));
vi.mock("@/server/connections/tools", () => ({ chatToolNow: vi.fn(), inputSummary: vi.fn(), runConnectionTool: vi.fn() }));
vi.mock("@/server/ai-tools", () => ({
  WRITE_TOOL_NAMES: new Set(["update_row", "create_page"]),
  ATTACHMENT_WRITE_TOOL_NAMES: new Set(),
  runTool: vi.fn(),
  prepareWrite: async (_ctx: unknown, _w: string, _s: unknown, call: { name: string; arguments: { row_id: string; database_id: string } }) =>
    call.name === "create_page"
      ? {
          // A page at the top of the workspace: no place to hold "changes like this one" to.
          action: { action: "createPage", target: null, title: "New page", changes: [], content: null },
          record: { kind: "write", action: "createPage", targetId: null, title: "New page", changes: [] },
          execute: async () => ({ id: "p1", title: "New page", text: "" }),
        }
      : {
          action: { action: "updateRow", target: { pageId: call.arguments.row_id, workspaceId: "w", title: "Row", icon: null, kind: "row" }, title: null, changes: [], content: null },
          record: { kind: "write", action: "updateRow", targetId: call.arguments.row_id, title: null, changes: [] },
          execute: async () => ({ id: call.arguments.row_id, title: "Row", text: "" }),
          row: { kind: "update_row", databaseId: call.arguments.database_id, rowId: call.arguments.row_id, payload: {}, before: null },
        },
  applyWrite: async (change: { record: { targetId: string } }) => {
    applied.push(change.record.targetId);
    return { content: "Changed." };
  },
}));

const { createChatDispatch } = await import("./chat-dispatch");

function dispatchWith(over: Partial<Parameters<typeof createChatDispatch>[0]> = {}) {
  applied.length = 0;
  return createChatDispatch({
    userId: "u",
    workspaceId: "w",
    conversationId: "c",
    ctx: { userId: "u", actor: { userId: "u", model: true }, timeZone: "UTC" },
    scope: null,
    registry: { sources: [], byKey: new Map() } as never,
    initialMode: "ask",
    mode: "ask",
    autoChanges: true,
    research: false,
    external: null,
    moreTools: { open: vi.fn(), close: vi.fn() } as never,
    web: false,
    mailTools: new Set(),
    remembers: false,
    typed: [],
    timeZone: "UTC",
    extra: {},
    steps: [],
    filesAttached: false,
    ...over,
  });
}

const update = (row: string, database = "db1") => ({ id: `call-${row}`, name: "update_row", arguments: { row_id: row, database_id: database } });
/** A connection's tool answered earlier in the answer: words no one in the conversation wrote. */
const connectionStep: ChatStepRecord = { kind: "connection", connectionId: "cn", connection: "CRM", tool: "search", writes: false, input: "", outcome: "done" };

describe("don't ask again in the AI chat", () => {
  it("turns the rest of the answer auto when nothing from outside was read", async () => {
    const dispatch = dispatchWith();
    const asked = await dispatch.answer(update("r1"), null, 10_000);
    expect("ask" in asked && asked.ask.eachTime).toBeUndefined();
    await dispatch.answer(update("r1"), "always", 10_000);
    expect(dispatch.mode).toBe("auto");
    const next = await dispatch.answer(update("r2"), null, 10_000);
    expect("ask" in next).toBe(false);
    expect(applied).toEqual(["r1", "r2"]);
  });

  it("covers only changes like this one while files are attached to the conversation, and says why", async () => {
    const dispatch = dispatchWith({ filesAttached: true });
    const asked = await dispatch.answer(update("r1"), null, 10_000);
    expect("ask" in asked && asked.ask).toMatchObject({ eachTimeReason: "files" });
    expect("ask" in asked && asked.ask.eachTime).toBeUndefined();
    await dispatch.answer(update("r1"), "always", 10_000);
    expect(dispatch.mode).toBe("ask");
    expect(dispatch.alike).toEqual(["updateRow:db1"]);
    // Another row of the same database goes through; one in another database is asked about.
    const next = await dispatch.answer(update("r2"), null, 10_000);
    expect("ask" in next).toBe(false);
    const elsewhere = await dispatch.answer(update("r3", "db2"), null, 10_000);
    expect("ask" in elsewhere && elsewhere.ask.eachTimeReason).toBe("files");
    expect(applied).toEqual(["r1", "r2"]);
  });

  it("asks again, saying why, once the answer read a connection's words, in auto mode too", async () => {
    const steps: ChatStepRecord[] = [];
    const dispatch = dispatchWith({ mode: "auto", steps });
    const first = await dispatch.answer(update("r1"), null, 10_000);
    expect("ask" in first).toBe(false);
    steps.push(connectionStep);
    const asked = await dispatch.answer(update("r2"), null, 10_000);
    expect("ask" in asked && asked.ask).toMatchObject({ eachTimeReason: "outside" });
    expect(dispatch.mode).toBe("ask");
    await dispatch.answer(update("r2"), "always", 10_000);
    expect(dispatch.mode).toBe("ask");
    expect(applied).toEqual(["r1", "r2"]);
  });

  it("offers no 'changes like this one' for a change with no place to hold to", async () => {
    const dispatch = dispatchWith({ filesAttached: true });
    const asked = await dispatch.answer({ id: "c", name: "create_page", arguments: { row_id: "", database_id: "" } }, null, 10_000);
    expect("ask" in asked && asked.ask).toMatchObject({ eachTime: true, eachTimeReason: "files" });
    await dispatch.answer({ id: "c", name: "create_page", arguments: { row_id: "", database_id: "" } }, "always", 10_000);
    expect(dispatch.alike).toEqual([]);
  });

  it("takes the changes covered up again with the run, unless changes without asking were turned off since", async () => {
    const off = dispatchWith({ filesAttached: true, alike: ["updateRow:db1"], autoChanges: false });
    expect("ask" in (await off.answer(update("r8"), null, 10_000))).toBe(true);
    const dispatch = dispatchWith({ filesAttached: true, alike: ["updateRow:db1"] });
    const next = await dispatch.answer(update("r9"), null, 10_000);
    expect("ask" in next).toBe(false);
    expect(applied).toEqual(["r9"]);
  });

  it("leaves the choice out where the workspace turned changes without asking off", async () => {
    const dispatch = dispatchWith({ autoChanges: false });
    const asked = await dispatch.answer(update("r1"), null, 10_000);
    expect("ask" in asked && asked.ask).toMatchObject({ eachTime: true });
    expect("ask" in asked && asked.ask.eachTimeReason).toBeUndefined();
    await dispatch.answer(update("r1"), "always", 10_000);
    expect(dispatch.mode).toBe("ask");
  });

  it("asks about a further tool's change as about its own, saying why, and never covers one that reaches people", async () => {
    const { callMoreTool, pickMoreTool } = await import("@/server/ai-more-tools");
    const tool = (eachTime: boolean) => ({ name: "archive_page", title: "Archive page", description: "", inputSchema: {}, writes: true, eachTime });
    vi.mocked(pickMoreTool).mockReturnValue({ tool: tool(false), args: {} });
    vi.mocked(callMoreTool).mockResolvedValue({ content: "Done.", isError: false, step: { kind: "tool", tool: "archive_page", title: "Archive page", input: "", outcome: "done" } as never });
    const use = (id: string) => ({ id, name: "use_tool", arguments: { name: "archive_page" } });
    const dispatch = dispatchWith({ steps: [connectionStep] });
    const asked = await dispatch.answer(use("t1"), null, 10_000);
    expect("ask" in asked && asked.ask).toMatchObject({ action: "tool", eachTime: true, eachTimeReason: "outside" });
    await dispatch.answer(use("t1"), "always", 10_000);
    expect(dispatch.mode).toBe("ask");
    expect("ask" in (await dispatch.answer(use("t2"), null, 10_000))).toBe(true);
    // One that reaches people or runs on its own: asked about each time, with no reason to give.
    vi.mocked(pickMoreTool).mockReturnValue({ tool: tool(true), args: {} });
    const each = await dispatch.answer(use("t3"), null, 10_000);
    expect("ask" in each && each.ask).toMatchObject({ eachTime: true });
    expect("ask" in each && each.ask.eachTimeReason).toBeUndefined();
  });

  it("says why a note about the person is asked about instead of kept at once", async () => {
    const { applyMemory, prepareMemory } = await import("@/server/ai-memory");
    const note = { action: { action: "remember", target: null, title: "Likes tea", changes: [], content: null }, where: null, change: { kind: "remember", text: "Likes tea", category: null, details: null, replaces: null, previous: null } };
    vi.mocked(prepareMemory).mockResolvedValue(note as never);
    vi.mocked(applyMemory).mockResolvedValue({ content: "Kept." });
    const remember = { id: "n1", name: "remember", arguments: { text: "Likes tea" } };
    const own = await dispatchWith({ remembers: true }).answer(remember, null, 10_000);
    expect("ask" in own).toBe(false);
    const asked = await dispatchWith({ remembers: true, filesAttached: true }).answer(remember, null, 10_000);
    expect("ask" in asked && asked.ask).toMatchObject({ action: "remember", eachTime: true, eachTimeReason: "files" });
  });
});
