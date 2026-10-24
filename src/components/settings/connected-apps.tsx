import { ChevronRight } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { scopeKey } from "@/app/oauth/consent/scopes";
import { safeHttpUrl } from "@/server/mcp/consent";
import { listConnectedApps, type ConnectedApp } from "@/server/mcp/grants";
import { requireUser } from "@/server/session";
import { AppTile } from "./app-tile";
import { RevokeAppButton } from "./revoke-app-button";
import { SettingsGroup } from "./section";

/** Apps (MCP clients) the current user has authorized, with a way to disconnect each one. */
export async function ConnectedApps() {
  const user = await requireUser();
  const apps = await listConnectedApps(user.id);
  const [t, tScopes, tAccess, format] = await Promise.all([
    getTranslations("settings.connectedApps"),
    getTranslations("consent.scopes"),
    getTranslations("apiTokens.row"),
    getFormatter(),
  ]);
  const date = (value: Date) => format.dateTime(value, { dateStyle: "medium" });
  const describe = (scope: string) => {
    const key = scopeKey(scope);
    return key ? tScopes(key) : scope;
  };
  const view = (app: ConnectedApp) => {
    const uri = safeHttpUrl(app.uri);
    const writes = app.scopes.includes("pages:write");
    return {
      host: uri && (
        <a href={uri} target="_blank" rel="noreferrer" className="truncate text-xs text-fg-muted hover:underline">
          {new URL(uri).host}
        </a>
      ),
      when:
        app.updatedAt.getTime() - app.connectedAt.getTime() > 60_000
          ? t("connectedAndUpdated", { connected: date(app.connectedAt), updated: date(app.updatedAt) })
          : t("connected", { date: date(app.connectedAt) }),
      access: (
        <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs whitespace-nowrap text-fg-muted">
          <span className={`h-1.5 w-1.5 rounded-full ${writes ? "bg-amber-400" : "bg-emerald-500"}`} aria-hidden />
          {writes ? tAccess("readWrite") : tAccess("readOnly")}
        </span>
      ),
      permissions: (
        <details className="group mt-2">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-xs text-fg-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100" aria-hidden />
            {t("permissions", { count: app.scopes.length })}
          </summary>
          <ul className="mt-2 space-y-1 border-s border-border ps-3 text-xs text-fg-muted">
            {app.scopes.map((scope) => (
              <li key={scope}>{describe(scope)}</li>
            ))}
          </ul>
        </details>
      ),
    };
  };

  if (apps.length === 0) {
    return (
      <SettingsGroup anchor="connectedApps" title={t("listHeading")}>
        <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("empty")}</p>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup anchor="connectedApps" title={t("listHeading")}>
      {apps.map((app) => {
        const v = view(app);
        return (
          <div key={app.clientId} className="px-5 py-4">
            <div className="flex items-start gap-4">
              <AppTile name={app.name} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-sm font-medium">{app.name}</span>
                  {v.host}
                </div>
                <p className="mt-0.5 text-xs text-fg-muted">{v.when}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="max-sm:hidden">{v.access}</span>
                <RevokeAppButton clientId={app.clientId} name={app.name} />
              </div>
            </div>
            {/* Under the name on wider screens (the tile's width and gap in), the row's full width on phones. */}
            <div className="sm:ps-14">
              <div className="mt-3 sm:hidden">{v.access}</div>
              {v.permissions}
            </div>
          </div>
        );
      })}
    </SettingsGroup>
  );
}
