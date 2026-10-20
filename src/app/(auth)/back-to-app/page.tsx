import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { OpenAppLink } from "./open-app-link";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.backToApp");
  return { title: t("metaTitle") };
}

/** The sign-ins the desktop app finishes (desktop/src/navigation.ts), by their return address. */
const FLOWS = new Set(["connections", "storage"]);
/** What a service's answer carries back (RFC 6749 4.1.2, RFC 9207). */
const ANSWER_PARAMS = ["state", "code", "iss", "error"];

/**
 * Where a service's answer lands when the browser it came back to has no Leafdesk session: the
 * desktop app sends sign-ins for connections and storage to the system's browser. The answer goes
 * on to the app in a `leafdesk://` link, and the app takes it to the server, which finishes the
 * sign-in under the app's session, for the person who began it.
 */
export default async function BackToAppPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const flow = typeof params.flow === "string" && FLOWS.has(params.flow) ? params.flow : null;
  if (!flow) notFound();
  const link = new URL(`leafdesk://sign-in/${flow}`);
  for (const key of ANSWER_PARAMS) {
    const value = params[key];
    if (typeof value === "string") link.searchParams.set(key, value);
  }
  const t = await getTranslations("auth.backToApp");
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="text-sm text-fg-muted">{t("body")}</p>
      <OpenAppLink href={link.href} label={t("open")} />
      <p className="text-sm text-fg-muted">
        {t("notApp")}{" "}
        <Link href="/sign-in" className="text-accent hover:underline">
          {t("signIn")}
        </Link>
      </p>
    </div>
  );
}
