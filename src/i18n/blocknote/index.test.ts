import { he } from "@blocknote/core/locales";
import { describe, expect, it } from "vitest";
import { EDITOR_DICTIONARIES } from ".";

describe("editor dictionaries", () => {
  it("say resolving a comment thread in Hebrew as resolving it, the rest as BlockNote has it", () => {
    const hebrew = EDITOR_DICTIONARIES.he;
    expect(hebrew.comments.actions.resolve).toBe("סמן כנפתר");
    expect(hebrew.comments.sidebar.marked_as_resolved).toBe("סומן כנפתר");
    expect(hebrew.comments.actions.reopen).toBe(he.comments.actions.reopen);
    expect(hebrew.slash_menu).toBe(he.slash_menu);
  });
});
