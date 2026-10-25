"use client";

import { Globe } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { fetchLinkPreviewAction } from "@/app/actions/link-preview";
import { linkMentionHref, linkMentionTitle } from "@/lib/link-mentions";
import type { MentionProps } from "@/lib/mentions";
import { parseWebUrl } from "@/lib/web-url";
import { useEmbedHost } from "./database-embed";

/**
 * Links shown as mentions (lib/mentions, kind "link"): the site's icon, the page's title and the
 * site's name inline in the text. Made from a pasted link (web-blocks.tsx PasteLinkMenu) or from
 * a link already in the text (its toolbar's "Show as mention"), both in link-mention-toolbar.tsx,
 * which only the editor loads: this file is part of every mention's spec.
 *
 * The details are fetched the way a bookmark's are, once, by the server's guarded fetch
 * (server/link-preview.ts), the first time someone who may edit the page sees the mention, and
 * stored in it. The icon is loaded from the site with no referrer (like bookmarks, web-card.tsx).
 */

/** Links whose details are being fetched in this tab, so each is fetched once at a time. */
const fetching = new Set<string>();

/**
 * What the card of a link mention (page-preview-card.tsx) asks of it, sent to its element:
 * fetch its details again, or become a bookmark.
 */
export const LINK_ACTION_EVENT = "leafdesk:link-action";
export type LinkAction = "refresh" | "bookmark";

export function LinkMentionChip({
  props,
  onChange,
  onBookmark,
}: {
  props: MentionProps;
  onChange: ((next: Partial<MentionProps>) => void) | null;
  onBookmark: ((element: HTMLElement) => void) | null;
}) {
  const host = useEmbedHost();
  const href = linkMentionHref(props);
  const favicon = parseWebUrl(props.favicon)?.href ?? "";
  const [iconFailed, setIconFailed] = useState<string | null>(null);
  const editable = Boolean(onChange && host?.editable && href);
  const fetchNow = editable && !props.fetchedAt;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const fetchDetails = useCallback(() => {
    const change = onChangeRef.current;
    if (!host || !href || !change || fetching.has(href)) return;
    fetching.add(href);
    fetchLinkPreviewAction(host.pageId, href)
      .then((res) => {
        // Tried either way: a link that can't be read isn't fetched again on every visit.
        if (res.ok) change({ title: res.data.title, favicon: res.data.favicon, siteName: res.data.siteName, fetchedAt: res.data.fetchedAt });
        else change({ fetchedAt: new Date().toISOString() });
      })
      .catch(() => {})
      .finally(() => fetching.delete(href));
  }, [host, href]);

  useEffect(() => {
    if (fetchNow) fetchDetails();
    // Once per link: not again as the host's other details change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchNow, href, host?.pageId]);

  const element = useRef<HTMLAnchorElement>(null);
  const bookmarkRef = useRef(onBookmark);
  bookmarkRef.current = onBookmark;
  useEffect(() => {
    const el = element.current;
    if (!el || !editable) return;
    const onAction = (event: Event) => {
      const action = (event as CustomEvent<LinkAction>).detail;
      if (action === "refresh") fetchDetails();
      else if (action === "bookmark") bookmarkRef.current?.(el);
    };
    el.addEventListener(LINK_ACTION_EVENT, onAction);
    return () => el.removeEventListener(LINK_ACTION_EVENT, onAction);
  }, [editable, fetchDetails]);

  const title = linkMentionTitle(props);
  const site = props.siteName.replace(/\s+/g, " ").trim();
  const open = (event: MouseEvent) => {
    // New tab and friends keep the browser's behaviour; a plain click opens a new tab too.
    if (!href || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.open(href, "_blank", "noopener,noreferrer");
  };
  return (
    <a
      ref={element}
      href={href ?? undefined}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={open}
      className="leafdesk-mention leafdesk-mention-page leafdesk-mention-link"
      data-mention-status={href ? "ok" : undefined}
      // For its card (page-preview.tsx): what it shows, and whether it can be changed here.
      data-link-mention=""
      data-link-site={site || undefined}
      data-link-icon={favicon || undefined}
      data-link-editable={editable && onBookmark ? "" : undefined}
    >
      {favicon && iconFailed !== favicon ? (
        <img
          src={favicon}
          alt=""
          width={14}
          height={14}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="leafdesk-mention-icon rounded-sm object-contain"
          onError={() => setIconFailed(favicon)}
        />
      ) : (
        <Globe className="leafdesk-mention-icon" aria-hidden />
      )}
      <span className="leafdesk-mention-label">{title}</span>
      {/* The site's name, unless the title already says it. */}
      {site && !title.toLocaleLowerCase().includes(site.toLocaleLowerCase()) && <span className="ms-1 text-[0.85em] text-fg-muted">{site}</span>}
    </a>
  );
}
