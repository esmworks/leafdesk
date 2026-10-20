import { describe, expect, it } from "vitest";
import { caretOutsideLabels, deleteLabel, EMPTY_DRAFT, expandDraft, insertPaste, normalizePaste, pasteLineCount, shouldCollapsePaste, syncDraft, uniqueLabel } from "./chat-paste";

// Labels as uniqueLabel makes them, with spaces that don't break.
const label = (n: number) => `[Pasted\u00a0${n}\u00a0lines]`;

describe("shouldCollapsePaste", () => {
  it("leaves a short line and two lines as text", () => {
    expect(shouldCollapsePaste("hello")).toBe(false);
    expect(shouldCollapsePaste("one\ntwo")).toBe(false);
    expect(shouldCollapsePaste("  one\ntwo\n\n")).toBe(false);
  });
  it("makes three lines, or more than 150 characters, a label", () => {
    expect(shouldCollapsePaste("a\nb\nc")).toBe(true);
    expect(shouldCollapsePaste("x".repeat(151))).toBe(true);
    expect(shouldCollapsePaste("x".repeat(150))).toBe(false);
  });
});

describe("pasteLineCount and normalizePaste", () => {
  it("doesn't count a line break at the end", () => {
    expect(pasteLineCount("a\nb\n")).toBe(2);
    expect(pasteLineCount("a")).toBe(1);
  });
  it("turns CRLF and CR into LF", () => {
    expect(normalizePaste("a\r\nb\rc")).toBe("a\nb\nc");
  });
});

describe("insertPaste", () => {
  it("puts the label at the caret and moves the pastes after it", () => {
    const first = insertPaste({ text: "ab", pastes: [] }, "LATER", label(3), 2, 2);
    const both = insertPaste(first, "EARLIER", label(4), 1, 1);
    expect(both.text).toBe(`a${label(4)}b${label(3)}`);
    expect(expandDraft(both)).toBe("aEARLIERbLATER");
    expect(both.pastes.map((p) => both.text.slice(p.start, p.end))).toEqual([label(4), label(3)]);
  });
  it("takes the place of the selection, and of a paste the selection covers", () => {
    const one = insertPaste({ text: "hello world", pastes: [] }, "ONE", label(3), 6, 11);
    expect(one.text).toBe(`hello ${label(3)}`);
    const over = insertPaste(one, "TWO", label(5), 0, one.text.length);
    expect(over.pastes).toHaveLength(1);
    expect(expandDraft(over)).toBe("TWO");
  });
});

describe("uniqueLabel", () => {
  it("numbers a label another paste has, inside its brackets", () => {
    const one = insertPaste(EMPTY_DRAFT, "A", label(3), 0, 0);
    expect(uniqueLabel(one.pastes, "[Pasted 3 lines]")).toBe("[Pasted\u00a03\u00a0lines\u00a0#2]");
    const two = insertPaste(one, "B", "[Pasted\u00a03\u00a0lines\u00a0#2]", one.text.length, one.text.length);
    expect(uniqueLabel(two.pastes, "[Pasted 3 lines]")).toBe("[Pasted\u00a03\u00a0lines\u00a0#3]");
    expect(uniqueLabel(two.pastes, label(4))).toBe(label(4));
  });
});

describe("syncDraft", () => {
  const two = () => {
    const one = insertPaste(EMPTY_DRAFT, "FIRST", label(3), 0, 0);
    const spaced = { ...one, text: `${one.text} and ` };
    return insertPaste(spaced, "SECOND", uniqueLabel(one.pastes, label(3)), spaced.text.length, spaced.text.length);
  };
  it("keeps each paste with its own text when one of the same size is deleted", () => {
    const draft = two();
    const synced = syncDraft(draft, draft.text.replace(`${label(3)} and `, ""));
    expect(expandDraft(synced)).toBe("SECOND");
  });
  it("moves a paste when text is typed before it, and drops one whose label is broken", () => {
    const draft = insertPaste({ text: "x", pastes: [] }, "BODY", label(3), 1, 1);
    const typed = syncDraft(draft, `Look: ${draft.text}`);
    expect(expandDraft(typed)).toBe("Look: xBODY");
    const broken = syncDraft(typed, typed.text.slice(0, -1));
    expect(broken.pastes).toEqual([]);
    expect(expandDraft(broken)).toBe(broken.text);
  });
  it("lets go of every paste when the box is emptied", () => {
    expect(syncDraft(two(), "")).toEqual(EMPTY_DRAFT);
  });
});

describe("expandDraft", () => {
  it("finds a label whose offset moved", () => {
    const draft = insertPaste(EMPTY_DRAFT, "BODY", label(3), 0, 0);
    expect(expandDraft({ text: `Hi ${draft.text}`, pastes: draft.pastes })).toBe("Hi BODY");
  });
});

describe("a label is one piece", () => {
  const draft = insertPaste({ text: "ab", pastes: [] }, "BODY", label(3), 1, 1);
  const end = 1 + label(3).length;
  it("goes whole with Backspace after or inside it, and Delete before it", () => {
    expect(deleteLabel(draft, end, "Backspace")).toEqual({ text: "ab", caret: 1 });
    expect(deleteLabel(draft, 4, "Backspace")).toEqual({ text: "ab", caret: 1 });
    expect(deleteLabel(draft, 1, "Delete")).toEqual({ text: "ab", caret: 1 });
  });
  it("leaves the keys alone next to it on the other side", () => {
    expect(deleteLabel(draft, 1, "Backspace")).toBeNull();
    expect(deleteLabel(draft, end, "Delete")).toBeNull();
  });
  it("keeps the caret out of it, at the edge it came from", () => {
    expect(caretOutsideLabels(draft.pastes, 3, 1)).toBe(end);
    expect(caretOutsideLabels(draft.pastes, end - 1, end)).toBe(1);
    expect(caretOutsideLabels(draft.pastes, end, 0)).toBe(end);
    expect(caretOutsideLabels(draft.pastes, 0, 5)).toBe(0);
  });
});
