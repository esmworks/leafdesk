import { agentPagePath } from "./agent-page";

/**
 * The sections of an agent's settings page, as its address names them (`?section=`). `settings` is
 * its instructions, `share` who it is shared with (from the page's top bar); `chat` is no section:
 * it opens the agent's own page.
 */
export const AGENT_SECTIONS = ["settings", "skills", "memory", "tools", "access", "connections", "triggers", "schedules", "advanced", "runs", "history", "share"] as const;
export type AgentSection = (typeof AGENT_SECTIONS)[number];
export type AgentTab = AgentSection | "chat";

export const isAgentSection = (value: unknown): value is AgentSection => (AGENT_SECTIONS as readonly unknown[]).includes(value);

/** An agent's settings page, at one of its sections (its instructions without one), with one of its runs opened. */
export function agentSettingsPath(workspaceId: string, agentId: string, section?: AgentSection | null, runId?: string | null): string {
  const query = new URLSearchParams();
  if (section && section !== "settings") query.set("section", section);
  if (runId) query.set("run", runId);
  const search = query.toString();
  return `${agentPagePath(workspaceId, agentId)}/settings${search ? `?${search}` : ""}`;
}
