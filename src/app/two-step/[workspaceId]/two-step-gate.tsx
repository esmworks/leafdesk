"use client";

import { KeyRound, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SESSION_NOT_FRESH, SignInAgain } from "@/components/account/sign-in-again";
import { addPasskey, usePasskeySupport } from "@/components/security/passkeys";
import { TwoFactorSetupFlow, useSecurityError } from "@/components/security/two-factor";
import { Button } from "@/components/ui";
import { authClient } from "@/lib/auth-client";
import { wipeAllOfflineData } from "@/components/offline/offline-store";

export function TwoStepGate({
  workspaceId,
  workspaceName,
  hasPassword,
  hasPasskeys,
  passkeyAllowed = true,
  email,
}: {
  workspaceId: string;
  workspaceName: string;
  hasPassword: boolean;
  hasPasskeys: boolean;
  /** False when the workspace also requires single sign-on, which a passkey sign-in isn't. */
  passkeyAllowed?: boolean;
  email: string;
}) {
  const t = useTranslations("security.gate");
  const router = useRouter();
  const describe = useSecurityError();
  const supported = usePasskeySupport();
  const [mode, setMode] = useState<"choose" | "app">("choose");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A passkey is added only on a recent sign-in (lib/auth-options.ts session.freshAge).
  const [stale, setStale] = useState(false);
  // A full load, so the workspace renders with the session the passkey just created.
  const enter = () => window.location.assign(`/w/${workspaceId}`);

  /** Signs in again with a passkey (adding one first when there is none): that session passes. */
  async function continueWithPasskey() {
    setPending(true);
    setError(null);
    if (!hasPasskeys) {
      const added = await addPasskey();
      if (added.error) {
        setPending(false);
        if (added.error.code === SESSION_NOT_FRESH) return setStale(true);
        return setError(describe(added.error));
      }
    }
    const result = await authClient.signIn.passkey();
    setPending(false);
    if (result?.error) return setError(describe(result.error));
    enter();
  }

  if (mode === "app") {
    return (
      <div className="space-y-4">
        <h1 className="text-base font-semibold">{t("appTitle")}</h1>
        <TwoFactorSetupFlow
          hasPassword={hasPassword}
          onCancel={() => setMode("choose")}
          onDone={() => {
            router.refresh();
            enter();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-base font-semibold">{t("title", { workspace: workspaceName })}</h1>
        <p className="text-sm text-fg-muted">{t("body")}</p>
      </div>
      <div className="space-y-2">
        <Button variant="primary" className="w-full gap-2" onClick={() => setMode("app")} disabled={pending}>
          <Smartphone className="h-4 w-4" aria-hidden />
          {t("useApp")}
        </Button>
        {passkeyAllowed && (
          <Button className="w-full gap-2" onClick={continueWithPasskey} disabled={pending || supported === false}>
            <KeyRound className="h-4 w-4" aria-hidden />
            {hasPasskeys ? t("usePasskey") : t("addPasskey")}
          </Button>
        )}
        {passkeyAllowed && supported === false && <p className="text-xs text-fg-muted">{t("passkeyUnsupported")}</p>}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {stale && <SignInAgain />}
      <p className="border-t border-border pt-4 text-xs text-fg-muted">
        {t("signedInAs", { email })}{" "}
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={async () => {
            await authClient.signOut();
            await wipeAllOfflineData();
            window.location.assign("/sign-in");
          }}
        >
          {t("signOut")}
        </button>
      </p>
    </div>
  );
}
