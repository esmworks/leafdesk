"use client";

import { useTranslations } from "next-intl";
import { SignInAgain } from "@/components/account/sign-in-again";
import { CodeInput } from "@/components/security/two-factor";
import { Input } from "@/components/ui";
import type { Proof, ProofKind } from "@/lib/account";

export { SignInAgain };

/** How this account confirms sensitive changes, and whether its session is recent enough for the last resort. */
export type ProofSetup = { kind: ProofKind; recent: boolean };

/** The proof fields of a form, read back from its FormData. */
export function proofFrom(form: FormData): Proof {
  const password = form.get("current-password");
  const code = form.get("code");
  return {
    ...(typeof password === "string" ? { password } : {}),
    ...(typeof code === "string" ? { code: code.trim() } : {}),
  };
}

/**
 * What a sensitive change asks for: the current password; for accounts without one, a code from
 * the authenticator app or a recovery code; and for accounts with neither, a recent sign-in (with
 * a way to sign in again when it's been too long).
 */
export function ProofFields({ proof, returnTo }: { proof: ProofSetup; returnTo: string }) {
  const t = useTranslations("account.proof");
  if (proof.kind === "password") {
    return (
      <label className="block space-y-1.5">
        <span className="text-sm text-fg-muted">{t("password")}</span>
        <Input name="current-password" type="password" required autoComplete="current-password" />
      </label>
    );
  }
  if (proof.kind === "code") {
    return (
      <label htmlFor="proof-code" className="block space-y-1.5">
        <span className="text-sm text-fg-muted">{t("code")}</span>
        <CodeInput id="proof-code" recovery />
      </label>
    );
  }
  if (proof.recent) return <p className="text-sm text-fg-muted">{t("recent")}</p>;
  return <SignInAgain returnTo={returnTo} />;
}

/** Whether the form can be sent: accounts proving themselves by a recent sign-in need one. */
export const canProve = (proof: ProofSetup) => proof.kind !== "recentSignIn" || proof.recent;
