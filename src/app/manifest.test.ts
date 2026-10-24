import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const stt = vi.hoisted(() => ({ on: false }));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async (ns: string) => (key: string) => `${ns}.${key}`),
}));
vi.mock("@/server/ai", () => ({ sttEnabled: () => stt.on }));

const { default: manifest } = await import("./manifest");

describe("web app manifest", () => {
  it("offers the quick note as a shortcut, in the visitor's language", async () => {
    stt.on = false;
    const m = await manifest();
    expect(m.shortcuts).toEqual([
      { name: "page.quickNote.shortcut", short_name: "page.quickNote.shortcutShort", url: "/share", icons: [expect.objectContaining({ src: "/icons/icon-192.png" })] },
    ]);
    expect(m.description).toBe("common.appDescription");
  });

  it("adds a voice note shortcut where the server can transcribe", async () => {
    stt.on = true;
    const m = await manifest();
    expect(m.shortcuts?.map((s) => s.url)).toEqual(["/share", "/share?voice=1"]);
    expect(m.shortcuts?.[1].name).toBe("page.voiceNote.shortcut");
  });

  it("is installable: a name, a standalone start page in scope, and icons that exist", async () => {
    const m = await manifest();
    expect(m).toMatchObject({ id: "/", name: "Leafdesk", short_name: "Leafdesk", start_url: "/", scope: "/", display: "standalone" });
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect((m.icons ?? []).some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of [...(m.icons ?? []), ...(m.shortcuts ?? []).flatMap((s) => s.icons ?? [])]) {
      expect(existsSync(join(process.cwd(), "public", icon.src)), icon.src).toBe(true);
    }
    // Shortcuts stay inside the app's scope.
    for (const s of m.shortcuts ?? []) expect(s.url.startsWith(m.scope ?? "/")).toBe(true);
    expect(m.share_target).toMatchObject({ action: "/api/share", method: "POST" });
  });
});
