import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { ChatPage } from "@/components/ai-chat/chat-page";
import { aiEnabledFor } from "@/server/ai";
import { memoryAvailable } from "@/server/ai-memory";
import { aiAvailable } from "@/server/ai-writing";
import { requireWorkspaceSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ai.chat");
  return { title: t("title") };
}

/** The full-page AI chat (`?c=` names the conversation). Not there when the workspace has no AI provider. */
export default async function AiChatRoute({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  await requireWorkspaceSession(workspaceId);
  if (!(await aiEnabledFor(workspaceId))) notFound();
  const [available, memory] = await Promise.all([aiAvailable(workspaceId), memoryAvailable(workspaceId)]);
  return (
    <Suspense>
      <ChatPage workspaceId={workspaceId} available={available} memory={available && memory} />
    </Suspense>
  );
}
