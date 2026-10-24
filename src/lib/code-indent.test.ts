import { describe, expect, it } from "vitest";
import { codeLineBreak } from "./code-indent";

/** The text after Enter at `at` (or over the selection `at`…`to`), or null for the block's own Enter. */
function enter(text: string, at: number, to = at) {
  const edit = codeLineBreak(text, at, to);
  return edit && text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

describe("codeLineBreak", () => {
  it("keeps the current line's indentation on the new line", () => {
    expect(enter("if (a) {\n  call();", 18)).toBe("if (a) {\n  call();\n  ");
    expect(enter("\tlet x = 1", 10)).toBe("\tlet x = 1\n\t");
    // In the middle of a line, the rest moves down after the indentation.
    expect(enter("    foo bar", 8)).toBe("    foo \n    bar");
  });

  it("only counts the indentation before the cursor", () => {
    expect(enter("    foo", 2)).toBe("  \n    foo");
  });

  it("replaces a selection", () => {
    expect(enter("  abc def", 5, 9)).toBe("  abc\n  ");
  });

  it("leaves lines without indentation to the block's own Enter", () => {
    expect(codeLineBreak("foo", 3)).toBeNull();
    expect(codeLineBreak("  a\nb", 5)).toBeNull();
    expect(codeLineBreak("", 0)).toBeNull();
  });

  it("drops the indentation of an empty last line, so the next Enter leaves the block", () => {
    expect(enter("  foo\n  ", 8)).toBe("  foo\n\n");
    // Not at the end of the block: the empty line keeps its indentation.
    expect(enter("  foo\n  \nbar", 8)).toBe("  foo\n  \n  \nbar");
  });
});
