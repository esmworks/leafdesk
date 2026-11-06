"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { wipeAllOfflineData } from "@/components/offline/offline-store";
import { Button } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

/** Better Auth's code when a change needs a more recent sign-in than the session's (lib/account.ts FRESH_SIGN_IN_MINUTES). */
export const SESSION_NOT_FRESH = "SESSION_NOT_FRESH";

/**
 * Signing out and back in, for accounts that can only prove themselves with a fresh sign-in.
 * `returnTo`: where the sign-in comes back to; the page shown when left out.
 */
export function SignInAgain({ returnTo }: { returnTo?: string }) {
  const t = useTranslations("account.proof");
  const [pending, setPending] = useState(false);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-bg-subtle px-3 py-2.5 text-sm">
      <p className="text-fg-muted">{t("stale")}</p>
      <Button
        size="sm"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const next = returnTo ?? window.location.pathname + window.location.search;
          await authClient.signOut();
          await wipeAllOfflineData();
          window.location.href = `/sign-in?next=${encodeURIComponent(next)}`;
        }}
      >
        {t("signInAgain")}
      </Button>
    </div>
  );
}
