"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { startPhoneSignInAction } from "@/app/actions/account";
import { QrCode } from "@/components/security/qr-code";
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle } from "@/components/ui";
import type { Proof } from "@/lib/account";
import { secondsLeft } from "@/lib/phone-sign-in";
import { canProve, ProofFields, proofFrom, type ProofSetup } from "./proof-fields";

type Shown = { url: string; expiresAt: string };

/** Confirms it's the person, then shows the code and how long it works; loaded when first opened. */
export function PhoneSignInDialog({ proof, onClose }: { proof: ProofSetup; onClose: () => void }) {
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
