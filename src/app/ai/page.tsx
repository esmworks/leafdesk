import { redirect } from "next/navigation";
import { aiEnabledFor } from "@/server/ai";
import { listWorkspaces } from "@/server/pages";
import { requireUser } from "@/server/session";

/**
 * Where the desktop app's shortcut lands (desktop/src/global-shortcut.ts): the AI chat of the
 * workspace its window shows (`?workspace=`, else the person's first), or a quick note in it when
 * that workspace has no AI.
 */
export default async function AskAi({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [user, query] = await Promise.all([requireUser(), searchParams]);
  const workspaces = await listWorkspaces(user.id);
  if (!workspaces.length) redirect("/");
  const wanted = Array.isArray(query.workspace) ? query.workspace[0] : query.workspace;
  const chosen = workspaces.find((w) => w.id === wanted) ?? workspaces[0];
  if (await aiEnabledFor(chosen.id)) redirect(`/w/${chosen.id}/ai`);
  redirect(`/share?workspace=${encodeURIComponent(chosen.id)}`);
}
