import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "./tools";

// Comments, meeting notes, chats with agents and moving several pages, over MCP.
vi.mock("@/db", () => ({ db: {} }));

const comments = vi.hoisted(() => ({
  listComments: vi.fn(),
  commentUsers: vi.fn(),
  changeComments: vi.fn(),
}));
vi.mock("@/server/comments", () => comments);
const threadState = vi.hoisted(() => ({ markedAmong: vi.fn(), setThreadMarked: vi.fn() }));
vi.mock("@/server/thread-state", () => threadState);
const pages = vi.hoisted(() => ({ getPage: vi.fn(), getBreadcrumbs: vi.fn(), movePage: vi.fn() }));
vi.mock("@/server/pages", () => pages);
const databases = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock("@/server/databases", () => databases);
const meetings = vi.hoisted(() => ({ listMeetings: vi.fn() }));
vi.mock("@/server/meetings", () => meetings);
const agents = vi.hoisted(() => ({ getAgent: vi.fn() }));
vi.mock("@/server/agents/manage", async (importOriginal) => ({ ...(await importOriginal<object>()), ...agents }));
const chat = vi.hoisted(() => ({ sendAgentChat: vi.fn(), chatTurn: vi.fn(), agentChatInfo: vi.fn(), getAgentConversation: vi.fn() }));
vi.mock("@/server/agents/chat", async (importOriginal) => ({ ...(await importOriginal<object>()), ...chat }));

const writer = { userId: "user-1", clientId: "client-1", scopes: ["pages:read", "pages:write"] };
const reader = { userId: "user-1", clientId: "client-1", scopes: ["pages:read"] };

type Result = { isError: boolean; text: string; data: Record<string, any> };

async function callTool(principal: typeof writer, name: string, args: Record<string, unknown>): Promise<Result> {
  const server = createMcpServer(principal as never);
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: JSONRPCMessage[] = [];
  client.onmessage = (message) => void inbox.push(message);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 2000; i++) {
      const hit = inbox.find((message) => "id" in message && message.id === id);
      if (hit) return hit as { result?: { isError?: boolean; content: { text: string }[] }; error?: { message: string } };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no response to request ${id}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "tools-collab", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const response = await waitFor(2);
  await server.close();
  const text = response.result?.content[0]?.text ?? response.error?.message ?? "";
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(text);
  } catch {
    // An error's text.
  }
  return { isError: Boolean(response.result?.isError ?? response.error), text, data };
}

const page = { id: "page-1", workspaceId: "ws-1", title: "Plan", parentId: null, kind: "page", archivedAt: null };
const row = { ...page, id: "row-1", title: "Refund", parentId: "db-1" };
const database = { ...page, id: "db-1", title: "Tickets", kind: "database" };
const thread = (resolved = false) => ({
  id: "t-1",
  quote: "the plan",
  resolved,
  comments: [{ id: "c-1", userId: "user-1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", body: [{ type: "paragraph", content: [{ type: "text", text: "Looks good", styles: {} }] }], reactions: [] }],
});

beforeEach(() => {
  vi.clearAllMocks();
  pages.getPage.mockImplementation(async (_u: string, id: string) => (id === "row-1" ? row : id === "db-1" ? database : { ...page, id }));
  comments.listComments.mockResolvedValue([thread()]);
  comments.commentUsers.mockResolvedValue([{ id: "user-1", username: "Erhan" }]);
  comments.changeComments.mockResolvedValue({ thread: { id: "t-2" }, comment: { id: "c-2" } });
  threadState.markedAmong.mockResolvedValue(new Set());
});

