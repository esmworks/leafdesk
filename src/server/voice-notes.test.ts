import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A database's writing instructions for voice notes: who may set them, how they are stored, and
 * that a recording saved into the database is written up with them (and one going elsewhere isn't).
 */
const pages: Record<string, Record<string, unknown>> = {};
const updates: Record<string, unknown>[] = [];
const complete = vi.fn();
const requireDatabase = vi.fn();

class AccessError extends Error {}
class AiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

vi.mock("@/db", () => ({
  db: { update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => void updates.push(values) }) }) },
}));
vi.mock("@/server/access", () => ({
  AccessError,
  ConnectedAppReadOnlyError: class extends Error {},
  WorkspacePolicyError: class extends Error {},
  accessRank: vi.fn(),
  hasLevel: vi.fn(),
  levelFromRank: vi.fn(),
  requireMembership: async () => ({}),
  requirePageAccess: async (_userId: string, id: string) => {
    if (!pages[id]) throw new AccessError("Not found");
    return pages[id];
  },
}));
vi.mock("@/server/ai", () => ({
  AiError,
  aiConfig: () => ({ limits: {} }),
  complete,
  contentChars: () => 50_000,
  sttLimitsFor: async () => ({ maxSeconds: 600, maxBytes: 1_000_000 }),
  transcribe: async () => "We met Ayse at Acme, she wants the quote by Friday.",
}));
vi.mock("@/server/ai-writing", () => ({ aiAvailable: async () => true }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: vi.fn() }));
vi.mock("@/server/databases", () => ({ knownProperties: async () => [], requireDatabase }));
vi.mock("@/i18n/messages", () => ({ loadMessages: vi.fn() }));
vi.mock("@/server/mail/locale", () => ({ recipientLocale: vi.fn() }));
vi.mock("@/server/pages", () => ({ createPage: vi.fn() }));
vi.mock("@/server/workspaces", () => ({ workspaceSettings: async () => ({}) }));

const { draftVoiceNote, prepareVoiceNote, setVoiceNoteInstructions } = await import("./voice-notes");

const instructions = "Customer visit note: company, person met, what was discussed, quote status, next step.";
const audio = { bytes: new Blob([new Uint8Array(10)]), type: "audio/webm" };

beforeEach(() => {
  for (const id of Object.keys(pages)) delete pages[id];
  pages.visits = { id: "visits", kind: "database", workspaceId: "w1", archivedAt: null, inTemplate: false, voiceNoteInstructions: instructions };
  pages.plain = { id: "plain", kind: "database", workspaceId: "w1", archivedAt: null, inTemplate: false, voiceNoteInstructions: "" };
  pages.doc = { id: "doc", kind: "page", workspaceId: "w1", archivedAt: null, lockedAt: null, voiceNoteInstructions: "" };
  updates.length = 0;
  complete.mockReset();
  complete.mockResolvedValue({ text: "Title: Acme visit\n---\n## Company\nAcme", stopReason: "stop" });
  requireDatabase.mockReset();
  requireDatabase.mockImplementation(async (_userId: string, id: string) => pages[id]);
});

const promptOf = () => (complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

describe("voice notes with a database's instructions", () => {
  it("writes up a note saved into the database with its instructions", async () => {
    const target = await prepareVoiceNote("ada", { workspaceId: "w1", databaseId: "visits" });
    expect(target).toEqual({ workspaceId: "w1", databaseId: "visits", instructions });
    const draft = await draftVoiceNote("ada", target, audio);
    expect(promptOf()).toContain(`<guidance>\n${instructions}\n</guidance>`);
    expect(draft).toMatchObject({ title: "Acme visit", markdown: "## Company\nAcme", rewritten: true });
  });

  it("leaves them out for a database without any, a private page and the editor", async () => {
    for (const target of [{ workspaceId: "w1", databaseId: "plain" }, { workspaceId: "w1" }, { pageId: "doc" }]) {
      complete.mockClear();
      await draftVoiceNote("ada", await prepareVoiceNote("ada", target), audio);
      expect(promptOf()).not.toContain("guidance");
    }
  });

  it("are set with full access to the database, stored tidied", async () => {
    expect(await setVoiceNoteInstructions("ada", "plain", "  Company\r\nNext step  ")).toBe("Company\nNext step");
    expect(requireDatabase).toHaveBeenCalledWith("ada", "plain", "full");
    expect(updates).toEqual([{ voiceNoteInstructions: "Company\nNext step", updatedBy: "ada" }]);
  });

  it("can't be set without full access, or on a database in the trash", async () => {
    requireDatabase.mockRejectedValueOnce(new AccessError("Not allowed"));
    await expect(setVoiceNoteInstructions("bob", "plain", "Anything")).rejects.toBeInstanceOf(AccessError);
    pages.plain.archivedAt = new Date();
    await expect(setVoiceNoteInstructions("ada", "plain", "Anything")).rejects.toBeInstanceOf(AccessError);
    expect(updates).toEqual([]);
  });
});
