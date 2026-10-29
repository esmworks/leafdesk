"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  addAiAccountAction,
  deleteAiAccountAction,
  setDefaultAiAccountAction,
  testAiAccountAction,
  updateAiAccountAction,
} from "@/app/actions/ai-accounts";
import { SettingsGroup, SettingsRow } from "@/components/settings/section";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Input, selectClass } from "@/components/ui";
import { EMBEDDING_PROVIDERS, MODEL_EXAMPLES, OWN_AI_PROVIDERS, STT_PROVIDERS, type AiAccountView, type OwnAiProvider } from "@/lib/ai-accounts";
import { relativeTime } from "@/lib/relative-time";

/**
 * Settings > Apps > AI: the person's own AI provider accounts (server/ai-accounts.ts). Add one with
 * its key (tried with a tiny request before it is saved), test it again, change it, make it the
 * default for new workspaces, remove it. The key is never shown again, only its last characters.
 */
export function AiAccountsSettings({ initial }: { initial: AiAccountView[] }) {
  const t = useTranslations("ai.accounts");
  const [accounts, setAccounts] = useState(initial);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <SettingsGroup
      anchor="aiAccounts"
      title={t("heading")}
      description={t("description")}
      action={
        !adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            {t("add")}
          </Button>
        )
      }
    >
      {adding && (
        <div className="px-5 py-4">
          <AccountForm
            onCancel={() => setAdding(false)}
            onSaved={(next) => {
              setAccounts(next);
              setAdding(false);
            }}
          />
        </div>
      )}
      {accounts.length === 0 && !adding ? (
        <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("empty")}</p>
      ) : (
        accounts.map((account) =>
          editing === account.id ? (
            <div key={account.id} className="px-5 py-4">
              <AccountForm
                account={account}
                onCancel={() => setEditing(null)}
                onSaved={(next) => {
                  setAccounts(next);
                  setEditing(null);
                }}
              />
            </div>
          ) : (
            <AccountRow key={account.id} account={account} onChange={setAccounts} onEdit={() => setEditing(account.id)} />
          ),
        )
      )}
    </SettingsGroup>
  );
}