describe("add_comment", () => {
  it("starts a thread about the whole page when given no quote, property or thread", async () => {
    const r = await callTool(writer, "add_comment", { page_id: "page-1", text: "Who owns this?" });
    expect(r.isError).toBe(false);
    expect(comments.changeComments).toHaveBeenCalledWith("user-1", "page-1", { type: "createThread", body: "Who owns this?" });
    expect(r.data).toMatchObject({ thread_id: "t-2", comment_id: "c-2", about_page: true });
  });

  it("starts a thread on a row's value, by property name", async () => {
    databases.getDatabase.mockResolvedValue({ database, properties: [{ id: "prop-amount", name: "Amount", type: "number" }] });
    const r = await callTool(writer, "add_comment", { page_id: "row-1", text: "Too high?", property: "amount" });
    expect(r.isError).toBe(false);
    expect(comments.changeComments).toHaveBeenCalledWith("user-1", "row-1", { type: "createThread", body: "Too high?", propertyId: "prop-amount" });
    expect(r.data.about_page).toBeUndefined();
    expect((await callTool(writer, "add_comment", { page_id: "row-1", text: "x", property: "Nope" })).text).toMatch(/get_database/);
    expect((await callTool(writer, "add_comment", { page_id: "page-1", text: "x", property: "Amount" })).text).toMatch(/database rows/);
  });

  it("takes at most one of quote, property and thread_id", async () => {
    const r = await callTool(writer, "add_comment", { page_id: "page-1", text: "x", quote: "the plan", thread_id: "t-1" });
    expect(r.isError).toBe(true);
    expect(comments.changeComments).not.toHaveBeenCalled();
  });
});

describe("change_comment", () => {
  it("is one write tool that clients ask about before calling", async () => {
    const server = createMcpServer(writer as never);
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    const inbox: JSONRPCMessage[] = [];
    client.onmessage = (message) => void inbox.push(message);
    await server.connect(serverSide);
    await client.start();
    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    for (let i = 0; i < 400 && !inbox.some((m) => "id" in m && m.id === 2); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await server.close();
    const list = inbox.find((m) => "id" in m && m.id === 2) as unknown as { result: { tools: { name: string; annotations: Record<string, boolean>; inputSchema: any }[] } };
    const tool = list.result.tools.find((t) => t.name === "change_comment")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool.inputSchema.required).toEqual(["page_id", "thread_id", "action"]);
  });

  it("edits, deletes, resolves, reopens and reacts through the page's comments, answering with the thread", async () => {
    const cases: [Record<string, unknown>, unknown][] = [
      [{ action: "edit", comment_id: "c-1", text: "Fixed" }, { type: "updateComment", threadId: "t-1", commentId: "c-1", body: "Fixed" }],
      [{ action: "delete", comment_id: "c-1" }, { type: "deleteComment", threadId: "t-1", commentId: "c-1" }],
      [{ action: "delete_thread" }, { type: "deleteThread", threadId: "t-1" }],
      [{ action: "resolve" }, { type: "resolveThread", threadId: "t-1" }],
      [{ action: "reopen" }, { type: "unresolveThread", threadId: "t-1" }],
      [{ action: "react", comment_id: "c-1", emoji: "👍" }, { type: "addReaction", threadId: "t-1", commentId: "c-1", emoji: "👍" }],
      [{ action: "unreact", comment_id: "c-1", emoji: "👍" }, { type: "deleteReaction", threadId: "t-1", commentId: "c-1", emoji: "👍" }],
    ];
    for (const [args, op] of cases) {
      const r = await callTool(writer, "change_comment", { page_id: "page-1", thread_id: "t-1", ...args });
      expect(r.isError, JSON.stringify(args)).toBe(false);
      expect(comments.changeComments).toHaveBeenLastCalledWith("user-1", "page-1", op);
    }
    comments.listComments.mockResolvedValue([thread(true)]);
    const resolved = await callTool(writer, "change_comment", { page_id: "page-1", thread_id: "t-1", action: "resolve" });
    expect(resolved.data.thread).toMatchObject({ id: "t-1", resolved: true, comments: [{ id: "c-1", author: "Erhan", text: "Looks good" }] });
    comments.listComments.mockResolvedValue([]);
    const gone = await callTool(writer, "change_comment", { page_id: "page-1", thread_id: "t-1", action: "delete_thread" });
    expect(gone.data).toMatchObject({ thread_id: "t-1", deleted: true });
  });

  it("marks a thread for the user alone, without changing the page's comments", async () => {
    await callTool(writer, "change_comment", { page_id: "page-1", thread_id: "t-1", action: "mark" });
    expect(threadState.setThreadMarked).toHaveBeenCalledWith("user-1", "page-1", "t-1", true);
    await callTool(writer, "change_comment", { page_id: "page-1", thread_id: "t-1", action: "unmark" });
    expect(threadState.setThreadMarked).toHaveBeenLastCalledWith("user-1", "page-1", "t-1", false);
    expect(comments.changeComments).not.toHaveBeenCalled();
  });

  it("refuses fields that don't go with the action, and read-only connections", async () => {
    for (const args of [
      { action: "edit", comment_id: "c-1" },
      { action: "edit", text: "x" },
      { action: "delete" },
      { action: "resolve", comment_id: "c-1" },
      { action: "react", comment_id: "c-1" },
      { action: "resolve", emoji: "👍" },
      { action: "delete", comment_id: "c-1", text: "x" },
    ]) {
      expect((await callTool(writer, "change_comment", { page_id: "page-1", thread_id: "t-1", ...args })).isError, JSON.stringify(args)).toBe(true);
    }
    const readOnly = await callTool(reader, "change_comment", { page_id: "page-1", thread_id: "t-1", action: "resolve" });
    expect(readOnly.text).toMatch(/pages:write/);
    expect(comments.changeComments).not.toHaveBeenCalled();
  });
});

