import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { findPhoneSignIn } from "@/server/phone-sign-in";
import { PhoneSignInButton } from "./phone-sign-in-button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("account.phoneSignIn");
  return { title: t("metaTitle") };
}

/**
 * Where a QR code from the account page leads (server/phone-sign-in.ts). Opening it signs nobody
 * in: the page names the account, so nobody signs a phone into an account it didn't mean to, and
 * the button posts the code to Better Auth's `/phone-sign-in`.
 */
export default async function PhoneSignInPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("account.phoneSignIn");
  const found = await findPhoneSignIn(token);
  if (!found) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">{t("invalidTitle")}</h1>
        <p className="text-sm text-fg-muted">{t("invalidBody")}</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t("phoneTitle")}</h1>
      <p className="text-sm text-fg-muted">{t("phoneBody", { name: found.name, email: found.email })}</p>
      <PhoneSignInButton token={token} />
    </div>
  );
}
