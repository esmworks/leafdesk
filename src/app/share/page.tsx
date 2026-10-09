import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/brand/logo";
import { QuickNoteForm } from "@/components/share/quick-note-form";
import { decodeSharedNote, SHARED_COOKIE } from "@/lib/shared-note";
import { listWorkspaces } from "@/server/pages";
import { requireUser } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page.quickNote");
  return { title: t("documentTitle"), robots: { index: false } };
}

const param = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() ?? "";

/**
 * A quick note: a private page in one of the person's workspaces. The installed app opens it from
 * its shortcut, and from the system's share sheet with what was shared filled in: brought by a
 * cookie (see app/api/share), or as `title`, `text` and `url` in the address from an app installed
 * before shares were posted.
 */
export default async function QuickNotePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [user, query, jar, t] = await Promise.all([requireUser(), searchParams, cookies(), getTranslations("page.quickNote")]);
  const workspaces = await listWorkspaces(user.id);
  if (!workspaces.length) redirect("/");
  const shared = decodeSharedNote(jar.get(SHARED_COOKIE)?.value) ?? {
    title: param(query.title),
    text: param(query.text),
    url: param(query.url),
  };
  const { text, url } = shared;
  // Apps often put the link in the text too.
  const body = [text, url && !text.includes(url) ? url : ""].filter(Boolean).join("\n\n");
  const chosen = workspaces.find((w) => w.id === param(query.workspace)) ?? workspaces[0];

  return (
    <main className="flex min-h-full justify-center bg-bg-subtle px-4 py-10 sm:py-16">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex justify-center">
          <Logo className="h-7 w-auto" />
        </div>
        <div className="rounded-xl border border-border bg-bg p-5 shadow-sm sm:p-6">
          <h1 className="text-lg font-semibold">{t("heading")}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t("description")}</p>
          <QuickNoteForm
            workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
            workspaceId={chosen.id}
            title={shared.title}
            body={body}
          />
        </div>
      </div>
    </main>
  );
}
