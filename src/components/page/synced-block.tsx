"use client";

import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { createReactBlockSpec, type DefaultReactSuggestionItem } from "@blocknote/react";
import { Copy, RefreshCw, Unlink } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { syncedReferencesAction, syncedSourcesAction } from "@/app/actions/synced-blocks";
import { useChannel } from "@/components/collab/use-channel";
import { PageIcon, pageLabel, Popover } from "@/components/ui";
import { pagePath } from "@/lib/mentions";
import {
  holdsSyncedSource,
  isSyncedSource,
  newSyncId,
  SYNCED_BLOCK,
  syncedBlockConfig,
  syncedBlocksIn,
  syncedFragmentName,
  syncedRefOf,
  withoutBlockIds,
  withoutSyncedBlocks,
  type SyncedRef,
} from "@/lib/synced-blocks";
import type { ShownSource, SyncedReferencePage, SyncedSource } from "@/server/synced-blocks";
import { useEmbedHost, type EmbedHost } from "./database-embed";
import type { PageEditor } from "./embed-blocks";
import { useSyncedFrame, type SyncedFrame } from "./synced-page";
import { usePageDoc } from "./use-page-doc";
import { lazyPart } from "@/components/lazy-part";

/**
 * Synced blocks in the editor (lib/synced-blocks): a group of blocks kept in one page and shown,
 * live, wherever a reference to it is pasted.
 *
 * The source shows an editor on its blocks' fragment of the page's own document (the one the page's
 * editor has open already). A reference opens its source page's document as the source page itself
 * would open for its reader (usePageDoc: the collab server decides, per reader, whether they may
 * read it and whether their edits count) and shows an editor on the same fragment. So someone who
 * may edit the source page edits the blocks in place, someone who may only view it reads them, and
 * someone who can't see it gets "No access" and nothing else: the reference opens nothing before
 * the server said the reader may see the page (syncedSourcesAction).
 *
 * Many references cost little: one server call answers for every source page the page shows blocks
 * of (they are asked for together, see loadSource), and references to the same page share its
 * document (and connection). Each reference still runs its own small editor.
 */

// Loaded on demand: the editor is a large module, and it imports this one.
const CollabEditor = lazyPart(() => import("./collab-editor").then((m) => m.default));

/** The clipboard form of a synced block: pasted into a page, it becomes a reference to it. */
const CLIPBOARD_ATTRIBUTE = "data-leafdesk-synced-block";

function parseSyncedElement(element: HTMLElement) {
  const value = element.getAttribute(CLIPBOARD_ATTRIBUTE);
  if (!value) return undefined;
  const [pageId, syncId] = value.split(" ");
  return syncedRefOf({ pageId, syncId }) ?? undefined;
}

export const SyncedBlockSpec = createReactBlockSpec(syncedBlockConfig, {
  // A self-contained widget, as synced pages are: its own editor takes the typing in it.
  meta: { selectable: false },
  render: function SyncedBlockRender({ block, editor }) {
    return <SyncedBlockView blockId={block.id} props={block.props} editor={editor as unknown as PageEditor} />;
  },
  parse: parseSyncedElement,
  // Copied out, it is the reference: pasted into a page of this app it shows the same blocks.
  toExternalHTML: function SyncedBlockHTML({ block }) {
    return <div {...{ [CLIPBOARD_ATTRIBUTE]: `${block.props.pageId} ${block.props.syncId}` }} />;
  },
});

function SyncedBlockView({ blockId, props, editor }: { blockId: string; props: unknown; editor: PageEditor }) {
  const host = useEmbedHost();
  const frame = useSyncedFrame();
  const ref = useMemo(() => syncedRefOf(props), [props]);
  if (!ref || !host || !frame) return <div className="w-full" />;
  // Synced blocks don't nest: one that got inside another anyway (dragged in, or written by an
  // older client) shows nothing of its own, and readers on the server drop it too.
  if (frame.inSyncedBlock) return <NestedNote editor={editor} blockId={blockId} editable={host.editable} />;
  return isSyncedSource(ref, host.pageId) ? (
    <SourceView syncRef={ref} host={host} frame={frame} />
  ) : (
    <ReferenceView syncRef={ref} host={host} frame={frame} editor={editor} blockId={blockId} />
  );
}

