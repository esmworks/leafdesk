import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui";
import { describeUnsubscribe } from "@/server/dashboard-emails";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page.dashboard.emails.unsubscribePage");
  return { title: t("metaTitle"), robots: { index: false } };
}

/**
 * Where a dashboard email's unsubscribe link leads (server/dashboard-emails): no sign-in, the
 * link's signed token says who and what. Opening it changes nothing, since mail scanners open
 * links; the button posts to /api/dashboard-emails/unsubscribe, which comes back here done.
 */
export default async function DashboardEmailUnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string; done?: string }> }) {
  const { token, done } = await searchParams;
  const [t, found] = await Promise.all([getTranslations("page.dashboard.emails.unsubscribePage"), describeUnsubscribe(token)]);

  let body: React.ReactNode;
  if (!found) body = <p className="text-sm text-fg-muted">{t("invalid")}</p>;
  else if (done || !found.subscribed) {
    body = (
      <>
        <h1 className="text-lg font-semibold">{t("doneTitle")}</h1>
        <p className="text-sm text-fg-muted">{found.title ? t("done", { title: found.title }) : t("doneGone")}</p>
      </>
    );
  } else {
    body = (
      <form method="post" action="/api/dashboard-emails/unsubscribe" className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="from" value="page" />
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-sm text-fg-muted">{t("body", { title: found.title })}</p>
        <Button type="submit" variant="primary">
          {t("action")}
        </Button>
      </form>
    );
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-bg-subtle px-4 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo className="h-8 w-auto" />
        </div>
        <div className="space-y-2 rounded-xl border border-border bg-bg p-6 shadow-sm">{body}</div>
      </div>
    </main>
  );
}
