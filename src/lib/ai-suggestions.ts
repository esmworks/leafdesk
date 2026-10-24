/**
 * Whether the AI's changes to page bodies go in as suggested edits (lib/suggestions) for the person
 * to accept or reject: one choice per person, kept in their browser, for the AI chat and the
 * editor's writing assistant alike. Off by default and wherever storage isn't available.
 */
const KEY = "leafdesk.aiAsSuggestions";

export function aiAsSuggestions(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setAiAsSuggestions(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
}