function NestedNote({ editor, blockId, editable }: { editor: PageEditor; blockId: string; editable: boolean }) {
  const t = useTranslations("page.syncedBlock");
  const tc = useTranslations("common");
  return (
    <div contentEditable={false} className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-fg-faint" data-synced-block="nested">
      <RefreshCw className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="flex-1">{t("nested")}</span>
      {editable && (
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
          onClick={() => {
            if (editor.getBlock(blockId)) editor.removeBlocks([blockId]);
          }}
        >
          {tc("remove")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The source

function SourceView({ syncRef, host, frame }: { syncRef: SyncedRef; host: EmbedHost; frame: SyncedFrame }) {
  const t = useTranslations("page.syncedBlock");
  const tc = useTranslations("common");
  // The page's own document: usePageDoc shares the one its editor has open.
  const { pageDoc, synced, error } = usePageDoc(host.pageId);
  const crumbs = useMemo(() => [], []);
  return (
    <div contentEditable={false} className="leafdesk-synced w-full rounded-md border border-accent/40" data-synced-block="source">
      <div className="flex items-center gap-2 border-b border-accent/20 px-3 py-1 text-xs text-fg-muted">
        <RefreshCw className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
        <span className="font-medium">{t("label")}</span>
        <ReferencesButton syncRef={syncRef} workspaceId={host.workspaceId} />
        <span className="flex-1" />
        <CopyButton syncRef={syncRef} />
      </div>
      {pageDoc && synced ? (
        <CollabEditor
          nested
          syncedBlock
          fragment={syncedFragmentName(syncRef.syncId)}
          pageDoc={pageDoc}
          user={frame.user}
          editable={host.editable}
          // Comments anchor in the page body; inside a synced block they'd have nothing to hold on to.
          level="view"
          workspaceId={host.workspaceId}
          pageId={host.pageId}
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

/** "Shown on 2 other pages": the pages holding a reference, as far as the reader can see them. */
function ReferencesButton({ syncRef, workspaceId }: { syncRef: SyncedRef; workspaceId: string }) {
  const t = useTranslations("page.syncedBlock");
  const tc = useTranslations("common");
  const [list, setList] = useState<{ pages: SyncedReferencePage[]; hidden: number } | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await syncedReferencesAction(syncRef.pageId, syncRef.syncId);
      setList((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    } catch {
      // Offline: keep what is shown.
    }
  }, [syncRef.pageId, syncRef.syncId]);
  useEffect(() => void load(), [load]);
  // References are indexed when the pages holding them are saved: the tree channel hears of new pages.
  useChannel(`ws:${workspaceId}`, (event) => {
    if (event === "tree") void load();
  });
  if (!list) return null;
  const count = list.pages.length + list.hidden;
  return (
    <Popover
      align="start"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={() => {
            void load();
            toggle();
          }}
          className="rounded px-1 py-0.5 text-fg-faint hover:bg-bg-hover hover:text-fg"
          data-synced-references={count}
        >
          {count ? t("shownOn", { count }) : t("notShownShort")}
        </button>
      )}
      className="w-64"
    >
      {count === 0 ? (
        <p className="px-2 py-1.5 text-sm text-fg-faint">{t("notShown")}</p>
      ) : (
        <ul className="max-h-64 overflow-auto">
          {list.pages.map((p) => (
            <li key={p.id}>
              <Link href={pagePath(p.workspaceId, p.id)} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-bg-hover">
                <PageIcon icon={p.icon} kind={p.kind} className="shrink-0" />
                <span className="truncate">{pageLabel(p.title, tc("untitled"))}</span>
              </Link>
            </li>
          ))}
          {list.hidden > 0 && <li className="px-2 py-1.5 text-xs text-fg-faint">{t("hiddenPages", { count: list.hidden })}</li>}
        </ul>
      )}
    </Popover>
  );
}

/** Puts the reference on the clipboard; pasted into a page, it shows these blocks there. */
function CopyButton({ syncRef }: { syncRef: SyncedRef }) {
  const t = useTranslations("page.syncedBlock");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => void copySyncedBlock(syncRef, t("label")).then(setCopied)}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
      title={t("copyHint")}
    >
      <Copy className="h-3.5 w-3.5" aria-hidden />
      {copied ? t("copied") : t("copy")}
    </button>
  );
}

/** The clipboard holds the reference as HTML (and, for other apps, the block's name as text). */
export async function copySyncedBlock(ref: SyncedRef, label: string): Promise<boolean> {
  const html = `<div ${CLIPBOARD_ATTRIBUTE}="${ref.pageId} ${ref.syncId}">${escapeHtml(label)}</div>`;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([label], { type: "text/plain" }) }),
    ]);
    return true;
  } catch {
    // Without the async clipboard (or its permission): the copy event can still carry HTML.
    let done = false;
    const onCopy = (event: ClipboardEvent) => {
      event.preventDefault();
      event.clipboardData?.setData("text/html", html);
      event.clipboardData?.setData("text/plain", label);
      done = true;
    };
    document.addEventListener("copy", onCopy, { once: true });
    document.execCommand("copy");
    document.removeEventListener("copy", onCopy);
    return done;
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------------------------------------
// A reference

type Loaded = { at: number; promise: Promise<SyncedSource> };
const sources = new Map<string, Loaded>();
let pending: Map<string, { resolve: (s: SyncedSource) => void; reject: (e: unknown) => void }[]> | null = null;
/** What a reference shows is asked again after this long, or at once after the tree changed. */
const SOURCE_TTL_MS = 5000;

/**
 * The source page as this reader may know it. The references of a page mount together: their
 * questions go to the server in one call, and references to the same page share the answer.
 */
function loadSource(pageId: string, fresh = false): Promise<SyncedSource> {
  const cached = sources.get(pageId);
  if (cached && !fresh && Date.now() - cached.at < SOURCE_TTL_MS) return cached.promise;
  const promise = new Promise<SyncedSource>((resolve, reject) => {
    if (!pending) {
      pending = new Map();
      queueMicrotask(flush);
    }
    const waiting = pending.get(pageId) ?? [];
    waiting.push({ resolve, reject });
    pending.set(pageId, waiting);
  });
  sources.set(pageId, { at: Date.now(), promise });
  // A failed call isn't kept: the next reference asks again.
  promise.catch(() => {
    if (sources.get(pageId)?.promise === promise) sources.delete(pageId);
  });
  return promise;
}

function flush() {
  const batch = pending;
  pending = null;
  if (!batch) return;
  syncedSourcesAction([...batch.keys()]).then(
    (list) => {
      const byId = new Map(list.map((s) => [s.pageId, s]));
      for (const [pageId, waiting] of batch) {
        const source = byId.get(pageId) ?? ({ pageId, state: "deleted" } as const);
        for (const w of waiting) w.resolve(source);
      }
    },
    (error) => {
      for (const waiting of batch.values()) for (const w of waiting) w.reject(error);
    },
  );
}

function useSource(pageId: string, workspaceId: string) {
  const [source, setSource] = useState<SyncedSource | null>(null);
  const load = useCallback(
    async (fresh = false) => {
      try {
        const next = await loadSource(pageId, fresh);
        setSource((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      } catch {
        // Offline: keep what is shown.
      }
    },
    [pageId],
  );
  useEffect(() => void load(), [load]);
  // Sharing, moving, locking and the trash refresh the workspace's page tree: ask again.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useChannel(`ws:${workspaceId}`, (event) => {
    if (event !== "tree") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(true), 150);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return source;
}

/** Whether the source page's body (as open in `doc`) still holds the synced block, live. */
function useHoldsSource(doc: Y.Doc | undefined, ref: SyncedRef) {
  const { pageId, syncId } = ref;
  const store = useMemo(() => {
    // A walk of the body's elements, without converting any blocks; again shortly after changes.
    let value = doc ? holdsSyncedSource(doc, pageId, syncId) : true;
    return {
      get: () => value,
      subscribe(notify: () => void) {
        if (!doc) return () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onUpdate = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            const next = holdsSyncedSource(doc, pageId, syncId);
            if (next === value) return;
            value = next;
            notify();
          }, 100);
        };
        doc.on("update", onUpdate);
        return () => {
          clearTimeout(timer);
          doc.off("update", onUpdate);
        };
      },
    };
  }, [doc, pageId, syncId]);
  return useSyncExternalStore(store.subscribe, store.get, () => true);
}

