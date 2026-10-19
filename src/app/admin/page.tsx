import { ArrowLeft, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AdminSessionControls, AdminUsersTable } from "@/components/admin/admin-panel";
import { SettingsGroup, SettingsHeader, SettingsRow } from "@/components/settings/section";
import { Input } from "@/components/ui";
import { env } from "@/lib/env";
import { firstAdminId } from "@/server/first-admin";
import { checkInstanceAdmin, countLiveSessions, listInstanceUsers } from "@/server/instance-admin";
import { mailStatus } from "@/server/mail";
import { listWorkspaces } from "@/server/pages";
import { getSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("metaTitle") };
}

/**
 * The instance admin page: the server's accounts, signing them out and asking them for a new
 * password (see server/instance-admin.ts), and how workspace creation and sign-up are set. Only for
 * the addresses in ADMIN_EMAILS and the server's first account; everyone else, signed in or not,
 * gets a 404, so the page gives nothing away. Outside /w/ like the account page, so no workspace
 * policy stands in the way.
 *
 * `?q=` searches names and emails (a plain form, on the server); `?from=<workspace id>` is where
 * "Back" goes.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, query] = await Promise.all([getSession(), searchParams]);
  if (!session || !(await checkInstanceAdmin(session))) notFound();
  const q = typeof query.q === "string" ? query.q : "";
  const [{ users, total }, liveSessions, workspaces, t, firstAdmin] = await Promise.all([
    listInstanceUsers(session, q),
    countLiveSessions(session),
    listWorkspaces(session.user.id),
    getTranslations("admin"),
    firstAdminId(),
  ]);
  const from = workspaces.find((w) => w.id === query.from) ?? workspaces[0];
  const emailReset = mailStatus() === "smtp";

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <nav
        aria-label={t("title")}
        // In the sidebar's place, so the desktop app keeps its window buttons clear of it the same way (globals.css).
        data-sidebar
        data-sidebar-open
        className="shrink-0 border-b border-border p-2 text-sm md:sticky md:top-0 md:h-dvh md:w-60 md:overflow-y-auto md:border-e md:border-b-0 md:bg-bg-subtle"
      >
        <Link
          href={from ? `/w/${from.id}` : "/"}
          className="mb-2 flex h-7 items-center gap-2 rounded-md px-2 text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4 shrink-0 rtl:-scale-x-100" aria-hidden />
          <span className="truncate">{from ? t("back", { workspace: from.name }) : t("backHome")}</span>
        </Link>
        <div className="px-2 pt-1 pb-1 text-xs font-medium text-fg-muted">{t("title")}</div>
      </nav>

      <main className="min-w-0 flex-1 px-4 py-8 sm:px-8 md:py-12">
        <div className="mx-auto max-w-5xl">
          <SettingsHeader title={t("title")} description={firstAdmin === session.user.id ? t("descriptionFirstAccount") : t("description")} />
          <div className="space-y-10">
            <SettingsGroup title={t("workspaces.heading")}>
              <SettingsRow
                title={env.workspaceCreation === "admins" ? t("workspaces.admins") : t("workspaces.everyone")}
                description={t("workspaces.description")}
              />
            </SettingsGroup>

            <SettingsGroup title={t("signUp.heading")}>
              <SettingsRow
                title={env.signUpDisabled ? t("signUp.closed") : t("signUp.open")}
                description={env.signUpDisabled ? t("signUp.closedDescription") : t("signUp.openDescription")}
              />
            </SettingsGroup>

            <SettingsGroup title={t("sessions.heading")} description={t("sessions.description", { count: liveSessions })}>
              <AdminSessionControls emailReset={emailReset} />
            </SettingsGroup>

            <section className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-semibold">{t("users.heading")}</h2>
                  <p className="mt-1 text-sm text-fg-muted">
                    {users.length < total
                      ? t("users.countPartial", { shown: users.length, total })
                      : t("users.count", { count: total })}
                  </p>
                </div>
                <form role="search" action="/admin" className="relative">
                  {from && <input type="hidden" name="from" value={from.id} />}
                  <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
                  <Input
                    type="search"
                    name="q"
                    defaultValue={q}
                    aria-label={t("users.search")}
                    placeholder={t("users.search")}
                    className="w-56 ps-7 sm:w-72"
                  />
                </form>
              </div>
              <AdminUsersTable users={users} currentUserId={session.user.id} emailReset={emailReset} now={new Date()} query={q} />
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
