"use client";

import {
  DeleteLinkButton,
  EditLinkButton,
  LinkToolbar,
  OpenLinkButton,
  useComponentsContext,
  type LinkToolbarProps,
} from "@blocknote/react";
import { AtSign, Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type MouseEvent } from "react";
import { TextSelection } from "prosemirror-state";
import { fetchLinkPreviewAction } from "@/app/actions/link-preview";
import { EMPTY_MENTION, linkedPageRef, linkMentionHref, linkMentionTitle, MENTION, type MentionProps } from "@/lib/mentions";
import { parseWebUrl } from "@/lib/web-blocks";
import { useEmbedHost } from "./database-embed";
import type { PageEditor } from "./embed-blocks";

/**
 * Links shown as mentions (lib/mentions, kind "link"): the site's icon, the page's title and the
 * site's name inline in the text. Made from a pasted link (web-blocks.tsx PasteLinkMenu) or from
 * a link already in the text (its toolbar's "Show as mention").
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

/**
 * Replaces the text from `from` to `to` (a link, or a pasted address) with a mention of `url`, and
 * puts the cursor after it. False when `url` isn't a web address, or a page of this app (those
 * become page mentions instead).
 */
export function linkToMention(editor: PageEditor, from: number, to: number, url: string): boolean {
  const href = parseWebUrl(url)?.href;
  if (!href || linkedPageRef(href, window.location.origin)) return false;
  editor.transact((tr) => {
    const node = tr.doc.type.schema.nodes[MENTION].create({ ...EMPTY_MENTION, kind: "link", url: href });
    tr.replaceWith(from, to, node);
    tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize));
  });
  return true;
}

/** The toolbar of a link in the text: BlockNote's buttons and, when `mentionable`, "Show as mention". */
export function LinkToolbarWithMention({ editor, mentionable: allowed, ...props }: LinkToolbarProps & { editor: PageEditor; mentionable: boolean }) {
  const t = useTranslations("page.mention");
  const Components = useComponentsContext()!;
  const href = parseWebUrl(props.url)?.href;
  const mentionable = allowed && Boolean(href && !linkedPageRef(href, window.location.origin));
  return (
    <LinkToolbar {...props}>
      <EditLinkButton
        url={props.url}
        text={props.text}
        range={props.range}
        setToolbarOpen={props.setToolbarOpen}
        setToolbarPositionFrozen={props.setToolbarPositionFrozen}
      />
      <OpenLinkButton url={props.url} />
      <DeleteLinkButton range={props.range} setToolbarOpen={props.setToolbarOpen} />
      {mentionable && (
        <Components.LinkToolbar.Button
          className="bn-button"
          label={t("showAsMention")}
          mainTooltip={t("showAsMention")}
          isSelected={false}
          onClick={() => {
            if (linkToMention(editor, props.range.from, props.range.to, props.url)) props.setToolbarOpen?.(false);
          }}
          icon={<AtSign size={16} />}
        />
      )}
    </LinkToolbar>
  );
}
