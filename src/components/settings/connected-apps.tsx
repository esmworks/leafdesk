import { getFormatter, getTranslations } from "next-intl/server";
import { scopeKey } from "@/app/oauth/consent/scopes";
import { safeHttpUrl } from "@/server/mcp/consent";
import { listConnectedApps } from "@/server/mcp/grants";
import { requireUser } from "@/server/session";
import { AppTile } from "./app-tile";
import { RevokeAppButton } from "./revoke-app-button";
import { SettingsGroup } from "./section";

/** Apps (MCP clients) the current user has authorized, with a way to disconnect each one. */
export async function ConnectedApps() {
  const user = await requireUser();
  const apps = await listConnectedApps(user.id);
  const [t, tScopes, format] = await Promise.all([
    getTranslations("settings.connectedApps"),
    getTranslations("consent.scopes"),
    getFormatter(),
  ]);
  const date = (value: Date) => format.dateTime(value, { dateStyle: "medium" });
  const describe = (scope: string) => {
    const key = scopeKey(scope);
    return key ? tScopes(key) : scope;
  };

  return (
    <SettingsGroup title={t("listHeading")}>
      {apps.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("empty")}</p>
      ) : (
        apps.map((app) => {
          const uri = safeHttpUrl(app.uri);
          return (
            <div key={app.clientId} className="flex items-start gap-4 px-5 py-4">
              <AppTile name={app.name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{app.name}</span>
                  {uri && (
                    <a href={uri} target="_blank" rel="noreferrer" className="truncate text-xs text-fg-muted hover:underline">
                      {new URL(uri).host}
                    </a>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-fg-muted">
                  {app.updatedAt.getTime() - app.connectedAt.getTime() > 60_000
                    ? t("connectedAndUpdated", { connected: date(app.connectedAt), updated: date(app.updatedAt) })
                    : t("connected", { date: date(app.connectedAt) })}
                </p>
                <ul className="mt-2 space-y-0.5 text-xs text-fg-muted">
                  {app.scopes.map((scope) => (
                    <li key={scope}>{describe(scope)}</li>
                  ))}
                </ul>
              </div>
              <RevokeAppButton clientId={app.clientId} name={app.name} />
            </div>
          );
        })
      )}
    </SettingsGroup>
  );
}
