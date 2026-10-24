"use client";

import { Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { mentionedGroupAction } from "@/app/actions/mentions";
import { pagePreviewAction } from "@/app/actions/page-preview";
import { PageIcon, pageLabel } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { isRtl } from "@/components/direction";
import { formatIsoDate, isIsoDate } from "@/lib/mentions";
import type { PagePreview } from "@/lib/page-preview";
import { relativeTime } from "@/lib/relative-time";
import type { MentionedGroup } from "@/server/groups";
import type { PreviewTarget } from "./page-preview";

/**
 * The card page-preview.tsx opens on a page mention or link (the page's place, title, last edit
 * and first lines, or a row's first values) or on a group mention (who is in it). Loaded with the
 * first card. A page the reader can't open shows no card at all: the server says nothing about it.
 */

type Loaded = { kind: "page"; page: PagePreview } | { kind: "group"; group: MentionedGroup } | null;

/** Answers kept for a while, so going back and forth over links doesn't ask again each time. */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; answer: Promise<Loaded> }>();

function load(target: PreviewTarget): Promise<Loaded> {
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
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  useEffect(() => {
    let current = true;
    void load(target).then((answer) => current && setLoaded(answer));
    return () => {
      current = false;
    };
  }, [target]);

  useLayoutEffect(() => {
    if (!loaded) return;
    const rect = anchor.getBoundingClientRect();
    const height = card.current?.offsetHeight ?? 200;
    // Under the link from its start edge, or above it when there is no room below.
    const x = isRtl(anchor) ? rect.right - WIDTH : rect.left;
    const left = Math.max(8, Math.min(x, window.innerWidth - WIDTH - 8));
    const below = window.innerHeight - rect.bottom - GAP > height + 8 || rect.top < height + GAP + 8;
    setPosition(below ? { left, top: rect.bottom + GAP } : { left, bottom: window.innerHeight - rect.top + GAP });
  }, [anchor, loaded]);

  if (!loaded) return null;
  return createPortal(
    <div
      ref={card}
      role="tooltip"
      data-page-preview=""
      style={{ position: "fixed", width: WIDTH, left: position?.left ?? -9999, top: position?.top, bottom: position?.bottom }}
      className="z-50 rounded-lg border border-border bg-bg p-3 text-sm text-fg shadow-lg"
    >
      {loaded.kind === "page" ? <PageCard page={loaded.page} /> : <GroupCard group={loaded.group} />}
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