function AccountRow({ account, onChange, onEdit }: { account: AiAccountView; onChange: (next: AiAccountView[]) => void; onEdit: () => void }) {
  const t = useTranslations("ai.accounts");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { pending, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const broken = account.status === "broken";

  return (
    <SettingsRow
      title={
        <>
          <span className="block text-xs font-normal text-fg-muted">
            {t(`providers.${account.provider}`)}
            {account.isDefault && <> · {t("default")}</>}
          </span>
          {account.label}
        </>
      }
      description={
        <span data-ai-account={account.id}>
          <span className="block">
            {[
              account.model,
              account.baseUrl,
              account.keyHint ? t("keyHint", { hint: account.keyHint }) : null,
              account.embeddingsModel ? t("embeddingsValue", { model: account.embeddingsModel }) : null,
              account.sttModel ? t("sttValue", { model: account.sttModel }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span className={cn("block", broken && "text-danger")}>
            {broken ? t("status.broken", { error: account.lastError ?? "" }) : t("status.active", { time: relativeTime(account.verifiedAt, locale) })}
          </span>
          <span className="block">
            {account.workspaces.length
              ? t("usedBy", { names: account.workspaces.map((w) => w.name).join(", "), count: account.workspaces.length })
              : t("unused")}
          </span>
          {error && (
            <span role="alert" className="block text-danger">
              {error}
            </span>
          )}
        </span>
      }
      control={
        confirming ? null : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" disabled={pending} onClick={() => run(() => testAiAccountAction(account.id), onChange)}>
              {pending ? t("testing") : t("test")}
            </Button>
            <Button size="sm" disabled={pending} onClick={onEdit}>
              {t("change")}
            </Button>
            {!account.isDefault && (
              <Button size="sm" disabled={pending} onClick={() => run(() => setDefaultAiAccountAction(account.id), onChange)}>
                {t("makeDefault")}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(true)}>
              {t("remove")}
            </Button>
          </div>
        )
      }
    >
      {confirming && (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-sm text-fg-muted">
            {account.workspaces.length ? t("removeNoteUsed", { count: account.workspaces.length }) : t("removeNote")}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              {tc("cancel")}
            </Button>
            <Button size="sm" variant="danger" disabled={pending} onClick={() => run(() => deleteAiAccountAction(account.id), onChange)}>
              {t("remove")}
            </Button>
          </div>
        </div>
      )}
    </SettingsRow>
  );
}

/** Adds an account, or changes one (its key left empty keeps the saved one). Saving tries it first. */
function AccountForm({ account, onCancel, onSaved }: { account?: AiAccountView; onCancel: () => void; onSaved: (next: AiAccountView[]) => void }) {
  const t = useTranslations("ai.accounts");
  const tc = useTranslations("common");
  const [provider, setProvider] = useState<OwnAiProvider>(account?.provider ?? "openai");
  const [label, setLabel] = useState(account?.label ?? "");
  const [model, setModel] = useState(account?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(account?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [embeddingsModel, setEmbeddingsModel] = useState(account?.embeddingsModel ?? "");
  const [sttModel, setSttModel] = useState(account?.sttModel ?? "");
  const { pending, error, run } = useAction();
  const typed = provider === "openai-compatible";
  // A saved key stays only with the same provider and address (the server checks this too).
  const keepsKey = Boolean(account && account.provider === provider && (account.baseUrl ?? "") === baseUrl.trim().replace(/\/+$/, ""));
  const ready = model.trim() && (!typed || baseUrl.trim()) && (typed || keepsKey || apiKey.trim());

  return (
    <form
      className="space-y-4"
      data-ai-account-form
      onSubmit={(e) => {
        e.preventDefault();
        const input = { provider, label, model, baseUrl: typed ? baseUrl : null, apiKey: apiKey || null, embeddingsModel, sttModel };
        run(() => (account ? updateAiAccountAction(account.id, input) : addAiAccountAction(input)), onSaved);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.provider")}</span>
          <select name="provider" className={cn(selectClass, "w-full")} value={provider} onChange={(e) => setProvider(e.target.value as OwnAiProvider)}>
            {OWN_AI_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {t(`providers.${p}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.label")}</span>
          <Input name="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("fields.labelHint")} autoComplete="off" />
        </label>
      </div>
      {typed && (
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.baseUrl")}</span>
          <Input
            name="baseUrl"
            type="url"
            value={baseUrl}
            required
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://models.example.com/v1"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="block text-xs text-fg-muted">{t("fields.baseUrlHint")}</span>
        </label>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.model")}</span>
          <Input
            name="model"
            value={model}
            required
            onChange={(e) => setModel(e.target.value)}
            placeholder={MODEL_EXAMPLES[provider]}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="block text-xs text-fg-muted">{t("fields.modelHint")}</span>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{typed ? t("fields.apiKeyOptional") : t("fields.apiKey")}</span>
          <Input
            name="apiKey"
            type="password"
            value={apiKey}
            required={!typed && !keepsKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={keepsKey && account?.keyHint ? t("fields.apiKeyKeep", { hint: account.keyHint }) : undefined}
            autoComplete="new-password"
          />
        </label>
      </div>
      {(EMBEDDING_PROVIDERS.includes(provider) || STT_PROVIDERS.includes(provider)) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {EMBEDDING_PROVIDERS.includes(provider) && (
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t("fields.embeddingsModel")}</span>
              <Input name="embeddingsModel" value={embeddingsModel} onChange={(e) => setEmbeddingsModel(e.target.value)} autoComplete="off" spellCheck={false} />
              <span className="block text-xs text-fg-muted">{t("fields.embeddingsModelHint")}</span>
            </label>
          )}
          {STT_PROVIDERS.includes(provider) && (
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t("fields.sttModel")}</span>
              <Input name="sttModel" value={sttModel} onChange={(e) => setSttModel(e.target.value)} autoComplete="off" spellCheck={false} />
              <span className="block text-xs text-fg-muted">{t("fields.sttModelHint")}</span>
            </label>
          )}
        </div>
      )}
      <p className="text-xs text-fg-muted">{t("fields.keyHint")}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          {tc("cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !ready}>
          {pending ? t("testing") : t("save")}
        </Button>
      </div>
    </form>
  );
}
