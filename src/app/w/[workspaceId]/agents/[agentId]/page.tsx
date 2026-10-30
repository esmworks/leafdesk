import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AgentPage } from "@/components/agent-chat/agent-page";
import { AccessError } from "@/server/access";
import { getAgent } from "@/server/agents/manage";
import { listAgentSchedules } from "@/server/agents/schedules";
import { requireWorkspaceSession } from "@/server/session";

type Params = { params: Promise<{ workspaceId: string; agentId: string }> };
type Props = Params & { searchParams: Promise<{ run?: string | string[] }> };

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
 * An agent's own page, for anyone it is shared with (can interact): a chat with it. Others get a
 * 404. `?run=` brings one of the runs in it into view (a scheduled run's report, from the inbox).
 * Its schedules show beside the chat on a wide page; a page without them still opens.
 */
export default async function AgentRoute({ params, searchParams }: Props) {
  const [{ workspaceId, agentId }, { run }] = await Promise.all([params, searchParams]);
  const found = await findAgent(workspaceId, agentId);
  if (!found) notFound();
  const { agent, userId } = found;
  const schedules = await listAgentSchedules(userId, agent.id).catch(() => []);
  return (
    <AgentPage
      workspaceId={workspaceId}
      agent={{ id: agent.id, name: agent.name, icon: agent.icon, description: agent.description }}
      schedules={schedules}
      focusRun={typeof run === "string" ? run : null}
    />
  );
}
