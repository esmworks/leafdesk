"use client";

import { createReactBlockSpec, type DefaultReactSuggestionItem } from "@blocknote/react";
import { Repeat2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { syncedPageAction } from "@/app/actions/mentions";
import { useChannel } from "@/components/collab/use-channel";
import { PageIcon, pageLabel } from "@/components/ui";
import { pagePath, syncedPageBlockConfig } from "@/lib/mentions";
import type { SyncedPageInfo } from "@/server/mentions";
import { useEmbedHost } from "./database-embed";
import type { PageEditor } from "./embed-blocks";
import { PageLinkCard, PageLinkHTML } from "./mentions";
import { useDocTitle, usePageDoc } from "./use-page-doc";
import { lazyPart } from "@/components/lazy-part";

/**
 * A synced page: another page's body inside this one, live. It is that page's own document, opened
 * with the reader's own access to it: people who may edit that page edit it right here (and see
 * everyone else's edits as they happen), people who may only view it read it, and people who can't
 * see it get what a page mention shows them ("No access"), never its title or text.
 *
 * Only the page's id is stored in this page (lib/mentions), so this page's Markdown, search, history
 * and AI review hold one line for it, and the page's text is indexed once, as its own.
 *
 * Pages can show each other (A shows B shows A), and nothing stops it being written that way (two
 * people, or MCP). So the guard is in showing it: each editor knows the pages around it, a page
 * already among them reads as a link with a note, and so does anything deeper than MAX_SYNCED_DEPTH.
 */

// Loaded on demand: the editor is a large module, and it imports this one.
const CollabEditor = lazyPart(() => import("./collab-editor").then((m) => m.default));

/** Synced pages show this many levels deep; deeper ones read as links to their page. */
export const MAX_SYNCED_DEPTH = 2;

/** What every editor tells the synced pages inside it. */
export type SyncedFrame = {
  /** The pages shown around this point, outermost first: the page itself and each synced page holding it. */
  chain: string[];
  user: { id: string; name: string };
  offline: boolean;
  /** This point is inside a synced block's blocks (see synced-block.tsx): synced blocks don't nest. */
  inSyncedBlock?: boolean;
};

const SyncedFrameContext = createContext<SyncedFrame | null>(null);
export const SyncedFrameProvider = SyncedFrameContext.Provider;
export const useSyncedFrame = () => useContext(SyncedFrameContext);

export const SyncedPageBlock = createReactBlockSpec(syncedPageBlockConfig, {
  // A self-contained widget, as database blocks are: its own editor takes the typing in it.
  meta: { selectable: false },
  render: function SyncedPageBlockView({ block }) {
    return block.props.pageId ? <SyncedPage pageId={block.props.pageId} /> : <div className="w-full" />;
  },
  // Copied to another app it is a link: the page's text is the page's own.
  toExternalHTML: function SyncedPageHTML({ block }) {
    return <PageLinkHTML pageId={block.props.pageId} />;
  },
});

function SyncedPage({ pageId }: { pageId: string }) {
  const t = useTranslations("page.syncedPage");
  const frame = useSyncedFrame();
  const host = useEmbedHost();
  const [info, setInfo] = useState<SyncedPageInfo | null>(null);
  const cycle = Boolean(frame?.chain.includes(pageId));
  const tooDeep = !frame || frame.chain.length > MAX_SYNCED_DEPTH;

  const load = useCallback(async () => {
    let next: SyncedPageInfo;
    try {
      next = await syncedPageAction(pageId);
    } catch {
      // Offline: keep what is shown (the document itself still opens from this browser's copy).
      return;
    }
    setInfo((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [pageId]);
  useEffect(() => {
    if (!cycle && !tooDeep) void load();
  }, [load, cycle, tooDeep]);

  // Sharing, moving, locking and the trash refresh the workspace's page tree: check access again.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useChannel(host && !cycle && !tooDeep ? `ws:${host.workspaceId}` : null, (event) => {
    if (event !== "tree") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 150);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  if (cycle) {
    return (
      <div contentEditable={false} className="w-full" data-synced-page="cycle">
        <PageLinkCard pageId={pageId} />
        <p className="flex items-center gap-1.5 px-1 text-xs text-fg-faint">
          <Repeat2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("cycle")}
        </p>
      </div>
    );
  }
  if (tooDeep || !frame) return <PageLinkCard pageId={pageId} />;
  if (!info) {
    return <div contentEditable={false} aria-busy="true" className="h-16 w-full animate-pulse rounded-md bg-bg-subtle" />;
  }
  // No access, in the trash or gone, and databases (no body to show): what a page link shows.
  if (info.status !== "ok" || info.kind !== "page") return <PageLinkCard pageId={pageId} />;
  return <SyncedBody info={info} frame={frame} />;
}

function SyncedBody({ info, frame }: { info: Extract<SyncedPageInfo, { status: "ok" }>; frame: SyncedFrame }) {
  const t = useTranslations("page.syncedPage");
  const tc = useTranslations("common");
  const { pageDoc, synced, connection, error } = usePageDoc(info.id);
  const title = useDocTitle(synced ? pageDoc?.doc : undefined, info.title);
  const editable = info.editable && synced && connection !== "noAccess";
  const crumbs = useMemo(() => [{ id: info.id, title, icon: info.icon, kind: info.kind }], [info.id, title, info.icon, info.kind]);
  const href = pagePath(info.workspaceId, info.id);
  return (
    <div contentEditable={false} className="leafdesk-synced w-full rounded-md border border-border" data-synced-page={info.id}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm">
        <Repeat2 className="h-3.5 w-3.5 shrink-0 text-fg-faint" aria-label={t("label")} />
        <Link href={href} className="flex min-w-0 items-center gap-1.5 rounded px-1 hover:bg-bg-hover">
          <PageIcon icon={info.icon} kind={info.kind} className="shrink-0 text-sm" />
          <span className="truncate font-medium">{pageLabel(title, tc("untitled"))}</span>
        </Link>
        <span className="flex-1" />
        {!info.editable && <span className="shrink-0 text-xs text-fg-faint">{t("viewOnly")}</span>}
      </div>
      {pageDoc && synced ? (
        <CollabEditor
          nested
          pageDoc={pageDoc}
          user={frame.user}
          editable={editable}
          level={info.level === "none" ? "view" : info.level}
          workspaceId={info.workspaceId}
          pageId={info.id}
          crumbs={crumbs}
          commentsOpen={false}
          onCloseComments={noop}
          offline={frame.offline}
        />
      ) : (
        <p className="px-3 py-2 text-sm text-fg-faint">{error ?? tc("loading")}</p>
      )}
    </div>
  );
}

/** The "Synced page" slash menu entry: picks the page to show at the block where it was chosen. */
export function useSyncedPageSlashItem(editor: PageEditor, onPick: (at: string) => void): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.blocks.syncedPage");
  return useMemo(
    () => [
      {
        title: t("title"),
        subtext: t("subtext"),
        aliases: t("aliases").split(" "),
        group: editor.dictionary.slash_menu.quote.group,
        icon: <Repeat2 size={18} />,
        onItemClick: () => onPick(editor.getTextCursorPosition().block.id),
      },
    ],
    [editor, t, onPick],
  );
}

const noop = () => {};