describe("list_meeting_notes", () => {
  const meeting = (id: string, startedAt: string | null, scheduledAt: string | null, extra: Record<string, unknown> = {}) => ({
    pageId: id,
    meetingId: `m-${id}`,
    title: "",
    pageTitle: `Sync ${id}`,
    icon: null,
    scheduledAt,
    startedAt,
    endedAt: null,
    seconds: 1830,
    attendees: [{ id: "user-1", name: "Erhan" }],
    status: startedAt ? "done" : "",
    preview: "Ship on Friday",
    ...extra,
  });

  it("lists the meetings narrowed by words and days, newest first, on read-only connections too", async () => {
    meetings.listMeetings.mockResolvedValue([
      meeting("p3", null, "2026-10-30T09:00:00.000Z"),
      meeting("p2", "2026-10-20T09:00:00.000Z", null, { title: "Budget review", preview: "" }),
      meeting("p1", "2026-10-01T09:00:00.000Z", null),
    ]);
    const all = await callTool(reader, "list_meeting_notes", { workspace_id: "ws-1" });
    expect(all.isError).toBe(false);
    expect(meetings.listMeetings).toHaveBeenCalledWith("user-1", "ws-1");
    expect(all.data.meetings.map((m: { page_id: string }) => m.page_id)).toEqual(["p3", "p2", "p1"]);
    expect(all.data.meetings[0]).toMatchObject({ title: "Sync p3", status: "planned", minutes: 31, attendees: ["Erhan"], summary_start: "Ship on Friday" });
    expect(all.data.meetings[1]).toMatchObject({ title: "Budget review", page_title: "Sync p2", status: "done" });
    expect(all.data.meetings[0].url).toMatch(/\/w\/ws-1\/p\/p3$/);

    const october = await callTool(reader, "list_meeting_notes", { workspace_id: "ws-1", from: "2026-10-02", to: "2026-10-25" });
    expect(october.data.meetings.map((m: { page_id: string }) => m.page_id)).toEqual(["p2"]);
    const budget = await callTool(reader, "list_meeting_notes", { workspace_id: "ws-1", query: "budget" });
    expect(budget.data.meetings.map((m: { page_id: string }) => m.page_id)).toEqual(["p2"]);
    const one = await callTool(reader, "list_meeting_notes", { workspace_id: "ws-1", limit: 1 });
    expect(one.data).toMatchObject({ more: 2 });
  });
});

