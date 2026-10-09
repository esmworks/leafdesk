"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { createApiTokenAction, revokeApiTokenAction, type CreateApiTokenResult } from "@/app/actions/api-tokens";
import { Button, cn, Dialog, Input, selectClass } from "@/components/ui";
import { CopyButton } from "./copy-button";

/** Expiry choices, in days; null never expires. 90 days is the default. */
const EXPIRY_DAYS = [7, 30, 90, 365, null] as const;
const DEFAULT_EXPIRY = 90;

/** "New token" button and the dialog that creates one and shows its secret once. */
export function NewApiToken({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  const t = useTranslations("apiTokens");
  const tc = useTranslations("common");
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [expiry, setExpiry] = useState(String(DEFAULT_EXPIRY));
  const [error, setError] = useState<Exclude<CreateApiTokenResult, { ok: true } | { error: "policy" }>["error"] | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setName("");
    setWrite(false);
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
      <Dialog open={open} onClose={secret ? () => {} : close} className="max-w-md">
        {secret ? (
          <div className="space-y-4 p-5">
            <div>
              <h2 className="text-[15px] font-semibold">{t("created.title")}</h2>
              <p className="mt-1 text-sm text-fg-muted">{t("created.body")}</p>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle py-1.5 pr-1.5 pl-3">
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
                    write,
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
              {[
                { value: false, label: t("form.read"), hint: t("form.readHint") },
                { value: true, label: t("form.write"), hint: t("form.writeHint") },
              ].map((option) => (
                <label
                  key={String(option.value)}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2",
                    write === option.value ? "border-accent" : "border-border hover:bg-bg-hover",
                  )}
                >
                  <input
                    type="radio"
                    name={`${ids}-access`}
                    className="mt-1 accent-[var(--accent)]"
                    checked={write === option.value}
                    onChange={() => setWrite(option.value)}
                  />
                  <span>
                    <span className="block text-sm">{option.label}</span>
                    <span className="block text-xs text-fg-muted">{option.hint}</span>
                  </span>
                </label>
              ))}
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
                  onChange={(e) => setWorkspaceId(e.target.value)}
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
              <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
                {pending ? t("form.creating") : t("form.submit")}
              </Button>
            </div>
          </form>
        )}
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
