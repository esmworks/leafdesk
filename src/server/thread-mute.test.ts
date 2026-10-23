import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlainThread } from "@/lib/comments";

/**
 * Muting a thread's replies, as comment changes see it: who hears about a reply, whose mute it
 * ends, and that deleting the thread forgets its mutes. The database is left out: mutes are kept in
 * a map here (scripts/comments-e2e.ts runs the same against Postgres).
 */

const state = vi.hoisted(() => ({
  mutes: new Map<string, Set<string>>(),
  recorded: [] as { threadId: string; userIds: string[] }[],
  thread: null as PlainThread | null,
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/access", () => ({
  AccessError: class extends Error {},
  getMembership: vi.fn(),
  hasLevel: () => true,
  isGuest: () => false,
  requirePageAccess: vi.fn(),
  resolvePageAccess: async () => ({ page: { workspaceId: "ws", createdBy: "ann", archivedAt: null }, level: "full" }),
}));
vi.mock("@/server/collab/bridge", () => ({
  getCollab: () => ({
    commentOp: async (_pageId: string, actor: { userId: string }, op: { type: string; threadId?: string }) => {
      if (op.type === "deleteThread") return { thread: null };
      const comment = { id: `c${state.thread!.comments.length + 1}`, userId: actor.userId, createdAt: "", updatedAt: "", deletedAt: null, body: null, reactions: [] };
      state.thread = { ...state.thread!, comments: [...state.thread!.comments, comment] };
      return { thread: state.thread, comment };
    },
  }),
}));
vi.mock("@/server/notifications", () => ({
  recordComment: async (_actor: string, _ws: string, _page: string, threadId: string, userIds: string[]) =>
    void state.recorded.push({ threadId, userIds: [...userIds].sort() }),
  withdrawComments: vi.fn(),
}));
vi.mock("@/server/page-watch", () => ({ newThreadAudience: async () => [] }));
vi.mock("@/server/row-follow", () => ({ followOnTakingPart: vi.fn() }));
vi.mock("@/server/workspaces", () => ({ workspacePeople: vi.fn() }));
vi.mock("@/server/agents/users", () => ({ agentMarks: vi.fn(), markOf: vi.fn() }));
vi.mock("@/server/thread-state", () => ({ forgetThreadStates: vi.fn() }));
vi.mock("@/server/property-comments", () => ({ propertyThreadOf: async () => null, seersOf: vi.fn(), propertyCommentOp: vi.fn(), threadsVisibleTo: vi.fn() }));
vi.mock("@/server/thread-mute", () => {
  const of = (threadId: string) => state.mutes.get(threadId) ?? new Set<string>();
  return {
    threadMuters: async (_pageId: string, threadId: string) => [...of(threadId)],
    unmuteThread: async (_pageId: string, threadId: string, userIds: string[]) => userIds.forEach((id) => of(threadId).delete(id)),
    forgetThreadMutes: async (_pageId: string, threadId: string) => void state.mutes.delete(threadId),
  };
});

const { changeComments } = await import("./comments");

const at = (id: string, userId: string) => ({ id, userId, createdAt: "", updatedAt: "", deletedAt: null, body: null, reactions: [] });
const mention = (userId: string) => [
  { type: "paragraph", content: [{ type: "mention", props: { kind: "user", id: "m1", userId, name: userId } }, { type: "text", text: " look", styles: {} }] },
];
const reply = (userId: string, body: unknown = "ok") => changeComments(userId, "page", { type: "addComment", threadId: "t1", body });
const lastHeard = () => state.recorded.at(-1)?.userIds;

beforeEach(() => {
  state.thread = { id: "t1", createdAt: "", updatedAt: "", resolved: false, resolvedBy: null, comments: [at("c1", "ann"), at("c2", "bob"), at("c3", "cem")] };
  state.mutes = new Map([["t1", new Set(["bob"])]]);
  state.recorded = [];
});

describe("muted threads", () => {
  it("tell the person who muted them nothing about replies, and everyone else as before", async () => {
    await reply("ann");
    expect(lastHeard()).toEqual(["cem"]);
    expect(state.mutes.get("t1")?.has("bob")).toBe(true);
  });

  it("still tell them about a reply that mentions them, which ends the mute", async () => {
    await reply("ann", mention("bob"));
    expect(lastHeard()).toEqual(["bob", "cem"]);
    expect(state.mutes.get("t1")?.has("bob")).toBe(false);
    await reply("cem");
    expect(lastHeard()).toEqual(["ann", "bob"]);
  });

  it("end when the person posts in the thread again", async () => {
    await reply("bob");
    expect(state.mutes.get("t1")?.has("bob")).toBe(false);
    await reply("ann");
    expect(lastHeard()).toEqual(["bob", "cem"]);
  });

  it("are forgotten with the thread", async () => {
    await changeComments("ann", "page", { type: "deleteThread", threadId: "t1" });
    expect(state.mutes.has("t1")).toBe(false);
  });
});
