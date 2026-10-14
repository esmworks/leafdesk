import { getFormatter, getNow, getTranslations } from "next-intl/server";
import { safeHttpUrl } from "@/server/mcp/consent";
import type { WorkspaceApp } from "@/server/workspace-apps";
import { DisconnectWorkspaceAppButton } from "./disconnect-workspace-app-button";

/**
 * Settings > Security, for owners: the apps the workspace's people connected that can reach it,
 * with when each last did, and a way to disconnect one.
 */
export async function WorkspaceApps({ workspaceId, apps }: { workspaceId: string; apps: WorkspaceApp[] }) {
  const [t, format, now] = await Promise.all([getTranslations("settings.security.workspaceApps"), getFormatter(), getNow()]);
  if (!apps.length) return <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("empty")}</p>;
  const date = (value: Date) => format.dateTime(value, { dateStyle: "medium" });
  return (
    <ul aria-label={t("list")} className="divide-y divide-border">
      {apps.map((app) => {
        const icon = safeHttpUrl(app.icon);
        const person = app.person.name || app.person.email;
        return (
          <li key={`${app.kind}:${app.person.id}:${app.id}`} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:gap-4">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              {icon ? (
                <img src={icon} alt="" className="h-9 w-9 shrink-0 rounded-lg border border-border bg-bg object-cover" />
              ) : (
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg text-sm font-semibold text-fg-muted">
                  {app.name.slice(0, 1).toUpperCase()}
                </span>
              )}
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
                    t(app.writes ? "writes" : "reads"),
                    app.kind === "api_token" && !app.allWorkspaces ? t("thisWorkspaceOnly") : null,
                    t("connected", { date: date(app.connectedAt) }),
                    app.lastUsedHere ? t("lastUsed", { when: format.relativeTime(app.lastUsedHere, now) }) : t("notUsed"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </div>
            <DisconnectWorkspaceAppButton
              workspaceId={workspaceId}
              target={{ kind: app.kind, userId: app.person.id, id: app.id }}
              name={app.name}
              person={person}
              allWorkspaces={app.allWorkspaces}
            />
          </li>
        );
      })}
    </ul>
  );
}
