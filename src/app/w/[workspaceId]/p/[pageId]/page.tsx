import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DatabasePage } from "@/components/database/database-page";
import { RowProperties } from "@/components/database/row-properties";
import { NoAccess } from "@/components/page/no-access";
import { PageView } from "@/components/page/page-view";
import { pageLabel } from "@/lib/labels";
import { parsePageBackground } from "@/lib/page-background";
import { pageStyleFromYdoc } from "@/lib/page-style";
import { AccessError, WorkspacePolicyError } from "@/server/access";
import { accessRequestsOffered } from "@/server/access-requests";
import { getPageHeaderInfo } from "@/server/page-meta";
import { getBreadcrumbs, getPage, openViewName } from "@/server/pages";
import { policyGatePath, requireUser, requireWorkspaceSession } from "@/server/session";

type Params = { params: Promise<{ workspaceId: string; pageId: string }> };

/** The page, or null when it doesn't exist or the user may not see it (the two look the same). */
async function load(userId: string, pageId: string) {
  try {
    return await getPage(userId, pageId);
  } catch (error) {
    if (error instanceof WorkspacePolicyError) redirect(policyGatePath(error.workspaceId, error.hold));
    if (error instanceof AccessError) return null;
    throw error;
  }
}

export async function generateMetadata({
  params,
  searchParams,
}: Params & { searchParams: Promise<{ view?: string | string[] }> }): Promise<Metadata> {
  const user = await requireUser();
  const { pageId } = await params;
  const [p, t] = await Promise.all([load(user.id, pageId), getTranslations()]);
  if (!p) return { title: t("page.noAccess.metaTitle") };
  await requireWorkspaceSession(p.workspaceId);
  const title = pageLabel(p.title, t("common.untitled"));
  // Same as the tab title the page keeps (components/page/page-view.tsx), so a refresh doesn't
  // drop the view from it.
  const { view } = await searchParams;
  const viewName = p.kind === "database" ? await openViewName(p.id, typeof view === "string" ? view : null) : null;
  return { title: viewName ? { absolute: t("page.documentViewTitle", { title, view: viewName }) } : title };
}

export default async function PageRoute({ params }: Params) {
  const user = await requireUser();
  const { workspaceId, pageId } = await params;
  const p = await load(user.id, pageId);
  if (!p) {
    // Decided by the workspace in the address, never by the page, so a page that doesn't exist
    // gets the same screen as one the user can't see.
    const canRequest = await accessRequestsOffered(workspaceId);
    return <NoAccess key={pageId} pageId={pageId} email={user.email} canRequest={canRequest} />;
  }
  await requireWorkspaceSession(p.workspaceId);
  if (p.workspaceId !== workspaceId) redirect(`/w/${p.workspaceId}/p/${p.id}`);

  const [crumbs, info] = await Promise.all([getBreadcrumbs(user.id, pageId), getPageHeaderInfo(user.id, pageId)]);
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  const isRow = parent?.kind === "database";
  const archived = Boolean(p.archivedAt);
  // Viewers see the database and row values but can't change them; the server refuses it too.
  const canEdit = info.level === "edit" || info.level === "full";

  return (
    <PageView
      key={p.id}
      workspaceId={workspaceId}
      page={{ id: p.id, parentId: p.parentId, title: p.title, icon: p.icon, background: parsePageBackground(p.background), kind: p.kind, archived, isRow }}
      info={info}
      crumbs={crumbs}
      user={{ id: user.id, name: user.name }}
      showBody={p.kind !== "database"}
      wide={p.kind === "database"}
      style={p.kind === "database" ? undefined : pageStyleFromYdoc(p.ydoc)}
    >
      {p.kind === "database" ? (
        <DatabasePage workspaceId={workspaceId} databaseId={p.id} canEdit={canEdit && !archived} guest={info.guest} exportable={info.exportable} />
      ) : isRow ? (
        <RowProperties workspaceId={workspaceId} databaseId={parent.id} rowId={p.id} readOnly={archived || !canEdit} />
      ) : null}
    </PageView>
  );
}
