import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MemoryPage } from "@/components/ai-chat/memory-page";
import { accountNotes } from "@/server/account-memory";
import { aiEnabledFor } from "@/server/ai";
import { memoryState, memoryUse } from "@/server/ai-memory";
import { requireWorkspaceSession } from "@/server/session";
import { memoryPlaces } from "@/server/shared-memory";
import { getWorkspace } from "@/server/workspaces";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ai.memory");
  return { title: t("title") };
}

/**
 * What the AI keeps for its answers, one part at a time (`?section=`): the person's notes in this
 * workspace and everywhere, the workspace's and those of each teamspace they are in. Only the
 * person's notes everywhere while the workspace has the memory off. Not there without an AI provider.
 */
export default async function MemoryRoute({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { user } = await requireWorkspaceSession(workspaceId);
  if (!(await aiEnabledFor(workspaceId))) notFound();
  const [state, use, account, workspace] = await Promise.all([
    memoryState(user.id, workspaceId),
    memoryUse(user.id, workspaceId),
    accountNotes(user.id),
    getWorkspace(user.id, workspaceId),
  ]);
  const off = state.off === "workspace";
  const places = off ? { workspace: null, teamspaces: [] } : await memoryPlaces(user.id, workspaceId);
  return (
    <MemoryPage
      workspaceId={workspaceId}
      workspaceName={workspace.name}
      off={off}
      use={use}
      mine={state.notes}
      account={account}
      workspace={places.workspace}
      teamspaces={places.teamspaces}
    />
  );
}
