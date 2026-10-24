import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlainThread } from "@/lib/comments";

/**
 * Reactions as comment changes see them: who hears about one, and what taking one back or deleting
 * the comment takes away. The database is left out (scripts/discussions-e2e.ts runs the same
 * against Postgres).
 */

const state = vi.hoisted(() => ({
  calls: [] as { fn: string; args: unknown[] }[],
  thread: null as PlainThread | null,
}));

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
    commentOp: async (_pageId: string, actor: { userId: string }, op: { type: string; commentId?: string; emoji?: string }) => {
      const thread = state.thread!;
      if (op.type === "deleteComment") {
        state.thread = { ...thread, comments: thread.comments.map((c) => (c.id === op.commentId ? { ...c, deletedAt: "now", body: null } : c)) };
        return { thread: state.thread };
      }
      state.thread = {
        ...thread,
        comments: thread.comments.map((c) => {
          if (c.id !== op.commentId) return c;
          const others = c.reactions.filter((r) => r.emoji !== op.emoji);
          const mine = c.reactions.find((r) => r.emoji === op.emoji)?.userIds.filter((id) => id !== actor.userId) ?? [];
          const userIds = op.type === "addReaction" ? [...mine, actor.userId] : mine;
          return { ...c, reactions: userIds.length ? [...others, { emoji: op.emoji!, userIds }] : others };
        }),
      };
      return { thread: state.thread };
    },
  }),
}));
const record = (fn: string) => async (...args: unknown[]) => void state.calls.push({ fn, args });
vi.mock("@/server/notifications", () => ({
  recordComment: vi.fn(),
  withdrawComments: vi.fn(),
  recordReaction: async (...args: unknown[]) => record("recordReaction")(...args),
  withdrawReaction: async (...args: unknown[]) => record("withdrawReaction")(...args),
  withdrawReactions: async (...args: unknown[]) => record("withdrawReactions")(...args),
}));
vi.mock("@/server/page-watch", () => ({ newThreadAudience: async () => [] }));
vi.mock("@/server/row-follow", () => ({ followOnTakingPart: vi.fn() }));
vi.mock("@/server/workspaces", () => ({ workspacePeople: vi.fn() }));
vi.mock("@/server/agents/users", () => ({ agentMarks: vi.fn(), markOf: vi.fn() }));
vi.mock("@/server/agents/mentions", () => ({ startMentionRuns: vi.fn() }));
vi.mock("@/server/thread-mute", () => ({ threadMuters: async () => [], unmuteThread: vi.fn(), forgetThreadMutes: vi.fn() }));
vi.mock("@/server/thread-state", () => ({ forgetThreadStates: vi.fn() }));
vi.mock("@/server/property-comments", () => ({
  propertyThreadOf: async () => null,
  seersOf: vi.fn(),
  propertyCommentOp: vi.fn(),
  threadsVisibleTo: vi.fn(),
  storedPropertyThreads: vi.fn(),
}));
// No legal holds here: deleting comments goes ahead.
vi.mock("@/server/legal-hold", () => ({ refuseHeldComments: async () => {} }));

const { changeComments } = await import("./comments");

const body = [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Looks good", styles: {} }] }];
const react = (userId: string, emoji = "👍", type: "addReaction" | "deleteReaction" = "addReaction") =>
  changeComments(userId, "page", { type, threadId: "t1", commentId: "c1", emoji });

beforeEach(() => {
  state.calls = [];
  state.thread = {
    id: "t1",
    createdAt: "",
    updatedAt: "",
    resolved: false,
    resolvedBy: null,
    comments: [{ id: "c1", userId: "ann", createdAt: "", updatedAt: "", deletedAt: null, body, reactions: [] }],
  };
});

describe("reactions to comments", () => {
  it("tell the comment's author who reacted with what, quoting the comment", async () => {
    await react("bob");
    expect(state.calls).toEqual([
      {
        fn: "recordReaction",
        args: ["bob", "ws", { pageId: "page", threadId: "t1", commentId: "c1", authorId: "ann", emoji: "👍", excerpt: "Looks good" }],
      },
    ]);
  });

  it("tell nobody about reacting to one's own comment", async () => {
    await react("ann");
    await react("ann", "👍", "deleteReaction");
    expect(state.calls).toEqual([]);
  });

  it("take a reaction taken back out again", async () => {
    await react("bob");
    await react("bob", "👍", "deleteReaction");
    expect(state.calls.map((c) => c.fn)).toEqual(["recordReaction", "withdrawReaction"]);
    expect(state.calls[1].args).toEqual(["bob", "ws", { pageId: "page", threadId: "t1", commentId: "c1", authorId: "ann", emoji: "👍" }]);
  });

  it("take back every reaction notification about a deleted comment", async () => {
    await changeComments("ann", "page", { type: "deleteComment", threadId: "t1", commentId: "c1" });
    expect(state.calls).toEqual([{ fn: "withdrawReactions", args: ["ws", "page", "t1", "c1"] }]);
  });

  it("tell nobody about reactions to a deleted comment", async () => {
    state.thread!.comments[0] = { ...state.thread!.comments[0], deletedAt: "now", body: null };
    await react("bob");
    expect(state.calls).toEqual([]);
  });
});
