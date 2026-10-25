"use client";

import { iconPrefix } from "@/lib/icon-value";
import { IconGlyph } from "@/components/builtin-icon";
import { ExternalLink, Globe, Lock, Plus, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { removeSiteAction, saveSiteAction, setSiteListingAction, updateSiteOptionsAction } from "@/app/actions/site";
import { Button, IconButton, Input, selectClass, Switch, textareaClass } from "@/components/ui";
import {
  isAnalyticsId,
  isWebAddress,
  normalizeSiteDomain,
  SEARCH_DESCRIPTION_MAX,
  SITE_HEADER_LABEL_MAX,
  SITE_HEADER_LINKS_MAX,
  SITE_SLUG_MAX,
  SITE_THEMES,
  siteDomainProblem,
  siteSlugProblem,
  slugify,
  type SiteHeaderLink,
  type SiteTheme,
} from "@/lib/site";
import type { WorkspacePublication } from "@/server/publication";
import type { SiteOptions, WorkspaceSiteInfo } from "@/server/site";
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
          <div className="flex w-full items-center rounded-md border border-border bg-bg ps-2.5 text-sm focus-within:border-accent sm:w-60">
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
              className="h-8 min-w-0 flex-1 bg-transparent pe-2.5 outline-none"
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
                {iconPrefix(p.icon)}
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
        {p.icon ? <IconGlyph icon={p.icon} /> : <Globe className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
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

/** Saves some of the site's options; `saved` until they change again. */
function useSiteOptions(workspaceId: string) {
  const { pending, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const save = (patch: Partial<SiteOptions>, onSaved?: (site: WorkspaceSiteInfo) => void) => {
    setSaved(false);
    run(() => updateSiteOptionsAction(workspaceId, patch), (site) => {
      setSaved(true);
      onSaved?.(site);
    });
  };
  return { pending, error, saved, setSaved, save };
}

function SaveRow({ pending, error, saved, dirty, invalid }: { pending: boolean; error: string | null; saved: boolean; dirty: boolean; invalid?: boolean }) {
  const tc = useTranslations("common");
  return (
    <SettingsRow
      title=""
      description={error ? <span className="text-danger">{error}</span> : saved ? tc("saved") : undefined}
      control={
        <Button type="submit" variant="primary" disabled={pending || !dirty || invalid}>
          {pending ? tc("saving") : tc("save")}
        </Button>
      }
    />
  );
}

type LinkDraft = { label: string; target: string; url: string };
/** The select's value for a web address; page links use the page's id. */
const WEB = "web";

const toDraft = (link: SiteHeaderLink): LinkDraft =>
  "url" in link ? { label: link.label, target: WEB, url: link.url } : { label: link.label, target: link.pageId, url: "" };
const fromDraft = (draft: LinkDraft): SiteHeaderLink =>
  draft.target === WEB ? { label: draft.label.trim(), url: draft.url.trim() } : { label: draft.label.trim(), pageId: draft.target };
/** Links as text to compare, in one key order (the database keeps its own). */
const linksKey = (links: SiteHeaderLink[]) => JSON.stringify(links.map((l) => fromDraft(toDraft(l))));

/** Settings > Site, owners: the site's theme and the links in its header. */
export function SiteLook({ workspaceId, site, publications }: { workspaceId: string; site: WorkspaceSiteInfo; publications: WorkspacePublication[] }) {
  const t = useTranslations("settings.site");
  const tc = useTranslations("common");
  const [theme, setTheme] = useState<SiteTheme>(site.theme);
  const [links, setLinks] = useState<LinkDraft[]>(site.headerLinks.map(toDraft));
  const [stored, setStored] = useState({ theme: site.theme, links: linksKey(site.headerLinks) });
  const { pending, error, saved, setSaved, save } = useSiteOptions(workspaceId);
  // Header links lead to pages the site lists (their subpages are a click away in its navigation).
  const pages = publications.filter((p) => p.inSite && p.title !== null && !p.inTrash);
  const cleaned = links.map(fromDraft);
  const invalid = links.some((l) => !l.label.trim() || (l.target === WEB ? !isWebAddress(l.url.trim()) : !l.target));
  const dirty = theme !== stored.theme || linksKey(cleaned) !== stored.links;
  const change = (i: number, patch: Partial<LinkDraft>) => {
    setLinks((all) => all.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setSaved(false);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid || !dirty) return;
        save({ theme, headerLinks: cleaned }, (now) => setStored({ theme: now.theme, links: linksKey(now.headerLinks) }));
      }}
    >
      <SettingsRow
        anchor="siteTheme"
        title={t("themeLabel")}
        htmlFor="site-theme"
        description={t("themeHint")}
        control={
          <select
            id="site-theme"
            className={`${selectClass} w-full sm:w-60`}
            value={theme}
            onChange={(e) => {
              setTheme(e.target.value as SiteTheme);
              setSaved(false);
            }}
          >
            {SITE_THEMES.map((value) => (
              <option key={value} value={value}>
                {t(`themes.${value}`)}
              </option>
            ))}
          </select>
        }
      />
      <SettingsRow anchor="siteHeader" title={t("linksLabel")} description={t("linksHint", { max: SITE_HEADER_LINKS_MAX })}>
        <ul className="flex flex-col gap-2">
          {links.map((link, i) => {
            const badUrl = link.target === WEB && link.url.trim() !== "" && !isWebAddress(link.url.trim());
            return (
              <li key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  aria-label={t("linkLabel")}
                  placeholder={t("linkLabel")}
                  value={link.label}
                  maxLength={SITE_HEADER_LABEL_MAX}
                  className="w-full sm:w-44"
                  onChange={(e) => change(i, { label: e.target.value })}
                />
                <select
                  aria-label={t("linkTarget")}
                  className={`${selectClass} w-full sm:w-48`}
                  value={link.target}
                  onChange={(e) => change(i, { target: e.target.value })}
                >
                  <option value={WEB}>{t("linkWeb")}</option>
                  {/* A page taken out of the site stays picked; the site leaves the link out until it is listed again. */}
                  {link.target !== WEB && !pages.some((p) => p.pageId === link.target) && <option value={link.target}>{t("linkUnlisted")}</option>}
                  {pages.map((p) => (
                    <option key={p.pageId} value={p.pageId}>
                      {iconPrefix(p.icon)}
                      {p.title || tc("untitled")}
                    </option>
                  ))}
                </select>
                {link.target === WEB && (
                  <Input
                    aria-label={t("linkUrl")}
                    aria-invalid={badUrl || undefined}
                    placeholder="https://"
                    type="url"
                    value={link.url}
                    className={`w-full min-w-0 sm:flex-1 ${badUrl ? "border-danger" : ""}`}
                    onChange={(e) => change(i, { url: e.target.value })}
                  />
                )}
                <IconButton
                  type="button"
                  label={t("linkRemove")}
                  className="self-end sm:ms-auto sm:self-center"
                  onClick={() => {
                    setLinks((all) => all.filter((_, j) => j !== i));
                    setSaved(false);
                  }}
                >
                  <X className="h-4 w-4" />
                </IconButton>
              </li>
            );
          })}
        </ul>
        {links.length < SITE_HEADER_LINKS_MAX && (
          <Button
            type="button"
            size="sm"
            className={links.length ? "mt-3" : ""}
            onClick={() => {
              setLinks((all) => [...all, { label: "", target: pages[0]?.pageId ?? WEB, url: "" }]);
              setSaved(false);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("linkAdd")}
          </Button>
        )}
      </SettingsRow>
      <SaveRow pending={pending} error={error} saved={saved} dirty={dirty} invalid={invalid} />
    </form>
  );
}

/** Settings > Site, owners: what search engines and link previews say, and Google Analytics. */
export function SiteSearch({ workspaceId, site }: { workspaceId: string; site: WorkspaceSiteInfo }) {
  const t = useTranslations("settings.site");
  const [description, setDescription] = useState(site.description);
  const [analyticsId, setAnalyticsId] = useState(site.analyticsId ?? "");
  const [stored, setStored] = useState({ description: site.description, analyticsId: site.analyticsId ?? "" });
  const { pending, error, saved, setSaved, save } = useSiteOptions(workspaceId);
  const id = analyticsId.trim().toUpperCase();
  const badId = id !== "" && !isAnalyticsId(id);
  const dirty = description.trim() !== stored.description || id !== stored.analyticsId;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (badId || !dirty) return;
        save({ description, analyticsId: id || null }, (now) => {
          setStored({ description: now.description, analyticsId: now.analyticsId ?? "" });
          setDescription(now.description);
        });
      }}
    >
      <SettingsRow anchor="siteDescription" title={t("descriptionLabel")} htmlFor="site-description" description={t("descriptionHint")}>
        <textarea
          id="site-description"
          rows={2}
          maxLength={SEARCH_DESCRIPTION_MAX}
          value={description}
          className={textareaClass}
          onChange={(e) => {
            setDescription(e.target.value);
            setSaved(false);
          }}
        />
      </SettingsRow>
      <SettingsRow
        anchor="siteAnalytics"
        title={t("analyticsLabel")}
        htmlFor="site-analytics"
        description={badId ? <span className="text-danger">{t("errors.analyticsInvalid")}</span> : t("analyticsHint")}
        control={
          <Input
            id="site-analytics"
            value={analyticsId}
            placeholder="G-XXXXXXXXXX"
            spellCheck={false}
            autoCapitalize="characters"
            className="w-full sm:w-60"
            onChange={(e) => {
              setAnalyticsId(e.target.value);
              setSaved(false);
            }}
          />
        }
      />
      <SaveRow pending={pending} error={error} saved={saved} dirty={dirty} invalid={badId} />
    </form>
  );
}

