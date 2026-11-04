import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function PublishedNotFound() {
  const t = await getTranslations("publish");
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 bg-bg px-4 text-center text-fg">
      <h1 className="font-display text-2xl tracking-tight">{t("notFound")}</h1>
      <p className="max-w-sm text-sm text-fg-muted">{t("notFoundBody")}</p>
      <Link href="/" className="mt-2 text-sm text-fg-muted underline decoration-border underline-offset-4 hover:text-fg">
        {t("home")}
      </Link>
    </main>
  );
}
