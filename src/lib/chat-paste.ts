// Client-safe: the AI chat's box (src/components/ai-chat) shows a long paste as a label, and the
// question it sends has the pasted text in the label's place.

/** A long paste: its label stands in the box's text at `start..end`; `text` is what is sent. */
export type PastePart = { label: string; text: string; start: number; end: number };

/** What the chat's box holds: the text as shown, and the pastes its labels stand for. */
export type ChatDraft = { text: string; pastes: PastePart[] };

export const EMPTY_DRAFT: ChatDraft = { text: "", pastes: [] };

/** Lines of a text; a line break at its end doesn't start another one. */
export function pasteLineCount(text: string): number {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return (body.match(/\n/g)?.length ?? 0) + 1;
}

/** A paste of 3 lines or more, or of more than 150 characters, becomes a label; a shorter one is typed in. */
export function shouldCollapsePaste(text: string): boolean {
  const trimmed = text.trim();
  return pasteLineCount(trimmed) >= 3 || trimmed.length > 150;
}

/** One kind of line break, so that offsets in the text hold. */
export function normalizePaste(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/**
 * A label no other paste in the box has ("[Pasted 3 lines #2]"): two pastes of the same size under
 * one label would be told apart only by their order, and deleting the first would send the second
 * with the first one's text. Its spaces don't break, so the box never wraps a label's chip.
 */
export function uniqueLabel(pastes: readonly PastePart[], text: string): string {
  const label = text.replace(/ /g, "\u00a0");
  const taken = new Set(pastes.map((p) => p.label));
  if (!taken.has(label)) return label;
  const numbered = (n: number) => (label.endsWith("]") ? `${label.slice(0, -1)}\u00a0#${n}]` : `${label}\u00a0#${n}`);
  let n = 2;
  while (taken.has(numbered(n))) n += 1;
  return numbered(n);
}

/**
 * Puts a paste's label in place of `start..end` (the selection), moving the pastes after it. A
 * paste the selection covers goes, with its label.
 */
export function insertPaste(draft: ChatDraft, text: string, label: string, start: number, end: number): ChatDraft {
  const from = Math.max(0, Math.min(start, draft.text.length));
  const to = Math.max(from, Math.min(end, draft.text.length));
  const shift = label.length - (to - from);
  const pastes: PastePart[] = [];
  for (const part of draft.pastes) {
    if (part.end <= from) pastes.push(part);
    else if (part.start >= to) pastes.push({ ...part, start: part.start + shift, end: part.end + shift });
  }
  pastes.push({ label, text, start: from, end: from + label.length });
  pastes.sort((a, b) => a.start - b.start);
  return { text: draft.text.slice(0, from) + label + draft.text.slice(to), pastes };
}

/**
 * The box's text after the person edited it: each paste finds its label again, left to right; a
 * paste whose label was deleted or broken goes.
 */
export function syncDraft(draft: ChatDraft, text: string): ChatDraft {
  if (!draft.pastes.length) return draft.text === text ? draft : { text, pastes: [] };
  const pastes: PastePart[] = [];
  let cursor = 0;
  for (const part of draft.pastes) {
    const at = text.indexOf(part.label, cursor);
    if (at === -1) continue;
    pastes.push({ ...part, start: at, end: at + part.label.length });
    cursor = at + part.label.length;
  }
  return { text, pastes };
}

/**
 * A label is one piece: Backspace just after it (or inside it) and Delete just before it take the
 * whole label. The text left and where the caret goes, or null when the key deletes as usual.
 */
export function deleteLabel(draft: ChatDraft, caret: number, key: "Backspace" | "Delete"): { text: string; caret: number } | null {
  const part = draft.pastes.find((p) => (key === "Backspace" ? p.start < caret && caret <= p.end : p.start <= caret && caret < p.end));
  if (!part) return null;
  return { text: draft.text.slice(0, part.start) + draft.text.slice(part.end), caret: part.start };
}

/**
 * The caret never stands inside a label: coming from its end (or after) it moves to the label's
 * start, otherwise to its end. `caret` itself when it isn't inside one.
 */
export function caretOutsideLabels(pastes: readonly PastePart[], caret: number, previous: number): number {
  const part = pastes.find((p) => p.start < caret && caret < p.end);
  if (!part) return caret;
  return previous >= part.end ? part.start : part.end;
}

/** The question to send: each label replaced by its paste, from the end so offsets hold. */
export function expandDraft(draft: ChatDraft): string {
  let text = draft.text;
  for (const part of [...draft.pastes].sort((a, b) => b.start - a.start)) {
    const at = text.slice(part.start, part.end) === part.label ? part.start : text.indexOf(part.label);
    if (at === -1) continue;
    text = text.slice(0, at) + part.text + text.slice(at + part.label.length);
  }
  return text;
}
