import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CalendarPage } from "@/components/calendar/calendar-page";
import { requireWorkspaceSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("calendar");
  return { title: t("metaTitle") };
}

/** The person's week across the workspace (server/calendar.ts), read by the page itself as it moves between weeks. */
export default async function CalendarRoute({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  await requireWorkspaceSession(workspaceId);
  return <CalendarPage workspaceId={workspaceId} />;
}
