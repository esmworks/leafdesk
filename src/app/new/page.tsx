import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { NewPageStarter } from "@/components/share/new-page-starter";
import { lastViewedPage } from "@/server/page-views";
import { listWorkspaces } from "@/server/pages";
import { requireUser } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page.newPageRoute");
  return { title: t("documentTitle"), robots: { index: false } };
}

/**
 * `/new`: a new private page, opened at once, in the workspace asked for (`?workspace=`), else the
 * one the person was in last. Typed into the address bar or bookmarked. The page is made by the
 * starter's server action rather than by this request, so a link elsewhere can't make pages.
 */
export default async function NewPageRoute({ searchParams }: { searchParams: Promise<{ workspace?: string | string[] }> }) {
  const [user, query] = await Promise.all([requireUser(), searchParams]);
  const workspaces = await listWorkspaces(user.id);
  if (!workspaces.length) redirect("/");
  const asked = typeof query.workspace === "string" ? query.workspace : null;
  const last = asked ? null : await lastViewedPage(user.id);
  const chosen = workspaces.find((w) => w.id === asked) ?? workspaces.find((w) => w.id === last?.workspaceId) ?? workspaces[0];
  return <NewPageStarter workspaceId={chosen.id} />;
}
