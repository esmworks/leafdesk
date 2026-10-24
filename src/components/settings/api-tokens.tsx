import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { summarizeScopes, type ScopeTexts } from "@/lib/api-scopes";
import { listApiTokens } from "@/server/api/tokens";
import { requireUser } from "@/server/session";
import { listWorkspaces } from "@/server/workspaces";
import { EditApiTokenScopes, NewApiToken, RevokeApiTokenButton } from "./api-token-controls";
import { SettingsGroup } from "./section";

/**
 * The signed-in user's personal access tokens for the REST API: create (the secret is shown once),
 * see what each may do and when it was last used, change what it may do, revoke. Self-contained,
 * so it can move to another settings page as it is.
 */
export async function ApiTokens() {
  const user = await requireUser();
  const [tokens, workspaces, t, tScopes, format] = await Promise.all([
    listApiTokens(user.id),
    listWorkspaces(user.id),
    getTranslations("apiTokens"),
    getTranslations("apiTokens.scopes"),
    getFormatter(),
  ]);
  const scopeText: ScopeTexts = (key, values) => tScopes(key as never, values as never);
  const date = (value: Date) => format.dateTime(value, { dateStyle: "medium" });
  const now = Date.now();

  return (
    <SettingsGroup
      anchor="apiTokens"
      title={t("heading")}
      description={
        <>
          {t("description")}{" "}
          <Link href="/docs/api" className="text-fg underline underline-offset-2 hover:text-accent">
            {t("docs")}
          </Link>
        </>
      }
      action={<NewApiToken workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))} />}
    >
      {tokens.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("empty")}</p>
      ) : (
        tokens.map((token) => {
          const expired = token.expiresAt !== null && token.expiresAt.getTime() <= now;
          return (
            <div key={token.id} className="flex items-start gap-4 px-5 py-4" data-token-id={token.id}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="truncate text-sm font-medium">{token.name}</span>
                  <code className="text-xs text-fg-muted">{token.prefix}…</code>
                </div>
                <p className="mt-0.5 text-sm text-fg-muted" data-token-scopes>
                  {summarizeScopes(token.scopes, scopeText)}
                  {token.legacyScopes && ` (${t("row.legacy")})`}
                  {" · "}
                  {token.workspaceName ?? t("row.allWorkspaces")}
                </p>
                <p className="mt-0.5 text-xs text-fg-muted">
                  {t("row.createdAt", { date: date(token.createdAt) })}
                  {" · "}
                  {token.lastUsedAt ? t("row.lastUsed", { date: date(token.lastUsedAt) }) : t("row.neverUsed")}
                  {" · "}
                  {token.expiresAt === null ? (
                    t("row.noExpiry")
                  ) : expired ? (
                    <span className="text-danger">{t("row.expired", { date: date(token.expiresAt) })}</span>
                  ) : (
                    t("row.expires", { date: date(token.expiresAt) })
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-start gap-1.5">
                <EditApiTokenScopes tokenId={token.id} name={token.name} scopes={token.scopes} legacy={token.legacyScopes} />
                <RevokeApiTokenButton tokenId={token.id} name={token.name} />
              </div>
            </div>
          );
        })
      )}
    </SettingsGroup>
  );
}
