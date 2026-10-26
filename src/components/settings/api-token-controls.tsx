"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import {
  createApiTokenAction,
  revokeApiTokenAction,
  updateApiTokenScopesAction,
  type CreateApiTokenResult,
  type UpdateApiTokenResult,
} from "@/app/actions/api-tokens";
import { Button, cn, Dialog, Input, selectClass } from "@/components/ui";
import { OWNER_SCOPES, READ_SCOPES, type ApiTokenScope } from "@/lib/api-scopes";
import { ApiTokenScopePicker } from "./api-token-scopes";
import { CopyButton } from "./copy-button";

/** Expiry choices, in days; null never expires. 90 days is the default. */
const EXPIRY_DAYS = [7, 30, 90, 365, null] as const;
const DEFAULT_EXPIRY = 90;

/** "New token" button and the dialog that creates one and shows its secret once. */
export function NewApiToken({ workspaces }: { workspaces: { id: string; name: string; owner: boolean }[] }) {
  const t = useTranslations("apiTokens");
  const tc = useTranslations("common");
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiTokenScope[]>([...READ_SCOPES]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [expiry, setExpiry] = useState(String(DEFAULT_EXPIRY));
  const [error, setError] = useState<Exclude<CreateApiTokenResult, { ok: true } | { error: "policy" }>["error"] | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setName("");
    setScopes([...READ_SCOPES]);
    setWorkspaceId("");
    setExpiry(String(DEFAULT_EXPIRY));
    setError(null);
    setSecret(null);
  };
  const close = () => {
    setOpen(false);
    if (secret) router.refresh();
    reset();
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {t("create")}
      </Button>
      {/* While the secret is shown, only Done closes: a stray click must not lose it. */}
      <Dialog open={open} onClose={secret ? () => {} : close} className="max-w-xl">
        {secret ? (
          <div className="space-y-4 p-5">
            <div>
              <h2 className="text-[15px] font-semibold">{t("created.title")}</h2>
              <p className="mt-1 text-sm text-fg-muted">{t("created.body")}</p>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle py-1.5 pe-1.5 ps-3">
              <code className="min-w-0 flex-1 text-xs break-all" data-api-token-secret>
                {secret}
              </code>
              <CopyButton value={secret} />
            </div>
            <div className="flex justify-end">
              <Button variant="primary" onClick={close}>
                {t("created.done")}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              startTransition(async () => {
                try {
                  const result = await createApiTokenAction({
                    name,
                    scopes,
                    workspaceId: workspaceId || null,
                    expiresInDays: expiry === "never" ? null : Number(expiry),
                  });
                  if (result.ok) setSecret(result.secret);
                  // A workspace's sign-in policy holds this session back: meet it first.
                  else if (result.error === "policy") router.push(result.gate);
                  else setError(result.error);
                } catch {
                  setError("generic");
                }
              });
            }}
          >
            <h2 className="text-[15px] font-semibold">{t("form.title")}</h2>
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-name`} className="block text-sm font-medium">
                {t("form.name")}
              </label>
              <Input
                id={`${ids}-name`}
                value={name}
                maxLength={100}
                required
                autoFocus
                placeholder={t("form.namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <fieldset className="space-y-1.5">
              <legend className="mb-1.5 text-sm font-medium">{t("form.access")}</legend>
              <ApiTokenScopePicker
                value={scopes}
                onChange={setScopes}
                disabled={pending}
                owner={workspaces.some((w) => w.id === workspaceId && w.owner)}
              />
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor={`${ids}-workspace`} className="block text-sm font-medium">
                  {t("form.workspace")}
                </label>
                <select
                  id={`${ids}-workspace`}
                  className={cn(selectClass, "w-full")}
                  value={workspaceId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setWorkspaceId(id);
                    // Owner-only scopes go with a workspace the person owns.
                    if (!workspaces.some((w) => w.id === id && w.owner)) {
                      setScopes((s) => s.filter((scope) => !(OWNER_SCOPES as readonly string[]).includes(scope)));
                    }
                  }}
                >
                  <option value="">{t("form.allWorkspaces")}</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor={`${ids}-expiry`} className="block text-sm font-medium">
                  {t("form.expiry")}
                </label>
                <select
                  id={`${ids}-expiry`}
                  className={cn(selectClass, "w-full")}
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                >
                  {EXPIRY_DAYS.map((days) =>
                    days === null ? (
                      <option key="never" value="never">
                        {t("form.never")}
                      </option>
                    ) : (
                      <option key={days} value={String(days)}>
                        {t("form.days", { count: days })}
                      </option>
                    ),
                  )}
                </select>
              </div>
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {t(`errors.${error}`)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close} disabled={pending}>
                {tc("cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={pending || !name.trim() || !scopes.length}>
                {pending ? t("form.creating") : t("form.submit")}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}

/** "Change access" on a token, and the dialog that changes what it may do without changing its secret. */
export function EditApiTokenScopes({
  tokenId,
  name,
  scopes: current,
  legacy,
  owner,
}: {
  tokenId: string;
  name: string;
  scopes: ApiTokenScope[];
  legacy: boolean;
  /** Whether the token belongs to a workspace the person owns (owner-only scopes). */
  owner: boolean;
}) {
  const t = useTranslations("apiTokens");
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scopes, setScopes] = useState<ApiTokenScope[]>(current);
  const [error, setError] = useState<Exclude<UpdateApiTokenResult, { ok: true } | { error: "policy" }>["error"] | null>(null);
  const [pending, startTransition] = useTransition();
  const unchanged = !legacy && scopes.length === current.length && scopes.every((s) => current.includes(s));

  const close = () => {
    setOpen(false);
    setError(null);
  };

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setScopes(current);
          setOpen(true);
        }}
      >
        {t("edit.button")}
      </Button>
      <Dialog open={open} onClose={pending ? () => {} : close} className="max-w-xl">
        <form
          className="space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              try {
                const result = await updateApiTokenScopesAction(tokenId, scopes);
                // A workspace's sign-in policy holds this session back: meet it first.
                if (!result.ok && result.error === "policy") return router.push(result.gate);
                if (!result.ok) return setError(result.error);
                setOpen(false);
                router.refresh();
              } catch {
                setError("generic");
              }
            });
          }}
        >
          <div>
            <h2 className="text-[15px] font-semibold">{t("edit.title", { name })}</h2>
            <p className="mt-1 text-sm text-fg-muted">{t("edit.body")}</p>
          </div>
          {legacy && <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-xs text-fg-muted">{t("edit.legacy")}</p>}
          <ApiTokenScopePicker value={scopes} onChange={setScopes} disabled={pending} owner={owner} />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {t(`edit.errors.${error}`)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !scopes.length || unchanged}>
              {pending ? tc("saving") : tc("save")}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function RevokeApiTokenButton({ tokenId, name }: { tokenId: string; name: string }) {
  const router = useRouter();
  const t = useTranslations("apiTokens");
  const tc = useTranslations("common");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <Button size="sm" onClick={() => setConfirming(true)}>
        {t("revoke")}
      </Button>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
          {tc("cancel")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              try {
                await revokeApiTokenAction(tokenId);
                router.refresh();
              } catch {
                setError(true);
              }
            })
          }
        >
          {pending ? t("revoking") : t("confirmRevoke", { name })}
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{t("revokeError")}</p>}
    </div>
  );
}
