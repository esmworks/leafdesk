import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SkillLibrary } from "@/components/skills/skill-library";
import { AccessError } from "@/server/access";
import { listSkills } from "@/server/skills";
import { requireWorkspaceSession } from "@/server/session";
import { exportAllowed, topLevelAccess } from "@/server/workspaces";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("skills");
  return { title: t("metaTitle") };
}

/** The workspace's skills library: every skill the person can open. Outsiders get a 404. */
export default async function SkillsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { user } = await requireWorkspaceSession(workspaceId);
  const skills = await listSkills(user.id, workspaceId).catch((error) => {
    if (error instanceof AccessError) return null;
    throw error;
  });
  if (!skills) notFound();
  const [topLevel, exportable] = await Promise.all([topLevelAccess(user.id, workspaceId), exportAllowed(workspaceId)]);
  return <SkillLibrary workspaceId={workspaceId} skills={skills} canCreate={topLevel !== null} exportable={exportable} now={new Date()} />;
}
