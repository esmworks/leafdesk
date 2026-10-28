"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { cancelEmailChangeAction, requestEmailChangeAction } from "@/app/actions/account";
import { SettingsRow } from "@/components/settings/section";
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Input } from "@/components/ui";
import { EMAIL_CHANGE_HOURS } from "@/lib/account";
import { authClient } from "@/lib/auth-client";
import { canProve, ProofFields, proofFrom, type ProofSetup } from "./proof-fields";

/**
 * Account > Profile > Email: changing the address goes through a link sent to the new one, so it
 * needs email to be set up on the server; without it the row says so instead.
 */
export function AccountEmailSettings({
  email,
  emailVerified,
  pendingEmail,
  enabled,
  proof,
}: {
  email: string;
  emailVerified: boolean;
  pendingEmail: string | null;
  enabled: boolean;
  proof: ProofSetup;
}) {
  const t = useTranslations("account.email");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <SettingsRow
        title={email}
        description={enabled ? t("description") : t("mailOff")}
        control={
          <Button disabled={!enabled} onClick={() => setOpen(true)}>
            {t("change")}
          </Button>
        }
      />
      {!emailVerified && <VerifyEmailRow email={email} enabled={enabled} />}
      {pendingEmail && (
        <SettingsRow
          title={t("pendingTitle", { email: pendingEmail })}
          description={t("pendingDescription", { hours: EMAIL_CHANGE_HOURS })}
          control={
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => startTransition(() => cancelEmailChangeAction())}
            >
              {tc("cancel")}
            </Button>
          }
        />
      )}
      {open && <ChangeEmailDialog current={email} proof={proof} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * An address nobody proved yet: Better Auth emails a link that verifies it. Workspaces that allow
 * the address's domain only let verified addresses in (see server/join-requests.ts).
 */
function VerifyEmailRow({ email, enabled }: { email: string; enabled: boolean }) {
  const t = useTranslations("account.email");
  const tc = useTranslations("common");
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  const [pending, startTransition] = useTransition();

  return (
    <SettingsRow
      title={t("unverifiedTitle")}
      description={
        state === "sent" ? (
          t("verifySent", { email })
        ) : state === "error" ? (
          <span className="text-danger">{tc("genericError")}</span>
        ) : enabled ? (
          t("unverifiedDescription")
        ) : (
          t("unverifiedMailOff")
        )
      }
      control={
        <Button
          disabled={!enabled || pending || state === "sent"}
          onClick={() =>
            startTransition(async () => {
              const { error } = await authClient.sendVerificationEmail({ email, callbackURL: "/account?tab=profile" });
              setState(error ? "error" : "sent");
            })
          }
        >
          {t("verify")}
        </Button>
      }
    />
  );
}

function ChangeEmailDialog({ current, proof, onClose }: { current: string; proof: ProofSetup; onClose: () => void }) {
  const t = useTranslations("account.email");
  const tc = useTranslations("common");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      {sentTo ? (
        <>
          <DialogBody className="pt-5">
            <div className="space-y-1.5">
              <DialogTitle>{t("sentTitle")}</DialogTitle>
              <p className="text-sm text-fg-muted">{t("sentBody", { email: sentTo, hours: EMAIL_CHANGE_HOURS })}</p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onClick={onClose}>
              {tc("close")}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setError(null);
            startTransition(async () => {
              const result = await requestEmailChangeAction({
                newEmail: String(form.get("email") ?? ""),
                proof: proofFrom(form),
              }).catch(() => null);
              if (!result?.ok) return setError(result?.error ?? tc("genericError"));
              setSentTo(result.data.email);
            });
          }}
        >
          <DialogBody className="pt-5">
            <div className="space-y-1.5">
              <DialogTitle>{t("dialogTitle")}</DialogTitle>
              <p className="text-sm text-fg-muted">{t("dialogBody", { email: current })}</p>
            </div>
            <label className="block space-y-1.5">
              <span className="text-sm text-fg-muted">{t("newLabel")}</span>
              <Input name="email" type="email" required autoComplete="email" autoFocus maxLength={254} />
            </label>
            <ProofFields proof={proof} returnTo="/account?tab=profile" />
            {error && <p className="text-sm text-danger">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !canProve(proof)}>
              {t("send")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
