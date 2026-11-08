import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MessagesApp } from "@/components/messages/messages-app";
import { MessageError, workspaceRole } from "@/server/messages/core";
import { requireWorkspaceSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("messages");
  return { title: t("title") };
}

/** Team messages (server/messages): the page reads everything through its websocket, so the server only checks who asks. */
export default async function MessagesPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { user } = await requireWorkspaceSession(workspaceId);
  const role = await workspaceRole(user.id, workspaceId).catch((error) => {
    if (error instanceof MessageError) notFound();
    throw error;
  });
  return <MessagesApp workspaceId={workspaceId} owner={role === "owner"} />;
}
