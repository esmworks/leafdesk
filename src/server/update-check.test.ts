import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { localMode: false, updateCheck: true } }));

const { checkForUpdate, latestRelease, releaseOf } = await import("./update-check");

describe("update check", () => {
  it("reads the latest release's tag and links its notes", () => {
    const release = releaseOf({ tag_name: "v9.1.0", html_url: "https://example.com/elsewhere" }, "0.8.0", new Date(0));
    expect(release).toEqual({
      latest: "9.1.0",
      url: "https://github.com/esmworks/leafdesk/releases/tag/v9.1.0",
      newer: true,
      checkedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(releaseOf({ tag_name: "v0.8.0" }, "0.8.0")?.newer).toBe(false);
  });

  it("ignores answers without a version", () => {
    expect(releaseOf(null, "0.8.0")).toBeNull();
    expect(releaseOf({ tag_name: "nightly" }, "0.8.0")).toBeNull();
    expect(releaseOf({ message: "Not Found" }, "0.8.0")).toBeNull();
  });

  it("asks GitHub with a timeout and keeps the answer", async () => {
    const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({ tag_name: "v99.0.0" })));
    await checkForUpdate(fetcher as unknown as typeof fetch);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/esmworks/leafdesk/releases/latest");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("user-agent")).toBe("Leafdesk");
    expect(latestRelease()).toMatchObject({ latest: "99.0.0", newer: true });
  });

  it("keeps the earlier answer when GitHub fails", async () => {
    const failing = vi.fn(async () => new Response("", { status: 503 }));
    await expect(checkForUpdate(failing as unknown as typeof fetch)).rejects.toThrow("503");
    expect(latestRelease()?.latest).toBe("99.0.0");
  });
});
