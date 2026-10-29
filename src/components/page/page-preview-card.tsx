"use client";

import { Bookmark, Check, Globe, Link2, RefreshCw, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { mentionedGroupAction } from "@/app/actions/mentions";
import { pagePreviewAction } from "@/app/actions/page-preview";
import { PageIcon, pageLabel } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { usePlacement } from "@/components/use-placement";
import { formatIsoDate, isIsoDate } from "@/lib/mentions";
import type { PagePreview } from "@/lib/page-preview";
import { relativeTime } from "@/lib/relative-time";
import type { MentionedGroup } from "@/server/groups";
import { LINK_ACTION_EVENT, type LinkAction } from "./link-mention";
import { closePreview, type PreviewTarget } from "./page-preview";

/**
 * The card page-preview.tsx opens on a page mention or link (the page's place, title, last edit
 * and first lines, or a row's first values), on a group mention (who is in it) or on a link shown as
 * a mention (the link, read from the mention itself, and what can be done with it). Loaded with the
 * first card. A page the reader can't open shows no card at all: the server says nothing about it.
 */

type Loaded = { kind: "page"; page: PagePreview } | { kind: "group"; group: MentionedGroup } | { kind: "link" } | null;

/** Answers kept for a while, so going back and forth over links doesn't ask again each time. */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; answer: Promise<Loaded> }>();

function load(target: PreviewTarget): Promise<Loaded> {
  if (target.kind === "link") return Promise.resolve({ kind: "link" });
  const key = `${target.kind}:${target.id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.answer;
  const answer: Promise<Loaded> = (
    target.kind === "page"
      ? pagePreviewAction(target.id).then((page) => (page ? { kind: "page" as const, page } : null))
      : mentionedGroupAction(target.id).then((group) => (group ? { kind: "group" as const, group } : null))
  ).catch(() => {
    cache.delete(key);
    return null;
  });
  cache.set(key, { at: Date.now(), answer });
  return answer;
}

const WIDTH = 320;
const GAP = 6;
/** Members listed before "and N more". */
const MEMBERS_SHOWN = 8;

export default function PreviewCard({ anchor, target }: { anchor: HTMLElement; target: PreviewTarget }) {
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const card = useRef<HTMLDivElement>(null);
  // Under the link from its start edge, or above it when there is no room below.
  const style = usePlacement(card, anchor, !!loaded, { gap: GAP });

  useEffect(() => {
    let current = true;
    void load(target).then((answer) => current && setLoaded(answer));
    return () => {
      current = false;
    };
  }, [target]);

  if (!loaded) return null;
  return createPortal(
    <div
      ref={card}
      role={loaded.kind === "link" ? "group" : "tooltip"}
      data-page-preview=""
      style={{ ...style, position: "fixed", width: WIDTH }}
      className="z-50 rounded-lg border border-border bg-bg p-3 text-sm text-fg shadow-lg"
    >
      {loaded.kind === "page" ? <PageCard page={loaded.page} /> : loaded.kind === "group" ? <GroupCard group={loaded.group} /> : <LinkCard anchor={anchor} />}
    </div>,
    document.body,
  );
}

function PageCard({ page }: { page: PagePreview }) {
  const t = useTranslations("page.preview");
  const tc = useTranslations("common");
  const locale = useLocale();
  const when = relativeTime(page.editedAt, locale);
  return (
    <>
      {page.path.length > 0 && (
        <p className="mb-1 truncate text-xs text-fg-muted">{page.path.map((p) => pageLabel(p.title, tc("untitled"))).join(" / ")}</p>
      )}
      <p className="flex min-w-0 items-center gap-2 font-medium">
        <PageIcon icon={page.icon} kind={page.kind} className="shrink-0 text-base" />
        <span className="truncate">{pageLabel(page.title, tc("untitled"))}</span>
      </p>
      {page.properties.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1 text-xs">
          {page.properties.map((p) => (
            <div key={p.name} className="contents">
              <dt className="truncate text-fg-muted">{p.name}</dt>
              <dd className="truncate">{isIsoDate(p.value) ? formatIsoDate(p.value, locale) : p.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        page.excerpt && <p className="mt-2 line-clamp-4 whitespace-pre-line text-xs leading-relaxed text-fg-muted">{page.excerpt}</p>
      )}
      <p className="mt-2 truncate text-xs text-fg-faint">{page.editedBy ? t("editedBy", { name: page.editedBy, when }) : t("edited", { when })}</p>
    </>
  );
}

function GroupCard({ group }: { group: MentionedGroup }) {
  const t = useTranslations("page.preview");
  const shown = group.members.slice(0, MEMBERS_SHOWN);
  return (
    <>
      <p className="flex min-w-0 items-center gap-2 font-medium">
        <Users className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        <span className="truncate">{group.name}</span>
      </p>
      <p className="mt-0.5 text-xs text-fg-muted">{t("members", { count: group.members.length })}</p>
      {shown.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {shown.map((m) => (
            <li key={m.id} className="flex min-w-0 items-center gap-2 text-xs">
              <UserAvatar name={m.name} image={m.image} size="xs" />
              <span className="truncate">{m.name}</span>
            </li>
          ))}
        </ul>
      )}
      {group.members.length > shown.length && <p className="mt-1.5 text-xs text-fg-muted">{t("moreMembers", { count: group.members.length - shown.length })}</p>}
    </>
  );
}

/**
 * A link shown as a mention: its icon, title, site and address, as the mention holds them. Anyone
 * can copy the link; on a page they can edit, its details can be fetched again and the mention
 * can become a bookmark (both done by the mention, link-mention.tsx).
 */
function LinkCard({ anchor }: { anchor: HTMLElement }) {
  const t = useTranslations("page.mention");
  const [copied, setCopied] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);
  const href = anchor.getAttribute("href") ?? "";
  const title = anchor.querySelector(".leafdesk-mention-label")?.textContent?.trim() || href;
  const site = anchor.dataset.linkSite ?? "";
  const icon = anchor.dataset.linkIcon ?? "";
  const editable = anchor.dataset.linkEditable !== undefined;
  const act = (action: LinkAction) => {
    anchor.dispatchEvent(new CustomEvent<LinkAction>(LINK_ACTION_EVENT, { detail: action }));
    closePreview();
  };
  const button = "flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg";
  return (
    <>
      <p className="flex min-w-0 items-center gap-2 font-medium">
        {icon && !iconFailed ? (
          <img src={icon} alt="" width={16} height={16} referrerPolicy="no-referrer" className="h-4 w-4 shrink-0 rounded-sm object-contain" onError={() => setIconFailed(true)} />
        ) : (
          <Globe className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        )}
        <span className="truncate">{title}</span>
      </p>
      {site && <p className="mt-0.5 truncate text-xs text-fg-muted">{site}</p>}
      <p className="mt-1 truncate text-xs text-fg-faint" dir="ltr">
        {href}
      </p>
      <div className="-mx-1.5 mt-2 flex flex-wrap items-center gap-0.5 border-t border-border pt-1.5">
        <button
          type="button"
          className={button}
          onClick={() => {
            // A browser that refuses the clipboard leaves the button as it was.
            navigator.clipboard.writeText(href).then(
              () => setCopied(true),
              () => {},
            );
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
          {copied ? t("linkCopied") : t("copyLink")}
        </button>
        {editable && (
          <>
            <button type="button" className={button} onClick={() => act("refresh")}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t("refreshLink")}
            </button>
            <button type="button" className={button} onClick={() => act("bookmark")}>
              <Bookmark className="h-3.5 w-3.5" />
              {t("toBookmark")}
            </button>
          </>
        )}
      </div>
    </>
  );
}
