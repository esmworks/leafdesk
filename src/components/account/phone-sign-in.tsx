"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { startPhoneSignInAction } from "@/app/actions/account";
import { SettingsRow } from "@/components/settings/section";
import { QrCode } from "@/components/security/qr-code";
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle } from "@/components/ui";
import type { Proof } from "@/lib/account";
import { secondsLeft } from "@/lib/phone-sign-in";
import { canProve, ProofFields, proofFrom, type ProofSetup } from "./proof-fields";

/** Why the account page shows no code: a workspace's policy would hold the phone's session back (server/phone-sign-in.ts). */
export type PhoneSignInBlock = { hold: "sso" | "two-factor"; workspaces: string[] } | null;

/** "Sign in on your phone": confirms it's the person, then shows a QR code that signs a phone in once. */
export function PhoneSignIn({ proof, block }: { proof: ProofSetup; block: PhoneSignInBlock }) {
  const t = useTranslations("account.phoneSignIn");
  const [open, setOpen] = useState(false);
  const workspaces = block?.workspaces.join(", ") ?? "";
  return (
    <>
      <SettingsRow
        anchor="phoneSignIn"
        title={t("title")}
        description={block ? (block.hold === "sso" ? t("blockedSso", { workspaces }) : t("blockedTwoFactor", { workspaces })) : t("description")}
        control={
          block ? null : (
            <Button onClick={() => setOpen(true)}>{t("show")}</Button>
          )
        }
      />
      {open && <PhoneSignInDialog proof={proof} onClose={() => setOpen(false)} />}
    </>
  );
}

type Shown = { url: string; expiresAt: string };

function PhoneSignInDialog({ proof, onClose }: { proof: ProofSetup; onClose: () => void }) {
  const t = useTranslations("account.phoneSignIn");
  const tc = useTranslations("common");
  const [shown, setShown] = useState<Shown | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The proof that last worked, so a new code after one expires doesn't ask again.
  const lastProof = useRef<Proof | null>(null);

  useEffect(() => {
    if (!shown) return;
    const tick = () => setLeft(secondsLeft(shown.expiresAt));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [shown]);

  const request = (given: Proof) =>
    startTransition(async () => {
      setError(null);
      const result = await startPhoneSignInAction({ proof: given }).catch(() => null);
      if (!result?.ok) {
        lastProof.current = null;
        setShown(null);
        return setError(result?.error ?? tc("genericError"));
      }
      lastProof.current = given;
      setShown(result.data);
    });

  if (shown) {
    const expired = left === 0;
    return (
      <Dialog open onClose={onClose} className="max-w-sm">
        <DialogBody className="pt-5">
          <div className="space-y-1.5">
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <p className="text-sm text-fg-muted">{t("scan")}</p>
          </div>
          <div className="flex justify-center">
            {expired ? (
              <div style={{ width: 208, height: 208 }} className="flex items-center justify-center rounded-md border border-border p-4 text-center text-sm text-fg-muted">
                {t("expired")}
              </div>
            ) : (
              <QrCode value={shown.url} label={t("codeLabel")} size={208} />
            )}
          </div>
          <p className="text-center text-sm text-fg-muted" aria-live="polite">
            {expired ? t("expiredNote") : t("validFor", { seconds: left })}
          </p>
          {error && <p className="text-sm text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          {expired && lastProof.current ? (
            <>
              <Button variant="secondary" onClick={onClose}>
                {tc("close")}
              </Button>
              <Button variant="primary" disabled={pending} onClick={() => lastProof.current && request(lastProof.current)}>
                {t("newCode")}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={onClose}>
              {tc("close")}
            </Button>
          )}
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          request(proofFrom(new FormData(e.currentTarget)));
        }}
      >
        <DialogBody className="pt-5">
          <div className="space-y-1.5">
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <p className="text-sm text-fg-muted">{t("confirmBody")}</p>
          </div>
          <ProofFields proof={proof} returnTo="/account?tab=security" />
          {error && <p className="text-sm text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={pending || !canProve(proof)}>
            {t("showCode")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
