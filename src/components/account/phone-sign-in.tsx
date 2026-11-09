"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { lazyPart } from "@/components/lazy-part";
import { SettingsRow } from "@/components/settings/section";
import { Button } from "@/components/ui";
import type { ProofSetup } from "./proof-fields";

const PhoneSignInDialog = lazyPart(() => import("./phone-sign-in-dialog").then((m) => m.PhoneSignInDialog));

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
