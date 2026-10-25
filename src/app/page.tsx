import { redirect } from "next/navigation";
import { getOpenOnStart } from "@/server/open-on-start";
import { lastViewedPage } from "@/server/page-views";
import { listWorkspaces } from "@/server/pages";
import { requireUser } from "@/server/session";
import { createPersonalWorkspace } from "@/server/workspaces";

export default async function Home() {
  const user = await requireUser();
  // Those who start on the page they opened last go straight there (lib/open-on-start.ts).
  if ((await getOpenOnStart(user.id)) === "last_page") {
    const last = await lastViewedPage(user.id);
    if (last) redirect(`/w/${last.workspaceId}/p/${last.id}`);
  }
  let [first] = await listWorkspaces(user.id);
  if (!first) {
    // Left or removed from every workspace: give them a new personal one, as on sign-up, rather
    // than sending them to sign-in (which would send them straight back here).
    await createPersonalWorkspace(user.id, user.name);
    [first] = await listWorkspaces(user.id);
  }
  redirect(`/w/${first.id}`);
}
