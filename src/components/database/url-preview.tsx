"use client";

import { useEffect, useState } from "react";
import { urlPreviewAction } from "@/app/actions/link-preview";
import { BookmarkCard } from "@/components/page/web-card";
import type { UrlPreview } from "@/server/url-preview";

/**
 * The preview of the page a URL property links to, under the link on a row page, when the
 * property is set to show one (server/url-preview.ts). Loaded on its own (row-properties.tsx
 * imports it lazily), and asked for once per row, property and link in a tab.
 */

const loaded = new Map<string, UrlPreview | null>();

/** How long a changed link waits before its preview is asked for: the new value is saved first. */
const SETTLE_MS = 800;

export default function UrlPreviewCard({ rowId, propertyId, url }: { rowId: string; propertyId: string; url: string }) {
  const key = `${rowId}\n${propertyId}\n${url}`;
  const [found, setFound] = useState<{ key: string; preview: UrlPreview | null } | null>(null);
  useEffect(() => {
    if (loaded.has(key)) return;
    let live = true;
    const timer = setTimeout(() => {
      urlPreviewAction(rowId, propertyId)
        .then((res) => {
          // An answer for another link (the value changed meanwhile) waits for the next one.
          const preview = res.ok && res.data?.url === url ? res.data : null;
          if (res.ok && (!res.data || res.data.url === url)) loaded.set(key, preview);
          if (live) setFound({ key, preview });
        })
        .catch(() => {});
    }, SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, rowId, propertyId, url]);
  const preview = loaded.has(key) ? loaded.get(key) : found?.key === key ? found.preview : null;
  if (!preview) return null;
  return (
    <div className="px-2 pt-1 pb-1">
      <BookmarkCard bookmark={{ url: preview.url, title: preview.title, description: "", image: preview.image, favicon: preview.favicon }} />
    </div>
  );
}
