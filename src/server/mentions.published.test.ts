import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

const { publishedRef } = await import("./mentions");

const labels = { untitled: "Untitled", private: "No access", deleted: "Deleted page" };

describe("publishedRef", () => {
  it("names a mentioned page that is published too, as a link", () => {
    expect(publishedRef({ status: "ok", title: "Roadmap" }, "/s/abc", labels)).toEqual({ text: "Roadmap", href: "/s/abc" });
    expect(publishedRef({ status: "ok", title: "  " }, "/s/abc", labels)).toEqual({ text: "Untitled", href: "/s/abc" });
  });

  it("shows a page that isn't published as one visitors have no access to, though its publisher sees it", () => {
    expect(publishedRef({ status: "ok", title: "Salary review" }, null, labels)).toEqual({ text: "No access", href: null });
    expect(publishedRef({ status: "noAccess", title: "" }, null, labels)).toEqual({ text: "No access", href: null });
    expect(publishedRef({ status: "deleted", title: "" }, null, labels)).toEqual({ text: "Deleted page", href: null });
  });
});
