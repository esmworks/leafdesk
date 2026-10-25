import { describe, expect, it } from "vitest";
import { DICTATION_HOLD_MS, dictationText, isRecordingPhase, pressesDictate, releasesDictate, stepDictation, type DictationInput, type DictationPhase } from "./dictation";
import { DICTATE_COMBO, SHORTCUT_GROUPS } from "./shortcuts";

/** Runs inputs from idle: the phases passed and the effects asked for. */
function run(...inputs: DictationInput[]) {
  let phase: DictationPhase = "idle";
  const effects: string[] = [];
  for (const input of inputs) {
    const step = stepDictation(phase, input);
    phase = step.phase;
    if (step.effect) effects.push(step.effect);
  }
  return { phase, effects };
}

const chord = { type: "chord" } as const;
const listening = { type: "listening" } as const;
const recorded = { type: "recorded" } as const;
const settled = { type: "settled" } as const;
const release = (heldMs: number) => ({ type: "release", heldMs }) as const;

describe("stepDictation", () => {
  it("starts on the chord and writes after pressing it again", () => {
    expect(run(chord)).toEqual({ phase: "starting", effects: ["start"] });
    expect(run(chord, listening)).toEqual({ phase: "listening", effects: ["start"] });
    expect(run(chord, listening, chord)).toEqual({ phase: "stopping", effects: ["start", "stop"] });
    expect(run(chord, listening, chord, recorded)).toEqual({ phase: "writing", effects: ["start", "stop", "send"] });
    expect(run(chord, listening, chord, recorded, settled)).toEqual({ phase: "idle", effects: ["start", "stop", "send"] });
  });

  it("finishes on Enter or the chip", () => {
    expect(run(chord, listening, { type: "finish" }, recorded).effects).toEqual(["start", "stop", "send"]);
  });

  it("finishes when the held chord is let go (push to talk), not after a quick press", () => {
    expect(run(chord, listening, release(DICTATION_HOLD_MS - 1))).toEqual({ phase: "listening", effects: ["start"] });
    expect(run(chord, listening, release(DICTATION_HOLD_MS))).toEqual({ phase: "stopping", effects: ["start", "stop"] });
  });

  it("cancels and writes nothing on Esc, at any point", () => {
    const cancel = { type: "cancel" } as const;
    expect(run(chord, cancel)).toEqual({ phase: "idle", effects: ["start", "discard"] });
    expect(run(chord, listening, cancel)).toEqual({ phase: "idle", effects: ["start", "discard"] });
    expect(run(chord, listening, chord, cancel)).toEqual({ phase: "idle", effects: ["start", "stop", "discard"] });
    expect(run(chord, listening, chord, recorded, cancel)).toEqual({ phase: "idle", effects: ["start", "stop", "send", "abort"] });
    // Audio arriving after a cancel isn't sent.
    expect(run(chord, listening, cancel, recorded)).toEqual({ phase: "idle", effects: ["start", "discard"] });
  });

  it("drops a dictation finished before the microphone was on", () => {
    expect(run(chord, chord)).toEqual({ phase: "idle", effects: ["start", "discard"] });
    expect(run(chord, { type: "finish" })).toEqual({ phase: "idle", effects: ["start", "discard"] });
    expect(run(chord, release(DICTATION_HOLD_MS + 100))).toEqual({ phase: "idle", effects: ["start", "discard"] });
    expect(run(chord, release(50))).toEqual({ phase: "starting", effects: ["start"] });
  });

  it("goes back to idle when the microphone fails or the recorder ends with nothing", () => {
    expect(run(chord, { type: "failed" })).toEqual({ phase: "idle", effects: ["start"] });
    expect(run(chord, listening, chord, { type: "ended" })).toEqual({ phase: "idle", effects: ["start", "stop"] });
  });

  it("writes what the recorder gave when it stopped by itself at the limit", () => {
    expect(run(chord, listening, recorded)).toEqual({ phase: "writing", effects: ["start", "send"] });
  });

  it("ignores the chord while writing, and stray news when idle", () => {
    expect(run(chord, listening, chord, recorded, chord)).toEqual({ phase: "writing", effects: ["start", "stop", "send"] });
    expect(run({ type: "ended" }, recorded, settled, listening, { type: "finish" }, { type: "cancel" })).toEqual({ phase: "idle", effects: [] });
  });

  it("knows which phases hold the microphone", () => {
    expect((["idle", "starting", "listening", "stopping", "writing"] as const).filter(isRecordingPhase)).toEqual(["starting", "listening"]);
  });
});

