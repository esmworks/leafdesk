import { requireMember } from "@/server/access";
import { aiInfoFor } from "@/server/ai";
import { canCreateAgents } from "@/server/agents/sharing";
import { webSearchService } from "@/server/agents/web";
import { getWorkspaceSettings } from "@/server/workspaces";

/** What making an agent needs to know, for Settings > Agents and the sidebar's New agent alike. */
export type AgentCreationInfo = {
  /** An owner, or a member when the workspace lets members create agents. */
  canCreate: boolean;
  /** Owners set an agent's monthly token limit (AgentForm). */
  isOwner: boolean;
  /** Whether agents can run: AI set up on the server and on in the workspace. */
  ai: "on" | "off" | "unavailable";
  /** The server's main and fast models, when an agent may choose between them; null otherwise. */
  models: { main: string; fast: string } | null;
  /** The server has a search service: agents with web access can search the web too. */
  webSearch: boolean;
};

export async function agentCreationInfo(userId: string, workspaceId: string): Promise<AgentCreationInfo> {
  const [membership, settings, canCreate, info] = await Promise.all([
    requireMember(userId, workspaceId),
    getWorkspaceSettings(userId, workspaceId),
    canCreateAgents(userId, workspaceId),
    aiInfoFor(workspaceId),
  ]);
  return {
    canCreate,
    isOwner: membership.role === "owner",
    ai: !info ? "unavailable" : settings.ai === false ? "off" : "on",
    // Agents choose a model only where it makes a difference: the server has a fast model, and the
    // workspace's AI isn't an own AI account (which has one model).
    models: info?.fastModel ? { main: info.model, fast: info.fastModel } : null,
    webSearch: webSearchService() !== null,
  };
}
