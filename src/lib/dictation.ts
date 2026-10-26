// Client-safe: dictating into a page at the caret (components/page/dictation.tsx), its pure parts.

/**
 * Where a dictation is. "starting": waiting for the microphone (the browser may be asking for it);
 * "listening": recording; "stopping": the recorder is handing over the audio; "writing": the
 * server is writing down what was said.
 */
export type DictationPhase = "idle" | "starting" | "listening" | "stopping" | "writing";

/**
 * What happens to a dictation. "chord": Mod+Shift+D pressed (not a key repeat); "release": that
 * press let go, after `heldMs`; "finish": Enter or the chip; "cancel": Esc, the editor losing
 * focus, the page closing, another dictation; "listening": the microphone is on; "recorded": the
 * recorder gave its audio (after a stop, or by itself at the length or size limit); "ended": the
 * recorder stopped with nothing to give; "failed": the microphone couldn't start; "settled": the
 * text was written, or writing it down failed.
 */
export type DictationInput =
  | { type: "chord" }
  | { type: "release"; heldMs: number }
  | { type: "finish" }
  | { type: "cancel" }
  | { type: "listening" }
  | { type: "recorded" }
  | { type: "ended" }
  | { type: "failed" }
  | { type: "settled" };

/**
 * What to do on the way: "start" the recorder, "stop" it (keeping the audio), "discard" the
 * recording, "send" the audio to be written down, "abort" waiting for the server.
 */
export type DictationEffect = "start" | "stop" | "discard" | "send" | "abort";

/** Holding the chord at least this long and letting go finishes (push to talk). */
export const DICTATION_HOLD_MS = 400;

/** Whether a phase takes the microphone (so focus leaving or another dictation cancels it). */
export const isRecordingPhase = (phase: DictationPhase) => phase === "starting" || phase === "listening";

/** The next phase, and what to do. An input that means nothing in a phase changes nothing. */
export function stepDictation(phase: DictationPhase, input: DictationInput): { phase: DictationPhase; effect: DictationEffect | null } {
  const stay = { phase, effect: null };
  const held = input.type === "release" && input.heldMs >= DICTATION_HOLD_MS;
  switch (phase) {
    case "idle":
      return input.type === "chord" ? { phase: "starting", effect: "start" } : stay;
    case "starting":
      // Nothing was heard yet: finishing now is the same as cancelling.
      if (input.type === "listening") return { phase: "listening", effect: null };
      if (input.type === "failed") return { phase: "idle", effect: null };
      if (input.type === "chord" || input.type === "finish" || input.type === "cancel" || held) return { phase: "idle", effect: "discard" };
      return stay;
    case "listening":
      if (input.type === "chord" || input.type === "finish" || held) return { phase: "stopping", effect: "stop" };
      if (input.type === "recorded") return { phase: "writing", effect: "send" };
      if (input.type === "cancel") return { phase: "idle", effect: "discard" };
      if (input.type === "ended") return { phase: "idle", effect: null };
      return stay;
    case "stopping":
      if (input.type === "recorded") return { phase: "writing", effect: "send" };
      if (input.type === "cancel") return { phase: "idle", effect: "discard" };
      if (input.type === "ended") return { phase: "idle", effect: null };
      return stay;
    case "writing":
      if (input.type === "cancel") return { phase: "idle", effect: "abort" };
      if (input.type === "settled") return { phase: "idle", effect: null };
      return stay;
  }
}

type KeyLike = Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented">;

/**
 * Whether a key press is Mod+Shift+D (lib/shortcuts DICTATE_COMBO), matched by the key's place so
 * other layouts and Shift don't change it.
 */
export function pressesDictate(e: KeyLike, mac: boolean): boolean {
  if (e.defaultPrevented || e.isComposing || e.altKey || !e.shiftKey || e.code !== "KeyD") return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Whether a key let go ends holding the chord: D, or one of its modifiers (a Mac sends no keyup for
 * a letter while ⌘ is down).
 */
export const releasesDictate = (e: Pick<KeyboardEvent, "code" | "key">) =>
  e.code === "KeyD" || e.key === "Shift" || e.key === "Meta" || e.key === "Control";

/** Letters, digits and what stands for an inline mention or chip (U+FFFC): words a space separates. */
const WORD = /[\p{L}\p{N}\p{M}_￼]/u;
/** Punctuation that ends a word or sentence: a word after it is spaced. */
const CLOSING = /[.,;:!?)\]}%…»”’]/u;
/** Punctuation that leans on the word before it: no space before it. */
const LEANING = /^[.,;:!?)\]}%…»”’]/u;
/** Scripts written without spaces between words. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}　-〿＀-￯]/u;

/**
 * The text to put in for what was said, between `before` and `after` (the text around the caret in
 * its block): on one line, spaced from a word or sentence before it and a word after it, unless
 * either side is a script written without spaces. Empty when nothing was said.
 */
export function dictationText(before: string, after: string, said: string): string {
  const words = said.replace(/\s+/g, " ").trim();
  if (!words) return "";
  const last = Array.from(before).at(-1) ?? "";
  const next = Array.from(after)[0] ?? "";
  const first = Array.from(words)[0];
  const final = Array.from(words).at(-1) ?? "";
  const lead = last && (WORD.test(last) || CLOSING.test(last)) && !LEANING.test(words) && !(UNSPACED.test(last) || UNSPACED.test(first)) ? " " : "";
  const trail = next && WORD.test(next) && !(UNSPACED.test(next) || UNSPACED.test(final)) ? " " : "";
  return lead + words + trail;
}
