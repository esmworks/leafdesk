"use client";

import { ExternalLink, Globe, Lock } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { removeSiteAction, saveSiteAction, setSiteListingAction } from "@/app/actions/site";
import { Button, Input, selectClass, Switch } from "@/components/ui";
import { SITE_SLUG_MAX, siteSlugProblem, slugify } from "@/lib/site";
import type { WorkspacePublication } from "@/server/publication";
import type { WorkspaceSiteInfo } from "@/server/site";
import { SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

/**
 * Settings > Site: the workspace's site address, title and home page. Owners change them; members
 * see the address.
 */
export function SiteSettings({
  workspaceId,
  workspaceName,
  site,
  publications,
  canEdit,
}: {
  workspaceId: string;
  workspaceName: string;
  site: WorkspaceSiteInfo | null;
  /** Owners: the workspace's publications, to pick the home page from. */
  publications: WorkspacePublication[] | null;
  canEdit: boolean;
}) {
  const t = useTranslations("settings.site");
  const tc = useTranslations("common");
  const [slug, setSlug] = useState(site?.slug ?? slugify(workspaceName, SITE_SLUG_MAX));
  const [title, setTitle] = useState(site?.title ?? workspaceName);
  const [homePageId, setHomePageId] = useState(site?.homePageId ?? "");
  const [saved, setSaved] = useState(false);
  const [origin, setOrigin] = useState("");
  const { pending, error, run } = useAction();
  useEffect(() => setOrigin(window.location.origin), []);

  const clean = slug.trim().toLowerCase();
  const problem = clean ? siteSlugProblem(clean) : null;
  const homes = (publications ?? []).filter((p) => p.title !== null && !p.inTrash);
  const dirty = !site || clean !== site.slug || title.trim() !== site.title || (homePageId || null) !== site.homePageId;

  if (!canEdit) {
    return (
      <SettingsRow
        title={site ? t("slugLabel") : t("notSetUp")}
        description={site ? <>{`${origin}${site.url}`}</> : t("membersOnly")}
        control={
          site && (
            <a href={site.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-bg px-3 text-sm hover:bg-bg-hover">
              <ExternalLink className="h-3.5 w-3.5" />
              {t("open")}
            </a>
          )
        }
      />
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || !dirty) return;
        setSaved(false);
        run(() => saveSiteAction(workspaceId, { slug: clean, title, homePageId: homePageId || null }), () => setSaved(true));
      }}
    >
      {!site && <SettingsRow title={<span className="font-normal text-fg-muted">{t("notSetUp")}</span>} />}
      <SettingsRow
        title={t("slugLabel")}
        htmlFor="site-slug"
        description={problem ? <span className="text-danger">{t(`errors.${problem}`)}</span> : t("slugHint")}
        control={
          <div className="flex w-full items-center rounded-md border border-border bg-bg pl-2.5 text-sm focus-within:border-accent sm:w-60">
            <span className="shrink-0 text-fg-faint">/s/</span>
            <input
              id="site-slug"
              value={slug}
              maxLength={SITE_SLUG_MAX}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => {
                setSlug(e.target.value);
                setSaved(false);
              }}
              className="h-8 min-w-0 flex-1 bg-transparent pr-2.5 outline-none"
            />
          </div>
        }
      />
      <SettingsRow
        title={t("titleLabel")}
        htmlFor="site-title"
        description={t("titleHint")}
        control={
          <Input
            id="site-title"
            value={title}
            maxLength={80}
            className="w-full sm:w-60"
            onChange={(e) => {
              setTitle(e.target.value);
              setSaved(false);
            }}
          />
        }
      />
      <SettingsRow
        title={t("homeLabel")}
        htmlFor="site-home"
        description={t("homeHint")}
        control={
          <select
            id="site-home"
            className={`${selectClass} w-full sm:w-60`}
            value={homePageId}
            onChange={(e) => {
              setHomePageId(e.target.value);
              setSaved(false);
            }}
          >
            <option value="">{t("homeNone")}</option>
            {homes.map((p) => (
              <option key={p.pageId} value={p.pageId}>
                {p.icon ? `${p.icon} ` : ""}
                {p.title || tc("untitled")}
              </option>
            ))}
          </select>
        }
      />
      <SettingsRow
        title={site ? <span className="font-normal text-fg-muted">{`${origin}${site.url}`}</span> : ""}
        description={error ? <span className="text-danger">{error}</span> : saved ? tc("saved") : undefined}
        control={
          <>
            {site && (
              <>
                <a
                  href={site.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("open")}
                  title={t("open")}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
                <Button
                  disabled={pending}
                  onClick={() => {
                    if (confirm(t("confirmRemove"))) run(() => removeSiteAction(workspaceId), () => setSaved(false));
                  }}
                >
                  {t("remove")}
                </Button>
              </>
            )}
            <Button type="submit" variant="primary" disabled={pending || !dirty || problem !== null || !clean}>
              {pending ? tc("saving") : site ? t("save") : t("create")}
            </Button>
          </>
        }
      />
    </form>
  );
}

/** Settings > Site, owners: which published pages the site lists. */
export function SitePages({
  workspaceId,
  publications,
  homePageId,
}: {
  workspaceId: string;
  publications: WorkspacePublication[];
  homePageId: string | null;
}) {
  const t = useTranslations("settings.site");
  if (!publications.length) return <SettingsRow title={<span className="font-normal text-fg-muted">{t("pagesEmpty")}</span>} />;
  return publications
    .filter((p) => !p.inTrash)
    .map((p) => <SitePageRow key={p.pageId} workspaceId={workspaceId} publication={p} home={p.pageId === homePageId} />);
}

function SitePageRow({ workspaceId, publication: p, home }: { workspaceId: string; publication: WorkspacePublication; home: boolean }) {
  const t = useTranslations("settings.site");
  const tc = useTranslations("common");
  const [listed, setListed] = useState(p.inSite);
  const { pending, error, run } = useAction();
  const title =
    p.title === null ? (
      <span className="inline-flex items-center gap-1.5 text-fg-muted">
        <Lock className="h-3.5 w-3.5" />
        {t("privatePage")}
      </span>
    ) : (
      <Link href={`/w/${workspaceId}/p/${p.pageId}`} className="inline-flex min-w-0 items-center gap-1.5 hover:underline">
        {p.icon ? <span>{p.icon}</span> : <Globe className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
        <span className="truncate">{p.title || tc("untitled")}</span>
      </Link>
    );
  return (
    <SettingsRow
      title={title}
      description={error ? <span className="text-danger">{error}</span> : home ? t("home") : undefined}
      control={
        <Switch
          label={t("listed")}
          checked={listed}
          // Pages the owner can't see can be taken out, not listed.
          disabled={pending || (p.title === null && !listed)}
          onChange={(next) => {
            setListed(next);
            run(async () => {
              const result = await setSiteListingAction(workspaceId, p.pageId, next);
              if (!result.ok) setListed(!next);
              return result;
            });
          }}
        />
      }
    />
  );
}
