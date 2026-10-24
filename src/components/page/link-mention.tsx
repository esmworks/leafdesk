"use client";

import { Globe } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
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

export function LinkMentionChip({ props, onChange }: { props: MentionProps; onChange: ((next: Partial<MentionProps>) => void) | null }) {
  const host = useEmbedHost();
  const href = linkMentionHref(props);
  const favicon = parseWebUrl(props.favicon)?.href ?? "";
  const [iconFailed, setIconFailed] = useState<string | null>(null);
  const fetchNow = Boolean(onChange && host?.editable && href && !props.fetchedAt);

  useEffect(() => {
    if (!fetchNow || !host || !href || !onChange || fetching.has(href)) return;
    fetching.add(href);
    fetchLinkPreviewAction(host.pageId, href)
      .then((res) => {
        // Tried either way: a link that can't be read isn't fetched again on every visit.
        if (res.ok) onChange({ title: res.data.title, favicon: res.data.favicon, siteName: res.data.siteName, fetchedAt: res.data.fetchedAt });
        else onChange({ fetchedAt: new Date().toISOString() });
      })
      .catch(() => {})
      .finally(() => fetching.delete(href));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per link; onChange changes with every render
  }, [fetchNow, href, host?.pageId]);

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
      href={href ?? undefined}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={open}
      title={href ?? undefined}
      className="leafdesk-mention leafdesk-mention-page leafdesk-mention-link"
      data-mention-status={href ? "ok" : undefined}
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
