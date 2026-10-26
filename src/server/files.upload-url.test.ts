import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/access", async (original) => ({
  ...(await original<typeof import("@/server/access")>()),
  requirePageAccess: vi.fn(async () => ({ workspaceId: "ws-1" })),
}));
const fetchRemoteFile = vi.hoisted(() => vi.fn());
vi.mock("@/server/remote-fetch", async (original) => ({ ...(await original<typeof import("@/server/remote-fetch")>()), fetchRemoteFile }));

const { FileError, uploadFromUrl } = await import("./files");
const { RemoteFetchError } = await import("@/server/remote-fetch");
const { ALLOWED_PORTS } = await import("@/server/ssrf");

describe("uploadFromUrl (attach_file)", () => {
  it("fetches on the web's usual ports only, as the agents' web fetch does", async () => {
    fetchRemoteFile.mockRejectedValueOnce(new RemoteFetchError("Port 6379 is not allowed", "blocked"));
    await expect(uploadFromUrl("user-1", "page-1", "https://example.com:6379/x")).rejects.toBeInstanceOf(FileError);
    expect(fetchRemoteFile).toHaveBeenCalledWith("https://example.com:6379/x", expect.objectContaining({ ports: ALLOWED_PORTS }));
  });
});