function ReferenceView({
  syncRef,
  host,
  frame,
  editor,
  blockId,
}: {
  syncRef: SyncedRef;
  host: EmbedHost;
  frame: SyncedFrame;
  editor: PageEditor;
  blockId: string;
}) {
  const source = useSource(syncRef.pageId, host.workspaceId);
  if (!source) return <div contentEditable={false} aria-busy="true" className="h-16 w-full animate-pulse rounded-md bg-bg-subtle" />;
  if (source.state === "noAccess" || source.state === "deleted" || source.state === "trashed") {
    return <StateNote state={source.state} />;
  }
  return <ReferenceBody syncRef={syncRef} source={source as ShownSource} host={host} frame={frame} editor={editor} blockId={blockId} />;
}

function StateNote({ state }: { state: "noAccess" | "deleted" | "trashed" | "removed" }) {
  const t = useTranslations("page.syncedBlock");
  return (
    <div
      contentEditable={false}
      className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-fg-faint"
      data-synced-block={state}
    >
      <RefreshCw className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t(`state.${state}`)}</span>
    </div>
  );
}

function ReferenceBody({
  syncRef,
  source,
  host,
  frame,
  editor,
  blockId,
}: {
  syncRef: SyncedRef;
  source: ShownSource;
  host: EmbedHost;
  frame: SyncedFrame;
  editor: PageEditor;
  blockId: string;
}) {
  const t = useTranslations("page.syncedBlock");
  const tc = useTranslations("common");
  const { pageDoc, synced, connection, error } = usePageDoc(source.pageId);
  const holds = useHoldsSource(synced ? pageDoc?.doc : undefined, syncRef);
  const crumbs = useMemo(() => [], []);
  // The server turned the document down after all (access changed meanwhile): nothing of it shows.
  if (connection === "noAccess") return <StateNote state="noAccess" />;
  if (synced && !holds) return <StateNote state="removed" />;
  const editable = source.state === "editable" && synced;
  const unsync = () => {
    if (!pageDoc || !editor.getBlock(blockId)) return;
    // A plain copy of the blocks as they are now, with new ids, in the reference's place.
    const blocks = withoutBlockIds(withoutSyncedBlocks(yXmlFragmentToBlocks(editor, pageDoc.doc.getXmlFragment(syncedFragmentName(syncRef.syncId)))));
    editor.replaceBlocks([blockId], blocks.length ? (blocks as Parameters<PageEditor["replaceBlocks"]>[1]) : [{ type: "paragraph" }]);
  };
  return (
    <div contentEditable={false} className="leafdesk-synced w-full rounded-md border border-accent/40" data-synced-block="reference">
      <div className="flex items-center gap-2 border-b border-accent/20 px-3 py-1 text-xs text-fg-muted">
        <RefreshCw className="h-3.5 w-3.5 shrink-0 text-accent" aria-label={t("label")} />
        <span className="shrink-0">{t("from")}</span>
        <Link href={pagePath(source.workspaceId, source.pageId)} className="flex min-w-0 items-center gap-1 rounded px-1 hover:bg-bg-hover hover:text-fg">
          <PageIcon icon={source.icon} kind={source.kind} className="shrink-0" />
          <span className="truncate font-medium">{pageLabel(source.title, tc("untitled"))}</span>
        </Link>
        <span className="flex-1" />
        {source.state !== "editable" && <span className="shrink-0 whitespace-nowrap text-fg-faint">{t("viewOnly")}</span>}
        <CopyButton syncRef={syncRef} />
        {host.editable && (
          <button
            type="button"
            onClick={unsync}
            disabled={!synced}
            title={t("unsyncHint")}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50"
          >
            <Unlink className="h-3.5 w-3.5" aria-hidden />
            {t("unsync")}
          </button>
        )}
      </div>
      {pageDoc && synced ? (
        <CollabEditor
          nested
          syncedBlock
          fragment={syncedFragmentName(syncRef.syncId)}
          pageDoc={pageDoc}
          user={frame.user}
          editable={editable}
          level="view"
          workspaceId={source.workspaceId}
          pageId={source.pageId}
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

// ---------------------------------------------------------------------------------------------
// Making one, pasting one

/**
 * Puts blocks into a new synced block of the page, in their place: the blocks go into the synced
 * block's fragment of the page's document, then the synced block replaces them. Refuses (returns
 * false) blocks holding a synced block: they don't nest.
 */
export function turnIntoSyncedBlock(editor: PageEditor, doc: Y.Doc, pageId: string, blockIds: string[]): boolean {
  const blocks = blockIds.map((id) => editor.getBlock(id)).filter((b): b is NonNullable<typeof b> => b !== undefined);
  if (!blocks.length || syncedBlocksIn(blocks).length) return false;
  const syncId = newSyncId();
  doc.transact(() => blocksToYXmlFragment(editor, blocks, doc.getXmlFragment(syncedFragmentName(syncId))));
  editor.replaceBlocks(
    blocks.map((b) => b.id),
    [{ type: SYNCED_BLOCK, props: { pageId, syncId } }],
  );
  return true;
}

/** A new, empty synced block (with one paragraph to type in) at the block where "/" was typed. */
export function newSyncedBlock(editor: PageEditor, doc: Y.Doc, pageId: string) {
  const syncId = newSyncId();
  doc.transact(() => blocksToYXmlFragment(editor, [{ type: "paragraph" } as never], doc.getXmlFragment(syncedFragmentName(syncId))));
  return { type: SYNCED_BLOCK, props: { pageId, syncId } } as const;
}

/**
 * Paste: a synced block copied with "Copy synced block" becomes a reference to it where the cursor
 * is. Inside a synced block, pasting one (or a copied source) is refused (`onRefused`) and nothing
 * lands. Returns undefined for every other paste (BlockNote's own handling).
 */
export function pasteSyncedBlock(event: ClipboardEvent, editor: PageEditor, inSyncedBlock: boolean, onRefused: () => void): boolean | undefined {
  const html = event.clipboardData?.getData("text/html") ?? "";
  const internal = event.clipboardData?.getData("blocknote/html") ?? "";
  const holdsSynced = html.includes(CLIPBOARD_ATTRIBUTE) || internal.includes(`data-content-type="${SYNCED_BLOCK}"`);
  if (!holdsSynced) return undefined;
  if (inSyncedBlock) {
    onRefused();
    return true;
  }
  // Blocks copied in the editor itself go through BlockNote's own paste (a source among them
  // lands as a reference on another page, see lib/synced-blocks).
  if (internal) return undefined;
  const refs = [...new DOMParser().parseFromString(html, "text/html").querySelectorAll<HTMLElement>(`[${CLIPBOARD_ATTRIBUTE}]`)]
    .map((element) => parseSyncedElement(element))
    .filter((ref) => ref !== undefined);
  if (!refs.length) return undefined;
  const blocks = refs.map((ref) => ({ type: SYNCED_BLOCK, props: ref }) as const);
  const current = editor.getTextCursorPosition().block;
  const empty = current.type === "paragraph" && Array.isArray(current.content) && current.content.length === 0;
  const placed = empty ? editor.replaceBlocks([current.id], blocks).insertedBlocks : editor.insertBlocks(blocks, current, "after");
  const last = placed[placed.length - 1];
  const next = last ? editor.getNextBlock(last) : undefined;
  if (last) editor.setTextCursorPosition(next ?? editor.insertBlocks([{ type: "paragraph" }], last, "after")[0], "start");
  return true;
}

/** The "Synced block" slash menu entry, where synced blocks may go (not inside one). */
export function useSyncedBlockSlashItem(editor: PageEditor, doc: Y.Doc, onPlace: (at: string, block: ReturnType<typeof newSyncedBlock>) => void): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.blocks.syncedBlock");
  const host = useEmbedHost();
  const frame = useSyncedFrame();
  return useMemo(() => {
    if (!host?.editable || frame?.inSyncedBlock) return [];
    return [
      {
        title: t("title"),
        subtext: t("subtext"),
        aliases: t("aliases").split(" "),
        group: editor.dictionary.slash_menu.quote.group,
        icon: <RefreshCw size={18} />,
        onItemClick: () => onPlace(editor.getTextCursorPosition().block.id, newSyncedBlock(editor, doc, host.pageId)),
      },
    ];
  }, [editor, doc, host, frame?.inSyncedBlock, t, onPlace]);
}

const noop = () => {};
