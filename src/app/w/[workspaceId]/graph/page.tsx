import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { GraphView } from "@/components/graph/graph-view";
import { AccessError } from "@/server/access";
import { workspaceGraph } from "@/server/graph";
import { requireWorkspaceSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("graph");
  return { title: t("metaTitle") };
}

/** The workspace graph; `?focus=<page>` opens it on that page and its neighbours (read by GraphView). */
export default async function GraphPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { user } = await requireWorkspaceSession(workspaceId);
  const graph = await workspaceGraph(user.id, workspaceId).catch((error) => {
    if (error instanceof AccessError) return null;
    throw error;
  });
  if (!graph) notFound();
  return <GraphView workspaceId={workspaceId} graph={graph} />;
}
