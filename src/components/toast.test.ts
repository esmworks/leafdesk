import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

const { currentToast, dismissToast, showToast } = await import("./toast");

describe("toasts", () => {
  it("shows one at a time: a new note replaces the one showing", () => {
    showToast({ message: "Moved to the trash" });
    const first = currentToast()!;
    showToast({ message: "Moved to", link: { label: "Plans", href: "/w/ws/p/plans" } });
    expect(currentToast()).toMatchObject({ message: "Moved to", link: { label: "Plans" } });
    expect(currentToast()!.id).not.toBe(first.id);
  });

  it("closes only the note it was asked to close", () => {
    showToast({ message: "First" });
    const first = currentToast()!;
    showToast({ message: "Second" });
    dismissToast(first.id);
    expect(currentToast()?.message).toBe("Second");
    dismissToast();
    expect(currentToast()).toBeNull();
  });
});
