import { describe, expect, it } from "vitest";
import texts from "@/i18n/messages/en/shortcuts.json";
import { comboText, keyLabels, opensPresentation, opensShortcuts, opensToggleAll, rowMenuShortcut, SHORTCUT_GROUPS } from "./shortcuts";
import { SUBSCRIPT, SUPERSCRIPT, TEXT_SCRIPT_SHORTCUTS } from "./text-scripts";

const press = (key: string, init: Partial<KeyboardEvent> = {}, target: unknown = null) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, target, ...init }) as never;

/** Enough of an element for the editable check. */
const element = (editable: boolean) => ({ isContentEditable: false, closest: () => (editable ? {} : null) });

describe("keyboard shortcut labels", () => {
  it("show symbols on a Mac and names elsewhere", () => {
    expect(keyLabels(["Mod", "Shift", "Z"], true)).toEqual(["⌘", "⇧", "Z"]);
    expect(keyLabels(["Mod", "Shift", "Z"], false)).toEqual(["Ctrl", "Shift", "Z"]);
    expect(keyLabels(["Mod", "Alt", "1"], true)).toEqual(["⌘", "⌥", "1"]);
    expect(keyLabels(["Mod", "Alt", "1"], false)).toEqual(["Ctrl", "Alt", "1"]);
  });

  it("draw arrows, keep named keys and capitalize letters", () => {
    expect(keyLabels(["Alt", "ArrowLeft"], false)).toEqual(["Alt", "←"]);
    expect(keyLabels(["Mod", "Shift", "ArrowUp"], true)).toEqual(["⌘", "⇧", "↑"]);
    expect(keyLabels(["Shift", "Tab"], true)).toEqual(["⇧", "Tab"]);
    expect(keyLabels(["Mod", "k"], false)).toEqual(["Ctrl", "K"]);
    expect(keyLabels(["?"], true)).toEqual(["?"]);
  });

  it("join into one string the way each system writes it", () => {
    expect(comboText(["Mod", "/"], true)).toBe("⌘/");
    expect(comboText(["Mod", "/"], false)).toBe("Ctrl+/");
  });
});

