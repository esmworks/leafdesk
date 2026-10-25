import { describe, expect, it } from "vitest";
import { pageFromBlocks } from "./blocks-to-page";

const text = (type: string, value: string, children: object[] = []) => ({ type, content: [{ type: "text", text: value, styles: {} }], children });

describe("pageFromBlocks", () => {
  it("takes the first text block's text as the title, its nested blocks and the rest as the body", () => {
    const nested = text("paragraph", "Call the supplier");
    const next = text("checkListItem", "Send the invoice");
    const { title, body } = pageFromBlocks([text("bulletListItem", "  Order   paper ", [nested]), next]);
    expect(title).toBe("Order paper");
    expect(body).toEqual([nested, next]);
  });

  it("keeps every block in the body when the first has no text to name the page", () => {
    const image = { type: "image", props: { url: "/api/files/1" }, children: [] };
    const after = text("paragraph", "Caption");
    expect(pageFromBlocks([image, after])).toEqual({ title: "", body: [image, after] });
    const empty = text("paragraph", "   ");
    expect(pageFromBlocks([empty, after])).toEqual({ title: "", body: [empty, after] });
  });

  it("shortens a long title", () => {
    expect(pageFromBlocks([text("heading", "x".repeat(600))]).title).toHaveLength(500);
  });
});
