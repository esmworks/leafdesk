import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AgentEditor } from "@/components/settings/agent-editor";
import { agentPagePath } from "@/lib/agent-page";
import { AccessError } from "@/server/access";
import { aiInfoFor } from "@/server/ai";
import { getAgent } from "@/server/agents/manage";
import { proposedNoteCounts } from "@/server/agents/memory";
import { webSearchService } from "@/server/agents/web";
import { requireWorkspaceSession } from "@/server/session";
import { getWorkspace, getWorkspaceSettings } from "@/server/workspaces";

type Params = { params: Promise<{ workspaceId: string; agentId: string }> };
type Props = Params & { searchParams: Promise<{ section?: string | string[] }> };

async function findAgent(workspaceId: string, agentId: string) {
  const { user } = await requireWorkspaceSession(workspaceId);
  const agent = await getAgent(user.id, agentId).catch((error) => {
    if (error instanceof AccessError) return null;
    throw error;
  });
  return agent && agent.workspaceId === workspaceId ? { agent, userId: user.id } : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { workspaceId, agentId } = await params;
  const found = await findAgent(workspaceId, agentId);
  return found ? { title: found.agent.name } : {};
}

/**
 * An agent's settings, for anyone it is shared with: what it is told, what it may open and use,
 * what starts it, its runs and versions, one section at a time (`?section=`, its instructions
 * without one). What they may change follows their level on it. `?run=` opens one of its runs.
 */
export default async function AgentSettingsRoute({ params, searchParams }: Props) {
  const [{ workspaceId, agentId }, query] = await Promise.all([params, searchParams]);
  if (query.section === "chat") redirect(agentPagePath(workspaceId, agentId));
  const found = await findAgent(workspaceId, agentId);
  if (!found) notFound();
  const { agent, userId } = found;
  const [workspace, settings, proposals, info] = await Promise.all([
    getWorkspace(userId, workspaceId),
    getWorkspaceSettings(userId, workspaceId),
    proposedNoteCounts(userId, workspaceId),
    aiInfoFor(workspaceId),
  ]);
  return (
    <AgentEditor
      workspaceId={workspaceId}
      isOwner={workspace.role === "owner"}
      agent={agent}
      proposals={proposals[agent.id] ?? 0}
      memoryOff={settings.aiMemory === false}
      // Agents choose a model only where it makes a difference (see the Agents tab in Settings).
      models={info?.fastModel ? { main: info.model, fast: info.fastModel } : null}
      webSearch={webSearchService() !== null}
    />
  );
}
