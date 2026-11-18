/**
 * Whether the AI chat's box has "Plan first" on (server/ai-chat-plan.ts): one choice per person,
 * kept in their browser. Off by default and wherever storage isn't available.
 */
const KEY = "leafdesk.aiChat.planFirst";

export function aiPlanFirst(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setAiPlanFirst(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
}