const key = (init: Partial<KeyboardEvent>) =>
  ({ code: "KeyD", key: "d", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, isComposing: false, defaultPrevented: false, ...init }) as KeyboardEvent;

describe("the dictation shortcut", () => {
  it("is Mod+Shift+D with the system's Mod key, by the key's place", () => {
    expect(pressesDictate(key({ metaKey: true, key: "D" }), true)).toBe(true);
    expect(pressesDictate(key({ ctrlKey: true, key: "D" }), false)).toBe(true);
    // Another layout's character on the same key.
    expect(pressesDictate(key({ ctrlKey: true, key: "Д" }), false)).toBe(true);
    expect(pressesDictate(key({ ctrlKey: true }), true)).toBe(false);
    expect(pressesDictate(key({ metaKey: true }), false)).toBe(false);
    expect(pressesDictate(key({ ctrlKey: true, shiftKey: false }), false)).toBe(false);
    expect(pressesDictate(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(pressesDictate(key({ ctrlKey: true, code: "KeyF" }), false)).toBe(false);
    expect(pressesDictate(key({ ctrlKey: true, isComposing: true }), false)).toBe(false);
    expect(pressesDictate(key({ ctrlKey: true, defaultPrevented: true }), false)).toBe(false);
  });

  it("ends a hold when D or one of its modifiers is let go", () => {
    expect(releasesDictate({ code: "KeyD", key: "d" })).toBe(true);
    expect(releasesDictate({ code: "MetaLeft", key: "Meta" })).toBe(true);
    expect(releasesDictate({ code: "ShiftRight", key: "Shift" })).toBe(true);
    expect(releasesDictate({ code: "ControlLeft", key: "Control" })).toBe(true);
    expect(releasesDictate({ code: "KeyA", key: "a" })).toBe(false);
  });

  it("is listed in the shortcuts dialog and taken by nothing else there", () => {
    const all = SHORTCUT_GROUPS.flatMap((group) => group.shortcuts);
    expect(all.find((shortcut) => shortcut.id === "dictate")?.combos).toEqual([DICTATE_COMBO]);
    const same = all.filter((shortcut) => shortcut.combos.some((combo) => combo.join("+") === DICTATE_COMBO.join("+")));
    expect(same.map((shortcut) => shortcut.id)).toEqual(["dictate"]);
  });
});

describe("dictationText", () => {
  it("writes what was said on one line, trimmed", () => {
    expect(dictationText("", "", "  Call the supplier\nabout the quote  ")).toBe("Call the supplier about the quote");
    expect(dictationText("", "", "   ")).toBe("");
  });

  it("adds a space after a word or the end of a sentence, not after a space", () => {
    expect(dictationText("Next step", "", "call them")).toBe(" call them");
    expect(dictationText("Done.", "", "Next one")).toBe(" Next one");
    expect(dictationText("Next step ", "", "call them")).toBe("call them");
    expect(dictationText("(", "", "aside")).toBe("aside");
    expect(dictationText("Ünlü", "", "şarkı")).toBe(" şarkı");
  });

  it("spaces from a word right after the caret", () => {
    expect(dictationText("", "pages", "budget")).toBe("budget ");
    expect(dictationText("Find ", "pages", "budget")).toBe("budget ");
    expect(dictationText("Find ", " pages", "budget")).toBe("budget");
    expect(dictationText("Find ", ".", "budget")).toBe("budget");
  });

  it("treats a mention as a word", () => {
    expect(dictationText("Ask ￼", "", "about it")).toBe(" about it");
  });

  it("puts no space before punctuation that was said", () => {
    expect(dictationText("Done", "", ", and then more")).toBe(", and then more");
  });

  it("adds no spaces in scripts written without them", () => {
    expect(dictationText("会議の", "", "議事録")).toBe("議事録");
    expect(dictationText("Leafdesk", "", "で作業")).toBe("で作業");
    expect(dictationText("", "ครับ", "สวัสดี")).toBe("สวัสดี");
    expect(dictationText("회의", "", "내용")).toBe(" 내용");
  });
});
