"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui";
import { isPhoneSignInError, PHONE_SIGN_IN_ENDPOINT, type PhoneSignInError } from "@/lib/phone-sign-in";

const MESSAGE: Record<PhoneSignInError, "invalidBody" | "refusedSso" | "refusedTwoFactor"> = {
  PHONE_LINK_INVALID: "invalidBody",
  PHONE_LINK_SSO: "refusedSso",
  PHONE_LINK_TWO_FACTOR: "refusedTwoFactor",
};

/** Posts the code; a full page load follows, so the app starts with the new session's cookie. */
export function PhoneSignInButton({ token }: { token: string }) {
  const t = useTranslations("account.phoneSignIn");
  const tc = useTranslations("common");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth${PHONE_SIGN_IN_ENDPOINT}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; twoFactorRedirect?: boolean; code?: unknown } | null;
      // Two-step verification on: the phone enters a code, as at any sign-in.
      if (body?.twoFactorRedirect) return window.location.assign("/sign-in?step=two-factor");
      if (response.ok && body?.ok) return window.location.assign("/");
      setError(isPhoneSignInError(body?.code) ? t(MESSAGE[body.code]) : tc("genericError"));
    } catch {
      setError(tc("genericError"));
    }
    setPending(false);
  };

  return (
    <div className="space-y-3">
      <Button variant="primary" className="w-full" disabled={pending} onClick={() => void signIn()}>
        {t("phoneConfirm")}
      </Button>
      <p className="text-xs text-fg-muted">{t("phoneWarning")}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
