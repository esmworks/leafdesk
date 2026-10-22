import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ReviewQueue } from "@/components/review/review-queue";
import { AccessError } from "@/server/access";
import { listPendingChanges, pendingFacets } from "@/server/pending-changes";
import { requireWorkspaceSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("review");
  return { title: t("metaTitle") };
}

const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : null);

/** The workspace's "For review" queue: what agents proposed that the person may see. Outsiders get a 404. */
export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const { user } = await requireWorkspaceSession(workspaceId);
  const filter = { agentId: one(query.agent), databaseId: one(query.database), rowId: one(query.row) };
  const status = query.status === "decided" ? "decided" : "open";
  const loaded = await Promise.all([listPendingChanges(user.id, workspaceId, { filter, status }), pendingFacets(user.id, workspaceId)]).catch((error) => {
    if (error instanceof AccessError) return null;
    throw error;
  });
  if (!loaded) notFound();
  const [changes, facets] = loaded;
  return (
    <ReviewQueue
      workspaceId={workspaceId}
      initial={{ changes, facets }}
      filter={filter}
      status={status}
      now={new Date().toISOString()}
    />
  );
}
