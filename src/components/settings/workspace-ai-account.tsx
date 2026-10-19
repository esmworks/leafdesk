"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { setWorkspaceAiAccountAction } from "@/app/actions/ai-accounts";
import { cn, selectClass } from "@/components/ui";
import type { WorkspaceAiView } from "@/lib/ai-accounts";
import { SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

/**
 * Settings > General > AI > AI account (OWN_AI_KEYS_ENABLED): which own AI account the workspace's
 * AI runs on and is paid by. Owners pick one of their own accounts or none; everyone sees whose it is.
 */
export function WorkspaceAiAccount({ workspaceId, initial, accountsHref }: { workspaceId: string; initial: WorkspaceAiView; accountsHref: string }) {
  const t = useTranslations("ai.accounts.workspace");
  const router = useRouter();
  const [view, setView] = useState(initial);
  const { pending, error, run } = useAction();
  const { source } = view;
  const current = source.kind === "account" ? source.accountId : "";
  // Another owner's account shows as the choice it is, though only they could pick it.
  const theirs = source.kind === "account" && !view.mine.some((a) => a.id === source.accountId);

  const describe = () => {
    if (source.kind === "account") {
      return source.mine
        ? t("sourceMine", { label: source.label, provider: source.provider, model: source.model })
        : t("sourceTheirs", { name: source.ownerName, label: source.label, provider: source.provider, model: source.model });
    }
    if (source.kind === "instance") return t("sourceInstance");
    return view.onlyOwnKeys ? t("sourceOffOnlyOwn") : t("sourceOff");
  };

  return (
    <SettingsRow
      title={t("title")}
      htmlFor="workspace-ai-account"
      description={
        <>
          <span className="block" data-ai-source={source.kind}>
            {describe()}
          </span>
          {view.canChange && !view.mine.length && (
            <span className="block">
              {t("noAccounts")}{" "}
              <a href={accountsHref} className="text-fg underline underline-offset-2 hover:text-accent">
                {t("addOne")}
              </a>
            </span>
          )}
          {!view.canChange && <span className="block">{t("ownersOnly")}</span>}
          {error && (
            <span role="alert" className="block text-danger">
              {error}
            </span>
          )}
        </>
      }
      control={
        view.canChange && (view.mine.length > 0 || current) ? (
          <select
            id="workspace-ai-account"
            className={cn(selectClass, "max-w-56")}
            value={current}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.value || null;
              run(
                () => setWorkspaceAiAccountAction(workspaceId, next),
                (updated) => {
                  if (updated) setView(updated);
                  // The AI switch, models and the chat panel follow the account.
                  router.refresh();
                },
              );
            }}
          >
            <option value="">{view.serverAi ? t("noneInstance") : t("noneOff")}</option>
            {theirs && source.kind === "account" && (
              <option value={source.accountId} disabled>
                {t("theirsOption", { name: source.ownerName, label: source.label })}
              </option>
            )}
            {view.mine.map((a) => (
              <option key={a.id} value={a.id}>
                {a.status === "broken" ? t("brokenOption", { label: a.label }) : a.label}
              </option>
            ))}
          </select>
        ) : null
      }
    />
  );
}
