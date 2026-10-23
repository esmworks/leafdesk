import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MeetingsList } from "@/components/meetings/meetings-list";
import { AccessError } from "@/server/access";
import { listMeetings } from "@/server/meetings";
import { requireWorkspaceSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meetings");
  return { title: t("metaTitle") };
}

/** The workspace's meeting notes the person can see (server/meetings.ts listMeetings). */
export default async function MeetingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { user } = await requireWorkspaceSession(workspaceId);
  const meetings = await listMeetings(user.id, workspaceId).catch((error) => {
    if (error instanceof AccessError) return null;
    throw error;
  });
  if (!meetings) notFound();
  return <MeetingsList workspaceId={workspaceId} meetings={meetings} now={new Date()} />;
}
