import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlainThread } from "@/lib/comments";

/**
 * Comment changes on a row's property values, as server/comments.ts routes them: to the threads kept
 * apart from the row's document, and heard about only by those who see the value. The database is
 * left out (scripts/comments-e2e.ts runs the same against Postgres).
 */

const state = vi.hoisted(() => ({
  ops: [] as { store: "document" | "property"; type: string; propertyId?: string }[],
  recorded: [] as string[][],
  mentionRuns: [] as string[][],
  /** Who sees the property's value. */
  seers: new Set<string>(),
}));

const thread = (id: string, userIds: string[]): PlainThread => ({
  id,
  createdAt: "",
  updatedAt: "",
  resolved: false,
  resolvedBy: null,
  comments: userIds.map((userId, i) => ({ id: `${id}-c${i}`, userId, createdAt: "", updatedAt: "", deletedAt: null, body: null, reactions: [] })),
});

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/access", () => ({
  AccessError: class extends Error {},
  getMembership: vi.fn(),
  hasLevel: () => true,
  isGuest: () => false,
  requirePageAccess: vi.fn(),
  resolvePageAccess: async () => ({ page: { workspaceId: "ws", createdBy: "ann", archivedAt: null }, level: "comment" }),
}));
vi.mock("@/server/collab/bridge", () => ({
  getCollab: () => ({
    commentOp: async (_pageId: string, actor: { userId: string }, op: { type: string; threadId?: string }) => {
      state.ops.push({ store: "document", type: op.type });
      const t = thread(op.threadId ?? "doc-new", ["ann", actor.userId]);
      return { thread: t, comment: t.comments.at(-1) };
    },
  }),
}));
vi.mock("@/server/property-comments", () => ({
  propertyThreadOf: async (_pageId: string, threadId: string) => (threadId === "on-status" ? "status" : null),
  seersOf: async (_pageId: string, _propertyId: string, ids: string[]) => ids.filter((id) => state.seers.has(id)),
  propertyCommentOp: async (_pageId: string, actor: { userId: string }, op: { type: string; threadId?: string }, propertyId: string) => {
    state.ops.push({ store: "property", type: op.type, propertyId });
    const t = { ...thread(op.threadId ?? "on-status-new", ["ann", "bob", actor.userId]), property: { id: propertyId, name: "Status" } };
    return { thread: t, comment: t.comments.at(-1) };
  },
  threadsVisibleTo: vi.fn(),
}));
vi.mock("@/server/notifications", () => ({
  recordComment: async (_actor: string, _ws: string, _page: string, _threadId: string, userIds: string[]) => void state.recorded.push([...userIds].sort()),
  withdrawComments: vi.fn(),
}));
vi.mock("@/server/page-watch", () => ({ newThreadAudience: async () => ["ann", "bob", "cem"] }));
vi.mock("@/server/row-follow", () => ({ followOnTakingPart: vi.fn() }));
vi.mock("@/server/workspaces", () => ({ workspacePeople: vi.fn() }));
vi.mock("@/server/agents/users", () => ({ agentMarks: vi.fn(), markOf: vi.fn() }));
vi.mock("@/server/agents/mentions", () => ({
  startMentionRuns: async ({ mentioned }: { mentioned: string[] }) => void state.mentionRuns.push([...mentioned].sort()),
}));
vi.mock("@/server/thread-mute", () => ({ threadMuters: async () => [], unmuteThread: vi.fn(), forgetThreadMutes: vi.fn() }));
vi.mock("@/server/thread-state", () => ({ forgetThreadStates: vi.fn() }));

const { changeComments } = await import("./comments");

const mention = (userId: string) => [
  { type: "paragraph", content: [{ type: "mention", props: { kind: "user", id: "m1", userId, name: userId } }, { type: "text", text: " look", styles: {} }] },
];

beforeEach(() => {
  state.ops = [];
  state.recorded = [];
  state.mentionRuns = [];
  state.seers = new Set(["ann", "cem"]);
});

describe("comments on property values", () => {
  it("start a thread on the property, which the row's watchers who see it hear about", async () => {
    await changeComments("dan", "row", { type: "createThread", body: "Is this right?", propertyId: "status" });
    expect(state.ops).toEqual([{ store: "property", type: "createThread", propertyId: "status" }]);
    expect(state.recorded.at(-1)).toEqual(["ann", "cem"]);
  });

  it("take replies to a property thread there, telling only those of the thread who see the value", async () => {
    await changeComments("dan", "row", { type: "addComment", threadId: "on-status", body: "ok" });
    expect(state.ops).toEqual([{ store: "property", type: "addComment", propertyId: "status" }]);
    // bob wrote in the thread but no longer sees the property.
    expect(state.recorded.at(-1)).toEqual(["ann"]);
  });

  it("start no agent the comment mentions that can't see the value", async () => {
    await changeComments("dan", "row", { type: "addComment", threadId: "on-status", body: [...mention("bob"), ...mention("cem")] });
    expect(state.mentionRuns.at(-1)).toEqual(["cem"]);
  });

  it("leave other threads in the row's document, heard about as before", async () => {
    await changeComments("dan", "row", { type: "addComment", threadId: "on-text", body: "ok" });
    expect(state.ops).toEqual([{ store: "document", type: "addComment" }]);
    expect(state.recorded.at(-1)).toEqual(["ann"]);
  });

  it("drop a quote sent along with a property, which anchors nothing", async () => {
    await changeComments("dan", "row", { type: "createThread", body: "Hm", propertyId: "status", anchor: { quote: "text" } });
    expect(state.ops[0].store).toBe("property");
  });
});
