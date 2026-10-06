import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { appUrl: "https://leafdesk.example" } }));

const { idFromLink, idsFromLinks } = await import("./format");

const WS = "0b6f1d2e-3c4a-4b5d-8e9f-a0b1c2d3e4f5";
const PAGE = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const VIEW = "11111111-2222-4333-8444-555555555555";

describe("idFromLink", () => {
  it("takes the page from a page link, on any host or none", () => {
    expect(idFromLink("page_id", `https://leafdesk.example/w/${WS}/p/${PAGE}`)).toBe(PAGE);
    expect(idFromLink("parent_id", `http://localhost:3000/w/${WS}/p/${PAGE}?view=${VIEW}#x`)).toBe(PAGE);
    expect(idFromLink("row_id", `/w/${WS}/p/${PAGE}`)).toBe(PAGE);
    expect(idFromLink("page_id", `  https://leafdesk.example/w/${WS}/p/${PAGE.toUpperCase()}/  `)).toBe(PAGE.toUpperCase());
  });

  it("takes the workspace for workspace_id and the view for view_id", () => {
    expect(idFromLink("workspace_id", `https://leafdesk.example/w/${WS}/p/${PAGE}`)).toBe(WS);
    expect(idFromLink("workspace_id", `https://leafdesk.example/w/${WS}`)).toBe(WS);
    expect(idFromLink("view_id", `https://leafdesk.example/w/${WS}/p/${PAGE}?view=${VIEW}`)).toBe(VIEW);
  });

  it("leaves ids, other values and links naming nothing for the key as they are", () => {
    expect(idFromLink("page_id", PAGE)).toBe(PAGE);
    expect(idFromLink("teamspace_id", "private")).toBe("private");
    expect(idFromLink("template_id", "builtin:meeting-notes")).toBe("builtin:meeting-notes");
    expect(idFromLink("page_id", `https://leafdesk.example/w/${WS}`)).toBe(`https://leafdesk.example/w/${WS}`);
    expect(idFromLink("view_id", `https://leafdesk.example/w/${WS}/p/${PAGE}`)).toBe(`https://leafdesk.example/w/${WS}/p/${PAGE}`);
    expect(idFromLink("page_id", `see https://leafdesk.example/w/${WS}/p/${PAGE}`)).toBe(`see https://leafdesk.example/w/${WS}/p/${PAGE}`);
    expect(idFromLink("page_id", "https://www.notion.so/Plan-0123456789abcdef0123456789abcdef")).toBe(
      "https://www.notion.so/Plan-0123456789abcdef0123456789abcdef",
    );
  });
});

describe("idsFromLinks", () => {
  it("rewrites id arguments and the items of id lists only", () => {
    const markdown = `See [Plan](/w/${WS}/p/${PAGE})`;
    const out = idsFromLinks({
      page_id: `https://leafdesk.example/w/${WS}/p/${PAGE}`,
      row_ids: [`/w/${WS}/p/${PAGE}`, "row-2"],
      parent_id: null,
      markdown,
      title: `/w/${WS}/p/${PAGE}`,
    });
    expect(out).toEqual({ page_id: PAGE, row_ids: [PAGE, "row-2"], parent_id: null, markdown, title: `/w/${WS}/p/${PAGE}` });
  });

  it("returns the same object when there is nothing to rewrite", () => {
    const args = { page_id: PAGE, offset: 0 };
    expect(idsFromLinks(args)).toBe(args);
    expect(idsFromLinks(undefined)).toBeUndefined();
  });
});
