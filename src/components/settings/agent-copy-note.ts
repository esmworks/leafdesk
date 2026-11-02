import type { CopyLeftOut } from "@/lib/agents";

/** What a copy just made took from the agent it copies and left out, said once on its page. */
export type CopyNote = { from: string; leftOut: CopyLeftOut };

const key = (agentId: string) => `leafdesk:agent-copy:${agentId}`;

/** Kept for the copy's page, which the list goes to next (agent-editor.tsx). */
export function rememberCopy(agentId: string, note: CopyNote) {
  try {
    sessionStorage.setItem(key(agentId), JSON.stringify(note));
  } catch {
    // Without storage the page just doesn't say it.
  }
}

/** The note kept for the agent's page, taken once. */
export function takeCopy(agentId: string): CopyNote | null {
  try {
    const stored = sessionStorage.getItem(key(agentId));
    if (!stored) return null;
    sessionStorage.removeItem(key(agentId));
    return JSON.parse(stored) as CopyNote;
  } catch {
    return null;
  }
}
