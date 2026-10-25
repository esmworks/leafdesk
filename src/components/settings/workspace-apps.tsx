import { getFormatter, getNow, getTranslations } from "next-intl/server";
import type { ConnectedAppsMode } from "@/server/connected-app";
import type { WorkspaceApp } from "@/server/workspace-apps";
import { AppTile } from "./app-tile";
import { ApproveWorkspaceAppButton } from "./approve-workspace-app-button";
import { DisconnectWorkspaceAppButton } from "./disconnect-workspace-app-button";

/**
 * Settings > Security, for owners: the apps the workspace's people connected that can reach it,
 * with when each last did, and a way to disconnect one. What each may do here is told with the
 * workspace's connected-apps setting (`mode`), which narrows what their scopes allow, and with
 * `onlyApproved`: then an app owners haven't approved doesn't reach the workspace at all. Apps are
 * approved (or no longer) here.
 */
export async function WorkspaceApps({
  workspaceId,
  apps,
  total,
  mode,
  onlyApproved,
}: {
  workspaceId: string;
  apps: WorkspaceApp[];
  total: number;
  mode: ConnectedAppsMode;
  onlyApproved: boolean;
}) {
  const [t, format, now] = await Promise.all([getTranslations("settings.security.workspaceApps"), getFormatter(), getNow()]);
  if (!apps.length) return <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("empty")}</p>;
  const date = (value: Date) => format.dateTime(value, { dateStyle: "medium" });
  const may = (app: WorkspaceApp) =>
    mode === "off"
      ? t("offHere")
      : onlyApproved && app.approved === false
        ? t("notApprovedHere")
        : !app.writes
          ? t("reads")
          : mode === "read"
            ? t("readsHere")
            : t("writes");
  return (
    <>
      <ul aria-label={t("list")} className="divide-y divide-border">
        {apps.map((app) => {
          const person = app.person.name || app.person.email;
          return (
            <li key={`${app.kind}:${app.person.id}:${app.id}`} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:gap-4">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <AppTile name={app.name} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {app.name}
                    {app.kind === "api_token" && <span className="font-normal text-fg-muted"> · {t("token", { prefix: app.prefix ?? "" })}</span>}
                  </div>
                  <div className="truncate text-sm text-fg-muted" title={app.person.email}>
                    {t("person", { name: person })}
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">
                    {[
                      app.approved ? t("approved") : null,
                      may(app),
                      app.kind === "api_token" && !app.allWorkspaces ? t("thisWorkspaceOnly") : null,
                      t("connected", { date: date(app.connectedAt) }),
                      app.lastUsedHere ? t("lastUsed", { when: format.relativeTime(app.lastUsedHere, now) }) : t("notUsed"),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-start gap-2">
                {app.approved !== null && <ApproveWorkspaceAppButton workspaceId={workspaceId} clientId={app.id} approved={app.approved} />}
                <DisconnectWorkspaceAppButton
                  workspaceId={workspaceId}
                  target={{ kind: app.kind, userId: app.person.id, id: app.id }}
                  name={app.name}
                  person={person}
                  allWorkspaces={app.allWorkspaces}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {total > apps.length && (
        <p className="border-t border-border px-5 py-3 text-xs text-fg-muted">{t("shown", { shown: apps.length, total })}</p>
      )}
    </>
  );
}