describe("the shortcut list", () => {
  it("has a text for every shortcut and group, and lists every text once", () => {
    const ids = SHORTCUT_GROUPS.flatMap((group) => group.shortcuts.map((shortcut) => shortcut.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(texts.items).sort());
    expect(SHORTCUT_GROUPS.map((group) => group.id).sort()).toEqual(Object.keys(texts.groups).sort());
  });

  it("names the keys superscript and subscript are bound to", () => {
    const combo = (id: string) => SHORTCUT_GROUPS.flatMap((group) => group.shortcuts).find((shortcut) => shortcut.id === id)?.combos[0].join("-");
    expect(combo("superscript")).toBe(TEXT_SCRIPT_SHORTCUTS[SUPERSCRIPT]);
    expect(combo("subscript")).toBe(TEXT_SCRIPT_SHORTCUTS[SUBSCRIPT]);
  });
});

describe("opensShortcuts", () => {
  it("opens on Mod+/ with the system's Mod key", () => {
    expect(opensShortcuts(press("/", { metaKey: true }), true)).toBe(true);
    expect(opensShortcuts(press("/", { ctrlKey: true }), false)).toBe(true);
    expect(opensShortcuts(press("/", { ctrlKey: true }), true)).toBe(false);
    expect(opensShortcuts(press("/", { metaKey: true }), false)).toBe(false);
    expect(opensShortcuts(press("/"), false)).toBe(false);
    expect(opensShortcuts(press("/", { ctrlKey: true, altKey: true }), false)).toBe(false);
  });

  it("opens on ? only outside text fields and the editor", () => {
    expect(opensShortcuts(press("?", { shiftKey: true }, element(false)), false)).toBe(true);
    expect(opensShortcuts(press("?", { shiftKey: true }, element(true)), false)).toBe(false);
    expect(opensShortcuts(press("?", { shiftKey: true, metaKey: true }, element(false)), true)).toBe(false);
  });

  it("leaves keys something else handled, and text being composed", () => {
    expect(opensShortcuts(press("/", { metaKey: true, defaultPrevented: true }), true)).toBe(false);
    expect(opensShortcuts(press("?", { isComposing: true }, element(false)), false)).toBe(false);
  });
});

describe("opensPresentation", () => {
  it("opens on Mod+Alt+P with the system's Mod key, whatever character the keys type", () => {
    expect(opensPresentation(press("π", { code: "KeyP", metaKey: true, altKey: true }), true)).toBe(true);
    expect(opensPresentation(press("p", { code: "KeyP", ctrlKey: true, altKey: true }), false)).toBe(true);
    expect(opensPresentation(press("p", { code: "KeyP", ctrlKey: true, altKey: true }), true)).toBe(false);
    expect(opensPresentation(press("π", { code: "KeyP", metaKey: true, altKey: true }), false)).toBe(false);
  });

  it("needs all of Mod, Alt and P, and nothing more", () => {
    expect(opensPresentation(press("p", { code: "KeyP", metaKey: true }), true)).toBe(false);
    expect(opensPresentation(press("π", { code: "KeyP", altKey: true }), true)).toBe(false);
    expect(opensPresentation(press("P", { code: "KeyP", metaKey: true, altKey: true, shiftKey: true }), true)).toBe(false);
    expect(opensPresentation(press("o", { code: "KeyO", metaKey: true, altKey: true }), true)).toBe(false);
    expect(opensPresentation(press("p", { code: "KeyP", metaKey: true, ctrlKey: true, altKey: true }), true)).toBe(false);
  });

  it("leaves keys something else handled, and text being composed", () => {
    expect(opensPresentation(press("π", { code: "KeyP", metaKey: true, altKey: true, defaultPrevented: true }), true)).toBe(false);
    expect(opensPresentation(press("π", { code: "KeyP", metaKey: true, altKey: true, isComposing: true }), true)).toBe(false);
  });
});

describe("rowMenuShortcut", () => {
  it("duplicates, moves and comments with the system's Mod key, by the key's place", () => {
    expect(rowMenuShortcut(press("d", { code: "KeyD", metaKey: true }), true)).toBe("duplicate");
    expect(rowMenuShortcut(press("d", { code: "KeyD", ctrlKey: true }), false)).toBe("duplicate");
    expect(rowMenuShortcut(press("P", { code: "KeyP", metaKey: true, shiftKey: true }), true)).toBe("moveTo");
    expect(rowMenuShortcut(press("M", { code: "KeyM", ctrlKey: true, shiftKey: true }), false)).toBe("comment");
    expect(rowMenuShortcut(press("d", { code: "KeyD", ctrlKey: true }), true)).toBe(null);
    expect(rowMenuShortcut(press("D", { code: "KeyD", metaKey: true, shiftKey: true }), true)).toBe(null);
    expect(rowMenuShortcut(press("p", { code: "KeyP", metaKey: true }), true)).toBe(null);
    expect(rowMenuShortcut(press("d", { code: "KeyD" }), true)).toBe(null);
  });

  it("moves to the trash on Del, except while a field has text to delete", () => {
    expect(rowMenuShortcut(press("Delete", {}, element(false)), true)).toBe("trash");
    expect(rowMenuShortcut(press("Delete", {}, { ...element(true), value: "" }), true)).toBe("trash");
    expect(rowMenuShortcut(press("Delete", {}, { ...element(true), value: "kop" }), true)).toBe(null);
    expect(rowMenuShortcut(press("Backspace", {}, element(false)), true)).toBe(null);
  });

  it("leaves keys something else handled, and text being composed", () => {
    expect(rowMenuShortcut(press("d", { code: "KeyD", metaKey: true, defaultPrevented: true }), true)).toBe(null);
    expect(rowMenuShortcut(press("d", { code: "KeyD", metaKey: true, isComposing: true }), true)).toBe(null);
  });
});

describe("opensToggleAll", () => {
  it("answers Mod+Alt+T by the key's place, whatever character Option makes", () => {
    expect(opensToggleAll(press("†", { code: "KeyT", metaKey: true, altKey: true } as never), true)).toBe(true);
    expect(opensToggleAll(press("t", { code: "KeyT", ctrlKey: true, altKey: true } as never), false)).toBe(true);
    expect(opensToggleAll(press("t", { code: "KeyT", ctrlKey: true, altKey: true } as never), true)).toBe(false);
    expect(opensToggleAll(press("T", { code: "KeyT", metaKey: true, altKey: true, shiftKey: true } as never), true)).toBe(false);
    expect(opensToggleAll(press("t", { code: "KeyT", metaKey: true } as never), true)).toBe(false);
    expect(opensToggleAll(press("t", { code: "KeyT", metaKey: true, altKey: true, defaultPrevented: true } as never), true)).toBe(false);
  });

  it("lists strikethrough's second key and copying a block's link", () => {
    const combos = (id: string) => SHORTCUT_GROUPS.flatMap((group) => group.shortcuts).find((shortcut) => shortcut.id === id)?.combos.map((c) => c.join("-"));
    expect(combos("strike")).toEqual(["Mod-Shift-S", "Mod-Shift-X"]);
    expect(combos("copyBlockLink")).toEqual(["Alt-Shift-L"]);
    expect(combos("toggleAll")).toEqual(["Mod-Alt-T"]);
  });
});
