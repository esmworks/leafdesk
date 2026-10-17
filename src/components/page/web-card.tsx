"use client";

import { Globe } from "lucide-react";
import { useState } from "react";
import {
  displayHost,
  EMBED_ALLOW,
  EMBED_REFERRER_POLICY,
  EMBED_SANDBOX,
  type EmbedTarget,
  parseWebUrl,
} from "@/lib/web-blocks";

/**
 * How bookmarks and embeds look, in the editor and on published pages.
 *
 * Images (a page's preview image and icon) are loaded straight from the site they belong to, with
 * `referrerPolicy="no-referrer"`: the site learns an IP address and nothing about which page of
 * ours shows it. Proxying them through this server would hide the IP too, but it would make the
 * server fetch arbitrary URLs for every visitor; hotlinking keeps it to the one guarded fetch
 * when the bookmark is made.
 */

export type BookmarkView = { url: string; title: string; description: string; image: string; favicon: string };

/** An image from another site that disappears if it doesn't load. */
function RemoteImage({ src, className }: { src: string; className: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return null;
  return (
    <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className={className} onError={() => setFailed(src)} />
  );
}

export function BookmarkCard({ bookmark: given }: { bookmark: BookmarkView }) {
  // The editor hands over the block's props as the document holds them, and anyone who can edit a
  // page (or an MCP client) can write anything there: only web addresses become links and images.
  const bookmark = {
    ...given,
    url: parseWebUrl(given.url)?.href ?? "",
    image: parseWebUrl(given.image)?.href ?? "",
    favicon: parseWebUrl(given.favicon)?.href ?? "",
  };
  const host = displayHost(given.url);
  const [iconFailed, setIconFailed] = useState<string | null>(null);
  const showIcon = bookmark.favicon && iconFailed !== bookmark.favicon;
  return (
    <a
      href={bookmark.url || undefined}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="flex w-full min-w-0 overflow-hidden rounded-md border border-border text-fg no-underline transition-colors hover:bg-bg-hover"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1 px-3.5 py-3">
        <span className="truncate text-sm font-medium">{bookmark.title || host}</span>
        {bookmark.description && <span className="line-clamp-2 text-xs leading-snug text-fg-muted">{bookmark.description}</span>}
        <span className="mt-auto flex min-w-0 items-center gap-1.5 pt-1 text-xs text-fg-muted">
          {showIcon ? (
            <img
              src={bookmark.favicon}
              alt=""
              width={14}
              height={14}
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain"
              onError={() => setIconFailed(bookmark.favicon)}
            />
          ) : (
            <Globe className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">{host}</span>
        </span>
      </span>
      {bookmark.image && (
        <span className="relative hidden w-[32%] max-w-64 shrink-0 border-s border-border bg-bg-subtle sm:block">
          <RemoteImage src={bookmark.image} className="absolute inset-0 h-full w-full object-cover" />
        </span>
      )}
    </a>
  );
}

/** An allowlisted provider's page in a sandboxed iframe; `url` is the address that was pasted. */
export function EmbedFrame({ url, embed, title }: { url: string; embed: EmbedTarget; title: string }) {
  return (
    <div className="w-full">
      <div
        className="w-full overflow-hidden rounded-md border border-border bg-bg-subtle"
        style={embed.height ? { height: embed.height } : { aspectRatio: "16 / 9" }}
      >
        <iframe
          src={embed.src}
          title={title}
          sandbox={EMBED_SANDBOX}
          allow={EMBED_ALLOW}
          allowFullScreen
          referrerPolicy={EMBED_REFERRER_POLICY}
          loading="lazy"
          className="block h-full w-full border-0"
        />
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="mt-1 inline-block max-w-full truncate text-xs text-fg-muted no-underline hover:text-fg hover:underline"
      >
        {displayHost(url)}
      </a>
    </div>
  );
}
