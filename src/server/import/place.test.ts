import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Imports check where they go before reading any file (a crafted file can take the server a
 * while), and read one import per person at a time.
 */

class AccessError extends Error {}
const requirePageAccess = vi.fn();
const requireTopLevel = vi.fn();
const placeTopLevel = vi.fn();
const readMhtml = vi.fn();
const collectFiles = vi.fn();

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/i18n/messages", () => ({ loadMessages: async () => ({ common: { untitled: "Untitled" } }) }));
vi.mock("@/server/access", () => ({ AccessError, requirePageAccess }));
vi.mock("@/server/teamspaces", () => ({ placeTopLevel }));
vi.mock("@/server/workspaces", () => ({ requireTopLevel }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: vi.fn() }));
vi.mock("@/server/databases", () => ({ addProperty: vi.fn() }));
vi.mock("@/server/files", () => ({ FileError: class extends Error {}, uploadFile: vi.fn() }));
vi.mock("@/server/pages", () => ({ createPage: vi.fn(), removeOrphanFiles: vi.fn() }));
vi.mock("@/lib/import/mhtml", () => ({ readMhtml }));
vi.mock("./archive", () => ({ collectFiles }));
vi.mock("./csv", () => ({ importCsvAsDatabase: vi.fn(), recordImport: vi.fn() }));
vi.mock("./docx-convert", () => ({ imageSources: vi.fn(), isPageImage: vi.fn(), placeImages: vi.fn() }));
vi.mock("./mhtml-convert", () => ({ mhtmlDocument: vi.fn() }));

const { MAX_IMPORTS, requireImportPlace, startImport } = await import("./place");
const { importMhtml } = await import("./mhtml");
const { importPages } = await import("./markdown");

beforeEach(() => {
  vi.clearAllMocks();
  requireTopLevel.mockResolvedValue("shared");
  placeTopLevel.mockResolvedValue({ teamspaceId: "t1", private: false });
});

describe("requireImportPlace", () => {
  it("needs edit access to the page the import goes under, out of the trash", async () => {
    requirePageAccess.mockResolvedValueOnce({ workspaceId: "w2", archivedAt: null });
    expect(await requireImportPlace("u1", { workspaceId: "w1", parentId: "p1" })).toBe("w2");
    expect(requirePageAccess).toHaveBeenCalledWith("u1", "p1", "edit");
    requirePageAccess.mockResolvedValueOnce({ workspaceId: "w2", archivedAt: new Date() });
    await expect(requireImportPlace("u1", { workspaceId: "w1", parentId: "p1" })).rejects.toMatchObject({ code: "noAccess" });
  });

  it("at the top level, a place there: someone outside the workspace is refused", async () => {
    expect(await requireImportPlace("u1", { workspaceId: "w1", parentId: null, teamspaceId: "t1" })).toBe("w1");
    expect(placeTopLevel).toHaveBeenCalledWith("u1", "w1", "shared", "t1");
    requireTopLevel.mockRejectedValueOnce(new AccessError());
    await expect(requireImportPlace("u9", { workspaceId: "w1", parentId: null })).rejects.toBeInstanceOf(AccessError);
  });
});

describe("importers check where they go before reading a file", () => {
  it("web archives", async () => {
    requireTopLevel.mockRejectedValueOnce(new AccessError());
    const files = [{ name: "a.mht", data: new Uint8Array(1) }];
    await expect(importMhtml({ userId: "u9" }, { workspaceId: "w1", parentId: null, files })).rejects.toBeInstanceOf(AccessError);
    expect(readMhtml).not.toHaveBeenCalled();
  });

  it("Markdown, CSV and ZIP files", async () => {
    placeTopLevel.mockRejectedValueOnce(new AccessError());
    const files = [{ path: "a.md", data: new Uint8Array(1) }];
    await expect(importPages({ userId: "u9" }, { workspaceId: "w1", parentId: null, teamspaceId: "t9", files })).rejects.toBeInstanceOf(AccessError);
    expect(collectFiles).not.toHaveBeenCalled();
  });
});

describe("startImport", () => {
  it("takes one import per person and a few per server, and gives the slot back", () => {
    const done = startImport("u1");
    expect(() => startImport("u1")).toThrow(expect.objectContaining({ code: "busy" }));
    const others = Array.from({ length: MAX_IMPORTS - 1 }, (_, i) => startImport(`other${i}`));
    expect(() => startImport("u2")).toThrow(expect.objectContaining({ code: "busy" }));
    done();
    done();
    const again = startImport("u2");
    expect(() => startImport("u1")).toThrow(expect.objectContaining({ code: "busy" }));
    for (const release of [again, ...others]) release();
    startImport("u1")();
  });
});