describe("chats with agents", () => {
  beforeEach(() => {
    agents.getAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1" });
    chat.sendAgentChat.mockResolvedValue({ conversation: { id: "conv-1", title: "Hi", updatedAt: "2026-10-25T00:00:00.000Z" }, runId: "run-1" });
  });

  it("sends a message as the user's chat in the app and waits for the answer", async () => {
    chat.chatTurn
      .mockResolvedValueOnce({ status: "running", code: null, answer: "" })
      .mockResolvedValueOnce({ status: "done", code: null, answer: "Three tickets are late." });
    const r = await callTool(writer, "chat_with_agent", { agent_id: "agent-1", message: "What is late?", wait_seconds: 5 });
    expect(r.isError).toBe(false);
    expect(chat.sendAgentChat).toHaveBeenCalledWith("user-1", { workspaceId: "ws-1", agentId: "agent-1", place: null, conversationId: null, message: "What is late?" });
    expect(r.data).toMatchObject({ conversation_id: "conv-1", run_id: "run-1", status: "done", answer: "Three tickets are late." });
  });

  it("says when the answer takes longer, or failed, and words refusals with a next step", async () => {
    chat.chatTurn.mockResolvedValue({ status: "running", code: null, answer: "" });
    const waiting = await callTool(writer, "chat_with_agent", { agent_id: "agent-1", message: "Hi", conversation_id: "conv-1", wait_seconds: 0 });
    expect(waiting.data).toMatchObject({ status: "running", note: expect.stringMatching(/get_agent_chat/) });
    expect(chat.sendAgentChat).toHaveBeenLastCalledWith("user-1", expect.objectContaining({ conversationId: "conv-1" }));

    chat.chatTurn.mockResolvedValue({ status: "failed", code: "aiOff", answer: "" });
    expect((await callTool(writer, "chat_with_agent", { agent_id: "agent-1", message: "Hi", wait_seconds: 0 })).data).toMatchObject({ status: "failed", failed: "aiOff" });

    const { AgentChatRefusal } = await import("@/server/agents/chat");
    chat.sendAgentChat.mockRejectedValueOnce(new AgentChatRefusal("busy", "The agent is still answering"));
    expect((await callTool(writer, "chat_with_agent", { agent_id: "agent-1", message: "Hi" })).text).toMatch(/still answering.*get_agent_chat/);
    chat.sendAgentChat.mockRejectedValueOnce(new AgentChatRefusal("paused", "This chat isn't available"));
    expect((await callTool(writer, "chat_with_agent", { agent_id: "agent-1", message: "Hi" })).text).toMatch(/update_agent/);
    expect((await callTool(reader, "chat_with_agent", { agent_id: "agent-1", message: "Hi" })).text).toMatch(/pages:write/);
  });

  it("lists the user's conversations and reads one, on read-only connections too", async () => {
    chat.agentChatInfo.mockResolvedValue({ state: "readOnly", agent: { id: "agent-1" }, conversations: [{ id: "conv-1", title: "Hi", updatedAt: "2026-10-25T00:00:00.000Z" }] });
    const list = await callTool(reader, "get_agent_chat", { agent_id: "agent-1" });
    expect(chat.agentChatInfo).toHaveBeenCalledWith("user-1", "ws-1", "agent-1", null);
    expect(list.data).toEqual({ agent_id: "agent-1", state: "readOnly", conversations: [{ conversation_id: "conv-1", title: "Hi", updated_at: "2026-10-25T00:00:00.000Z" }] });

    chat.getAgentConversation.mockResolvedValue({
      id: "conv-1",
      title: "Hi",
      running: "run-2",
      messages: [
        { role: "user", content: "What is late?", at: "2026-10-25T00:00:00.000Z", code: null },
        { role: "assistant", content: "", at: "2026-10-25T00:00:05.000Z", code: "provider" },
        { role: "user", content: "Again?", at: "2026-10-25T00:01:00.000Z", code: null },
      ],
    });
    const one = await callTool(reader, "get_agent_chat", { agent_id: "agent-1", conversation_id: "conv-1" });
    expect(one.data).toMatchObject({ conversation_id: "conv-1", answering: true });
    expect(one.data.messages[1]).toEqual({ role: "assistant", text: "", at: "2026-10-25T00:00:05.000Z", failed: "provider" });
  });
});

describe("move_page with page_ids", () => {
  it("moves each page to the same place, listing those that couldn't move", async () => {
    pages.getBreadcrumbs.mockResolvedValue([]);
    pages.getPage.mockImplementation(async (_u: string, id: string) =>
      id === "gone" ? { ...page, id, archivedAt: new Date() } : id === "parent-1" ? { ...page, id } : { ...page, id, parentId: "old" },
    );
    const r = await callTool(writer, "move_page", { page_ids: ["a", "gone", "b", "a"], parent_id: "parent-1" });
    expect(r.isError).toBe(false);
    expect(pages.movePage.mock.calls.map((c) => c[1])).toEqual(["a", "b"]);
    expect(r.data.moved.map((m: { id: string }) => m.id)).toEqual(["a", "b"]);
    expect(r.data.not_moved).toEqual([{ id: "gone", error: expect.stringMatching(/trash/) }]);
    for (const args of [{ parent_id: "parent-1" }, { page_id: "a", page_ids: ["b"], parent_id: "parent-1" }]) {
      expect((await callTool(writer, "move_page", args)).isError).toBe(true);
    }
  });
});
