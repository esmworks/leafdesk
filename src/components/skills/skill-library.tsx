"use client";

import { Download, LibraryBig, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { createBuiltinSkillAction, createSkillAction } from "@/app/actions/skills";
import { markNewPage } from "@/components/page/new-page-focus";
import { Button, cn, Dialog, Input, PageIcon, pageLabel } from "@/components/ui";
import type { BuiltinSkillKey } from "@/lib/builtin-skills";
import { searchFold } from "@/lib/search-fold";
import type { SkillSummary } from "@/server/skills";

export type BuiltinSkillItem = { key: BuiltinSkillKey; icon: string; title: string; description: string };

/**
 * The skills library (/w/[id]/skills): the workspace's skills, filtered as you type, and the
 * built-in ones to start from: in place of the list while there are none, behind a button after.
 */
export function SkillLibrary({
  workspaceId,
  skills,
  builtins,
  canCreate,
  exportable,
  now,
}: {
  workspaceId: string;
  skills: SkillSummary[];
  /** The built-in skills in their language (see lib/builtin-skills). */
  builtins: BuiltinSkillItem[];
  /** They may add pages at the top of the workspace: New skill makes a private one there. */
  canCreate: boolean;
  /** The workspace lets people export pages, so each skill offers its SKILL.md. */
  exportable: boolean;
  /** Render time from the server, so relative dates match between server and client render. */
  now: Date;
}) {
  const t = useTranslations("skills");
  const tc = useTranslations("common");
  const router = useRouter();
  const format = useFormatter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [galleryOpen, setGalleryOpen] = useState(false);
  const shown = useMemo(() => {
    const words = searchFold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return skills;
    return skills.filter((s) => {
      const text = searchFold(`${s.title} ${s.description} ${s.database?.title ?? ""}`);
      return words.every((w) => text.includes(w));
    });
  }, [skills, query]);

  const create = () =>
    startTransition(async () => {
      setError(null);
      const result = await createSkillAction(workspaceId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      markNewPage(result.data.id);
      router.push(`/w/${workspaceId}/p/${result.data.id}`);
    });

  // The new page has the built-in's title and text: it opens without focusing the title.
  const createBuiltin = (key: BuiltinSkillKey) =>
    startTransition(async () => {
      setError(null);
      const result = await createBuiltinSkillAction(workspaceId, key);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setGalleryOpen(false);
      router.push(`/w/${workspaceId}/p/${result.data.id}`);
    });

  return (
    <div className="mx-auto max-w-4xl px-4 pt-14 pb-12 md:px-6 md:pt-12">
      <header className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="text-2xl font-semibold tracking-tight">{t("heading")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-fg-muted">{t("description")}</p>
        </div>
        {canCreate && (
          <div className="flex flex-wrap gap-2">
            {skills.length > 0 && builtins.length > 0 && (
              <Button onClick={() => setGalleryOpen(true)} disabled={pending}>
                <LibraryBig className="h-4 w-4" /> {t("builtins.open")}
              </Button>
            )}
            <Button variant="primary" onClick={create} disabled={pending}>
              <Plus className="h-4 w-4" /> {t("new")}
            </Button>
          </div>
        )}
      </header>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      {skills.length === 0 && canCreate && builtins.length > 0 ? (
        <section aria-labelledby="builtin-skills-heading">
          <h2 id="builtin-skills-heading" className="text-base font-medium">
            {t("builtins.heading")}
          </h2>
          <p className="mt-1 text-sm text-fg-muted">{t("builtins.hint")}</p>
          <ul className={cn("mt-4 grid gap-3 sm:grid-cols-2", pending && "pointer-events-none opacity-60")} aria-busy={pending}>
            {builtins.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => createBuiltin(item.key)}
                  className="flex h-full w-full items-start gap-3 rounded-xl border border-border px-4 py-3 text-start hover:bg-bg-hover"
                >
                  <PageIcon icon={item.icon} kind="page" className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{item.title}</span>
                    <span className="mt-0.5 block text-sm text-fg-muted">{item.description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-fg-muted">{t("emptyHint")}</p>
        </section>
      ) : skills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-fg-muted">
          <p className="font-medium text-fg">{t("emptyTitle")}</p>
          <p className="mx-auto mt-1 max-w-md">{t("emptyHint")}</p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-0 flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
              <Input
                type="search"
                aria-label={t("search")}
                placeholder={t("search")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full ps-7"
              />
            </div>
            <span className="text-sm text-fg-muted" aria-live="polite">
              {t("count", { count: shown.length })}
            </span>
          </div>
          {shown.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">{t("noMatches")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {shown.map((skill) => (
                <li key={skill.id} className="group flex items-start gap-3 px-4 py-3 hover:bg-bg-hover">
                  <PageIcon icon={skill.icon} kind="page" className="mt-0.5 text-fg-muted" />
                  <div className="min-w-0 flex-1">
                    <Link href={`/w/${workspaceId}/p/${skill.id}`} className="font-medium hover:underline">
                      {pageLabel(skill.title, tc("untitled"))}
                    </Link>
                    <p className={skill.described ? "mt-0.5 line-clamp-2 text-sm text-fg-muted" : "mt-0.5 line-clamp-2 text-sm text-fg-faint"}>
                      {skill.description || t("noDescription")}
                    </p>
                    <p className="mt-1 text-xs text-fg-faint">
                      {skill.database && (
                        <>
                          <Link href={`/w/${workspaceId}/p/${skill.database.id}`} className="hover:text-fg hover:underline">
                            {t("inDatabase", { database: pageLabel(skill.database.title, tc("untitled")) })}
                          </Link>
                          {" · "}
                        </>
                      )}
                      <time dateTime={new Date(skill.updatedAt).toISOString()} title={format.dateTime(skill.updatedAt, { dateStyle: "medium", timeStyle: "short" })}>
                        {t("updated", { time: format.relativeTime(skill.updatedAt, now) })}
                      </time>
                    </p>
                  </div>
                  {exportable && (
                    <a
                      href={`/w/${workspaceId}/p/${skill.id}/export?format=skill`}
                      download
                      aria-label={t("download", { title: pageLabel(skill.title, tc("untitled")) })}
                      title={t("downloadHint")}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-active hover:text-fg"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <Dialog open={galleryOpen} onClose={() => setGalleryOpen(false)}>
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium">{t("builtins.heading")}</h2>
          <p className="mt-0.5 text-xs text-fg-muted">{t("builtins.hint")}</p>
        </div>
        {error && (
          <p role="alert" className="border-b border-border px-4 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        <ul className={cn("max-h-[60vh] overflow-y-auto p-1", pending && "pointer-events-none opacity-60")} aria-busy={pending}>
          {builtins.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => createBuiltin(item.key)}
                className="flex w-full items-start gap-2 rounded-md px-3 py-2 text-start hover:bg-bg-hover"
              >
                <PageIcon icon={item.icon} kind="page" className="mt-0.5 text-sm" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{item.title}</span>
                  <span className="block text-xs text-fg-muted">{item.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
