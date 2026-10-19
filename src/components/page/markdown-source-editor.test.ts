import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { fileMarkdown, insertLink, insideMath, toggleHeading, toggleList, toggleTaskDone, toggleWrap } from "./markdown-source-editor";

/** Enough of an EditorView for the commands: they read the state and dispatch changes. */
function run(doc: string, from: number, to: number, command: (view: EditorView) => boolean) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(from, to) });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec | ReturnType<EditorState["update"]>) {
      state = ("startState" in spec ? spec : state.update(spec)).state;
    },
  } as unknown as EditorView;
  const handled = command(view);
  const { from: a, to: b } = state.selection.main;
  return { handled, doc: state.doc.toString(), selected: state.sliceDoc(a, b) };
}

describe("formatting commands", () => {
  it("wraps and unwraps a selection", () => {
    expect(run("say hi now", 4, 6, toggleWrap("**"))).toMatchObject({ doc: "say **hi** now", selected: "hi" });
    expect(run("say **hi** now", 6, 8, toggleWrap("**"))).toMatchObject({ doc: "say hi now", selected: "hi" });
    expect(run("say **hi** now", 4, 10, toggleWrap("**"))).toMatchObject({ doc: "say hi now", selected: "hi" });
    expect(run("code", 0, 4, toggleWrap("`")).doc).toBe("`code`");
  });

  it("makes a link with the address selected", () => {
    expect(run("see docs", 4, 8, insertLink)).toMatchObject({ doc: "see [docs](https://)", selected: "https://" });
    expect(run("x", 1, 1, insertLink).doc).toBe("x[](https://)");
  });

  it("sets, changes and removes headings", () => {
    expect(run("Title", 0, 0, toggleHeading(2)).doc).toBe("## Title");
    expect(run("# Title", 0, 0, toggleHeading(3)).doc).toBe("### Title");
    expect(run("## Title", 0, 0, toggleHeading(2)).doc).toBe("Title");
  });

  it("turns lines into lists and back", () => {
    expect(run("a\nb\nc", 0, 5, toggleList("bullet")).doc).toBe("- a\n- b\n- c");
    expect(run("- a\n- b", 0, 7, toggleList("ordered")).doc).toBe("1. a\n2. b");
    expect(run("1. a\n2. b", 0, 9, toggleList("ordered")).doc).toBe("a\nb");
    expect(run("  - a", 0, 0, toggleList("task")).doc).toBe("  - [ ] a");
    expect(run("- [ ] a", 0, 0, toggleList("task")).doc).toBe("a");
  });

  it("checks and unchecks to-dos", () => {
    expect(run("- [ ] a", 0, 0, toggleTaskDone).doc).toBe("- [x] a");
    expect(run("- [x] a", 0, 0, toggleTaskDone).doc).toBe("- [ ] a");
    expect(run("plain", 0, 0, toggleTaskDone).handled).toBe(false);
  });
});

describe("insideMath", () => {
  const at = (doc: string) => {
    const pos = doc.indexOf("|");
    return insideMath(EditorState.create({ doc: doc.replace("|", "") }), pos);
  };

  it("knows inline equations on the line", () => {
    expect(at("Euler $e^{i|")).toBe(true);
    expect(at("Euler $e$ and |")).toBe(false);
    expect(at("Costs \\$5 and |")).toBe(false);
  });

  it("knows equation blocks from the lines just above", () => {
    expect(at("Intro\n\n$$\n\\int_0^1 |")).toBe(true);
    expect(at("$$\nx\n$$\n\nAfter |")).toBe(false);
    expect(at("Text\n\nPlain |")).toBe(false);
    // A closing `$$` follows the equation's lines: the line after it is outside.
    expect(at("\n$$\nx\n$$\ny|")).toBe(false);
  });
});

describe("fileMarkdown", () => {
  it("writes files as the page's Markdown does", () => {
    expect(fileMarkdown({ name: "a.png", type: "image/png" }, "/f/1")).toBe("![a.png](/f/1)");
    expect(fileMarkdown({ name: "v.mp4", type: "video/mp4" }, "/f/2")).toBe("![v.mp4](/f/2)");
    expect(fileMarkdown({ name: "s.mp3", type: "audio/mpeg" }, "/f/3")).toBe('<audio src="/f/3" controls></audio>');
    expect(fileMarkdown({ name: "r [1].pdf", type: "application/pdf" }, "/f/4")).toBe("[r \\[1\\].pdf](/f/4)");
  });
});