/** Settings > Site, owners: a domain of the site's own, with what the server's operator sets up for it. */
export function SiteDomain({ workspaceId, site }: { workspaceId: string; site: WorkspaceSiteInfo }) {
  const t = useTranslations("settings.site");
  const [domain, setDomain] = useState(site.domain ?? "");
  const [stored, setStored] = useState(site.domain ?? "");
  const [appHost, setAppHost] = useState("");
  const { pending, error, saved, setSaved, save } = useSiteOptions(workspaceId);
  useEffect(() => setAppHost(window.location.hostname), []);
  const typed = domain.trim();
  const normalized = typed ? normalizeSiteDomain(typed) : null;
  const problem = typed ? (normalized ? siteDomainProblem(normalized, appHost) : "domainInvalid") : null;
  const dirty = (normalized ?? "") !== stored;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || !dirty) return;
        save({ domain: normalized }, (now) => {
          setStored(now.domain ?? "");
          setDomain(now.domain ?? "");
        });
      }}
    >
      <SettingsRow
        anchor="siteDomain"
        title={t("domainLabel")}
        htmlFor="site-domain"
        description={problem ? <span className="text-danger">{t(`errors.${problem}`)}</span> : t("domainHint")}
        control={
          <Input
            id="site-domain"
            value={domain}
            placeholder="docs.example.com"
            spellCheck={false}
            autoCapitalize="off"
            className="w-full sm:w-60"
            onChange={(e) => {
              setDomain(e.target.value);
              setSaved(false);
            }}
          />
        }
      >
        {stored && (
          <div className="flex items-center gap-1.5 text-sm">
            <a href={`https://${stored}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-accent hover:underline">
              {`https://${stored}`}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}
        <ol className="mt-2 list-decimal space-y-1 ps-5 text-sm text-fg-muted">
          <li>{t("domainStepDns", { host: appHost || "…" })}</li>
          <li>{t("domainStepProxy")}</li>
          <li>{t("domainStepOnly")}</li>
        </ol>
      </SettingsRow>
      <SaveRow pending={pending} error={error} saved={saved} dirty={dirty} invalid={problem !== null} />
    </form>
  );
}
