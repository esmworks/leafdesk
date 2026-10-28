"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { changePasswordAction, setPasswordAction } from "@/app/actions/account";
import { SettingsRow } from "@/components/settings/section";
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Input } from "@/components/ui";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/account";
import { SOCIAL_PROVIDER_NAMES } from "@/lib/social-providers";
import { canProve, ProofFields, proofFrom, type ProofSetup } from "./proof-fields";

const providerName = (id: string) => (SOCIAL_PROVIDER_NAMES as Record<string, string>)[id] ?? id;

/**
 * Account > Security > Password: change it with the current one (optionally signing out every
 * other session), or, for accounts that only sign in with GitHub or Google, set one.
 */
export function PasswordSettings({
  hasPassword,
  providers,
  proof,
}: {
  hasPassword: boolean;
  providers: string[];
  proof: ProofSetup;
}) {
  const t = useTranslations("account.password");
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const names = providers.map(providerName).join(", ");

  return (
    <>
      <SettingsRow
        title={t("title")}
        description={
          done ? (
            <span className="text-fg">{done}</span>
          ) : hasPassword ? (
            t("set")
          ) : providers.length ? (
            t("notSetSocial", { providers: names })
          ) : (
            t("notSet")
          )
        }
        control={
          <Button variant={hasPassword ? "secondary" : "primary"} onClick={() => setOpen(true)}>
            {hasPassword ? t("change") : t("setPassword")}
          </Button>
        }
      />
      {open &&
        (hasPassword ? (
          <ChangePasswordDialog
            onClose={() => setOpen(false)}
            onDone={(message) => {
              setOpen(false);
              setDone(message);
            }}
          />
        ) : (
          <SetPasswordDialog
            proof={proof}
            onClose={() => setOpen(false)}
            onDone={(message) => {
              setOpen(false);
              setDone(message);
            }}
          />
        ))}
    </>
  );
}

function NewPasswordFields() {
  const t = useTranslations("account.password");
  return (
    <>
      <label className="block space-y-1.5">
        <span className="text-sm text-fg-muted">{t("newLabel")}</span>
        <Input
          name="new-password"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={MAX_PASSWORD_LENGTH}
          autoComplete="new-password"
        />
        <span className="block text-xs text-fg-muted">{t("rules", { min: MIN_PASSWORD_LENGTH })}</span>
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm text-fg-muted">{t("repeatLabel")}</span>
        <Input name="repeat-password" type="password" required autoComplete="new-password" />
      </label>
    </>
  );
}

function ChangePasswordDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const t = useTranslations("account.password");
  const tp = useTranslations("account.proof");
  const tc = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const newPassword = String(form.get("new-password") ?? "");
          if (newPassword !== form.get("repeat-password")) return setError(t("mismatch"));
          const revokeOthers = form.get("revoke-others") === "on";
          setError(null);
          startTransition(async () => {
            const result = await changePasswordAction({
              currentPassword: String(form.get("current-password") ?? ""),
              newPassword,
              revokeOthers,
            }).catch(() => null);
            if (!result?.ok) return setError(result?.error ?? tc("genericError"));
            onDone(revokeOthers ? t("changedSignedOut") : t("changed"));
            router.refresh();
          });
        }}
      >
        <DialogBody className="pt-5">
          <DialogTitle>{t("changeTitle")}</DialogTitle>
          <label className="block space-y-1.5">
            <span className="text-sm text-fg-muted">{tp("password")}</span>
            <Input name="current-password" type="password" required autoComplete="current-password" autoFocus />
          </label>
          <NewPasswordFields />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="revoke-others" defaultChecked className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]" />
            <span>
              {t("revokeOthers")}
              <span className="block text-xs text-fg-muted">{t("revokeOthersHelp")}</span>
            </span>
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {t("changeSubmit")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function SetPasswordDialog({
  proof,
  onClose,
  onDone,
}: {
  proof: ProofSetup;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const t = useTranslations("account.password");
  const tc = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const newPassword = String(form.get("new-password") ?? "");
          if (newPassword !== form.get("repeat-password")) return setError(t("mismatch"));
          setError(null);
          startTransition(async () => {
            const result = await setPasswordAction({ newPassword, proof: proofFrom(form) }).catch(() => null);
            if (!result?.ok) return setError(result?.error ?? tc("genericError"));
            onDone(t("setDone"));
            router.refresh();
          });
        }}
      >
        <DialogBody className="pt-5">
          <div className="space-y-1.5">
            <DialogTitle>{t("setTitle")}</DialogTitle>
            <p className="text-sm text-fg-muted">{t("setBody")}</p>
          </div>
          <NewPasswordFields />
          <ProofFields proof={proof} returnTo="/account?tab=security" />
          {error && <p className="text-sm text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={pending || !canProve(proof)}>
            {t("setSubmit")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
