"use client";

import { LayoutTemplate, Lock, Paintbrush, RotateCcw, SmilePlus } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition, type ReactNode, type RefObject } from "react";
import {
  archivePageAction,
  deletePagePermanentlyAction,
  restorePageAction,
  setPageBackgroundAction,
  setPageIconAction,
} from "@/app/actions/pages";
import { setPageLockedAction } from "@/app/actions/page-menu";
import { createRowAction } from "@/app/actions/databases";
import { createFromTemplateAction } from "@/app/actions/templates";
import { Button, cn, PageIcon, pageLabel } from "@/components/ui";
import type { PageKind } from "@/db/schema/app";
import { SidebarOpenButton } from "@/components/sidebar/sidebar-context";
import type { PageHeaderInfo } from "@/server/page-meta";
import { DocumentViewContext } from "./document-title";
import { HistoryPanel } from "./history-panel";
import { IconPicker } from "./icon-picker";
import { BackgroundPicker } from "./page-background";
import { backdropClass } from "./page-backdrop";
import { Backlinks } from "./mentions";
import { takeNewPage } from "./new-page-focus";
import { hasLevel, PageHeaderActions } from "./page-header-actions";
import { setDocTitle, useDocTitle, usePageDoc, usePageStyle, type ConnectionState } from "./use-page-doc";
import { usePagePresence } from "./use-presence";
import { useIsOffline, useOffline } from "@/components/offline/offline-context";
import { DarkScheme } from "@/components/theme/theme-provider";
import { rememberPage } from "@/components/offline/offline-store";
import { PAGE_HEADER_EVENT } from "@/lib/collab-constants";
import type { PageBackground } from "@/lib/page-background";
import { DEFAULT_PAGE_STYLE, pageTextClasses, writePageStyle, type PageStyle } from "@/lib/page-style";

// BlockNote touches `window` during setup; render it only in the browser.
const CollabEditor = dynamic(() => import("./collab-editor"), { ssr: false });
// Loaded when it opens: the graph brings its renderer.
const LocalGraphPanel = dynamic(() => import("@/components/graph/local-graph-panel").then((m) => m.LocalGraphPanel), { ssr: false });

type Crumb = { id: string; title: string; icon: string | null; kind: PageKind };

export function PageView({
  workspaceId,
  page,
  info,
  crumbs,
  user,
  showBody,
  wide,
  style = DEFAULT_PAGE_STYLE,
  children,
}: {
  workspaceId: string;
  page: {
    id: string;
    parentId: string | null;
    title: string;
    icon: string | null;
    background: PageBackground | null;
    kind: PageKind;
    archived: boolean;
    /** A row of a database (its parent). */
    isRow?: boolean;
  };
  info: PageHeaderInfo;
  crumbs: Crumb[];
  user: { id: string; name: string };
  showBody: boolean;
  wide: boolean;
  /** The page's style as stored, so the first paint already has it (see lib/page-style.ts). */
  style?: PageStyle;
  children?: ReactNode;
}) {
  const router = useRouter();
  const t = useTranslations("page");
  const tc = useTranslations("common");
  const untitled = tc("untitled");
  const { pageDoc, synced, connection, pendingEdits, error } = usePageDoc(page.id);
  const title = useDocTitle(pageDoc?.doc, page.title);
  const offlineUser = useOffline()?.userId;
  // Anything besides typing needs the server: those controls are off while it can't be reached.
  const offline = useIsOffline() || connection === "offline";
  // Everyone who has the page open shows in the header, including people who may only view it.
  const viewers = usePagePresence(pageDoc, user);
  const [icon, setIcon] = useState(page.icon);
  const [background, setBackground] = useState(page.background);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  // The graph and the comments share the room beside the page: opening one closes the other.
  const [graphOpen, setGraphOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const canEdit = hasLevel(info.level, "edit");
  const canDelete = hasLevel(info.level, "full");
  // Locked against accidental edits (lib/page-lock; a database's lock is about its schema instead).
  // Follows the page menu at once, and other people's changes through the header event below.
  const [lockedNow, setLockedNow] = useState(info.locked);
  const locked = page.kind === "page" && lockedNow;
  // The collab server drops edits from people who may only view, and from everyone while the page
  // is locked, so don't let them type at all. Offline edits are kept in this browser: the doc syncs
  // them when the connection comes back.
  const editable = !page.archived && canEdit && !locked && synced && connection !== "noAccess";
  // Pages with a body only: databases always use the whole width and the app's typeface.
  const pageStyle = usePageStyle(synced ? pageDoc?.doc : undefined, style);
  const fullWidth = showBody && !wide && pageStyle.fullWidth;

  // Listed on the offline page, whose links open the copies the service worker kept.
  useEffect(() => {
    if (!offlineUser || page.archived || connection === "noAccess") return;
    rememberPage(offlineUser, { id: page.id, workspaceId, title, icon });
  }, [offlineUser, page.id, page.archived, workspaceId, title, icon, connection]);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setIcon(page.icon), [page.icon]);
  useEffect(() => setLockedNow(info.locked), [info.locked]);
  // Unlocked (as the server says): sync again, so edits the lock held back, made offline or as it
  // came in, reach the server now that its connection takes them.
  const wasLocked = useRef(info.locked);
  useEffect(() => {
    if (wasLocked.current && !info.locked) pageDoc?.provider.forceSync();
    wasLocked.current = info.locked;
  }, [info.locked, pageDoc]);
  useEffect(() => setBackground(page.background), [page.background]);

  // Someone else changed the icon or background (server/pages.ts): load them again.
  const provider = pageDoc?.provider;
  useEffect(() => {
    if (!provider) return;
    const onStateless = ({ payload }: { payload: string }) => {
      if (payload === PAGE_HEADER_EVENT) router.refresh();
    };
    provider.on("stateless", onStateless);
    return () => void provider.off("stateless", onStateless);
  }, [provider, router]);

  // A page the user just created opens ready for its name. Waits until the title is editable
  // (the doc has synced), so the first keystrokes aren't lost.
  useEffect(() => {
    const el = titleRef.current;
    if (!editable || !el || !takeNewPage(page.id)) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editable, page.id]);

  // Keep the tab title in sync with live renames; a database adds the view it shows.
  const [viewName, setViewName] = useState<string | null>(null);
  useEffect(() => {
    const label = pageLabel(title, untitled);
    document.title = viewName
      ? t("documentViewTitle", { title: label, view: viewName })
      : t("documentTitle", { title: label });
  }, [title, untitled, viewName, t]);

  /** Runs a page action; a failure shows a message instead of reaching the error boundary. */
  function run(action: () => Promise<void>, onError?: () => void) {
    setActionError(null);
    startTransition(async () => {
      try {
        await action();
      } catch {
        onError?.();
        setActionError(t("header.actionFailed"));
      }
    });
  }

  function changeIcon(next: string | null) {
    const previous = icon;
    setIcon(next);
    run(
      async () => {
        await setPageIconAction(page.id, next);
        router.refresh();
      },
      () => setIcon(previous),
    );
  }

  function changeBackground(next: PageBackground | null) {
    const previous = background;
    setBackground(next);
    run(
      async () => {
        await setPageBackgroundAction(page.id, next);
        router.refresh();
      },
      () => setBackground(previous),
    );
  }

  function unlock() {
    setLockedNow(false);
    run(
      async () => {
        await setPageLockedAction(workspaceId, page.id, false);
        router.refresh();
      },
      () => setLockedNow(true),
    );
  }

  function moveToTrash() {
    run(async () => {
      await archivePageAction(page.id);
      router.refresh();
    });
  }

  function restore() {
    run(async () => {
      await restorePageAction(page.id);
      router.refresh();
    });
  }

  function deleteForever() {
    if (!confirm(t("archived.confirmDelete"))) return;
    run(async () => {
      await deletePagePermanentlyAction(page.id);
      router.push(`/w/${workspaceId}`);
      router.refresh();
    });
  }

  /** A new page (or row) from this template, opened right away. */
  function applyTemplate() {
    setActionError(null);
    startTransition(async () => {
      const result =
        info.template === "row" && page.parentId
          ? await createRowAction(workspaceId, page.parentId, { templateId: page.id })
          : await createFromTemplateAction(page.id);
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      router.push(`/w/${workspaceId}/p/${result.data.id}`);
    });
  }

  const parents = crumbs.slice(0, -1);
  // Breadcrumb blocks show the page's live title and icon, like the header.
  const trail = useMemo(
    () => [...crumbs.slice(0, -1), { id: page.id, title, icon, kind: page.kind }],
    [crumbs, page.id, page.kind, title, icon],
  );

  const canChangeHeader = !page.archived && canEdit && !offline && !locked;
  const backgroundButton = canChangeHeader ? (
    <BackgroundPicker background={background} onChange={changeBackground} align={wide ? "end" : "start"}>
      {(toggle) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={toggle}
          className="-ml-2 font-sans opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <Paintbrush className="h-4 w-4" /> {t(background ? "background.change" : "background.add")}
        </Button>
      )}
    </BackgroundPicker>
  ) : null;

  const iconPicker = (
    <IconPicker icon={icon} onChange={changeIcon} disabled={!canChangeHeader} align={wide && !icon ? "end" : "start"}>
      {(toggle) =>
        icon ? (
          <button
            type="button"
            onClick={toggle}
            className={cn(
              "-ml-1 rounded-md p-1 leading-none",
              wide ? "text-3xl" : "text-5xl",
              canChangeHeader ? "hover:bg-bg-hover" : "cursor-default",
            )}
          >
            {icon}
          </button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={toggle}
            className={cn(
              // A control, so the app's typeface rather than the page's.
              "-ml-2 font-sans opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100",
              !canChangeHeader && "hidden",
            )}
          >
            <SmilePlus className="h-4 w-4" /> {t("icon.add")}
          </Button>
        )
      }
    </IconPicker>
  );

  return (
    // The black background is dark in either theme, so the editor and diagrams draw dark on it.
    <DarkScheme dark={background?.color === "black"}>
      {/* Cmd/Ctrl+F with focus anywhere in here opens the page's find bar instead of the browser's. */}
      <div data-find-scope className={cn("flex min-h-full flex-col", backdropClass(background))}>
        {/* Above the content's own layers (frozen table columns, the title's buttons, z-30) as it scrolls under. */}
        <header className="sticky top-0 z-[35] flex h-11 items-center justify-between gap-2 border-b border-transparent bg-bg/90 px-3 backdrop-blur max-md:pl-1.5">
          <nav className="flex min-w-0 items-center gap-1 text-sm text-fg-muted">
            <SidebarOpenButton className="mr-1 max-md:mr-0" />
            {parents.map((c) => (
              <span key={c.id} className="flex min-w-0 items-center gap-1 max-md:hidden">
                <Link
                  href={`/w/${workspaceId}/p/${c.id}`}
                  className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-bg-hover hover:text-fg"
                >
                  <PageIcon icon={c.icon} kind={c.kind} className="text-sm" />
                  <span className="max-w-40 truncate">{pageLabel(c.title, untitled)}</span>
                </Link>
                <span className="text-fg-faint">/</span>
              </span>
            ))}
            <span className="flex min-w-0 items-center gap-1 px-1 text-fg">
              <PageIcon icon={icon} kind={page.kind} className="text-sm" />
              <span className="truncate md:max-w-60">{pageLabel(title, untitled)}</span>
            </span>
          </nav>
          <div className="flex shrink-0 items-center gap-0.5">
            <SyncStatus connection={connection} pendingEdits={pendingEdits} />
            {locked && !page.archived && (
              <LockedNotice onUnlock={canEdit && !offline ? unlock : undefined} pending={pending} />
            )}
            <PageHeaderActions
              workspaceId={workspaceId}
              page={{
                id: page.id,
                kind: page.kind,
                parentId: page.parentId,
                archived: page.archived,
                hasBody: showBody,
                isRow: page.isRow,
              }}
              currentUser={user}
              info={info}
              doc={synced ? pageDoc?.doc : undefined}
              viewers={connection === "live" ? viewers : []}
              onHistory={() => setHistoryOpen(true)}
              commentsOpen={commentsOpen}
              onComments={
                showBody
                  ? () => {
                      setGraphOpen(false);
                      setCommentsOpen((open) => !open);
                    }
                  : undefined
              }
              onGraph={() => {
                setCommentsOpen(false);
                setGraphOpen((open) => !open);
              }}
              onMoveToTrash={moveToTrash}
              offline={offline}
              style={showBody ? pageStyle : undefined}
              onStyle={editable && showBody && pageDoc ? (change) => writePageStyle(pageDoc.doc, change) : undefined}
              onLocked={setLockedNow}
            />
          </div>
        </header>

        {page.archived && (
          <div className="flex items-center justify-center gap-3 bg-danger px-4 py-2 text-sm text-white">
            {t("archived.banner")}
            {canEdit && (
              <Button size="sm" className="border-white/60 bg-transparent text-white hover:bg-white/10" onClick={restore} disabled={pending || offline}>
                <RotateCcw className="h-3.5 w-3.5" /> {tc("restore")}
              </Button>
            )}
            {canDelete && (
              <Button size="sm" className="border-white/60 bg-transparent text-white hover:bg-white/10" onClick={deleteForever} disabled={pending || offline}>
                {t("archived.deletePermanently")}
              </Button>
            )}
            {actionError && <span role="alert">{actionError}</span>}
          </div>
        )}

        {info.template && !page.archived && (
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-y border-border bg-bg-subtle px-4 py-2 text-sm">
            <LayoutTemplate className="h-4 w-4 shrink-0 text-fg-muted" />
            <span className="text-fg-muted">{t(`template.${info.template}`)}</span>
            {info.template !== "inside" && (
              <Button size="sm" variant="primary" onClick={applyTemplate} disabled={pending || offline}>
                {t("template.use")}
              </Button>
            )}
          </div>
        )}

        <div
          className={cn(
            "w-full flex-1 pb-32",
            wide ? "pt-6" : fullWidth ? "page-full-width" : "page-column mx-auto max-w-[900px]",
            !wide && "pt-8 md:pt-12",
            !wide && (commentsOpen || graphOpen) && !offline && "page-beside-panel",
            showBody && pageTextClasses(pageStyle),
          )}
        >
          <div className={cn("group", wide ? "page-gutter" : "px-4 md:px-[54px]")}>
            {!wide && (
              <div className="relative mb-2 flex h-8 items-end gap-1">
                {iconPicker}
                {backgroundButton}
              </div>
            )}
            {!wide && icon && <div className="h-8" />}
            {/* Wide (database) pages keep everything on the title's line so the view starts higher: the
                icon before the title, the add-icon and background buttons over its right end. Those
                show on hover or focus and take no room, so the title keeps its width; on touch
                screens, where they always show, they sit after it instead. */}
            <div className={cn(wide && "relative flex items-center gap-3")}>
              {wide && icon && iconPicker}
              <TitleField
                inputRef={titleRef}
                value={title}
                compact={wide}
                editable={editable}
                onChange={(v) => pageDoc && setDocTitle(pageDoc.doc, v)}
                onEnter={() => document.querySelector<HTMLElement>(".leafdesk-editor .ProseMirror")?.focus()}
              />
              {wide && (
                <div
                  className={cn(
                    "absolute top-1/2 right-0 z-30 flex -translate-y-1/2 items-center gap-1 rounded-md bg-bg pl-2",
                    "pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100",
                    // Kept shown while one of their pickers is open (Popover sets data-open).
                    "focus-within:pointer-events-auto focus-within:opacity-100 has-[[data-open]]:pointer-events-auto has-[[data-open]]:opacity-100",
                    "pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:shrink-0 pointer-coarse:translate-y-0 pointer-coarse:opacity-100",
                  )}
                >
                  {!icon && iconPicker}
                  {backgroundButton}
                </div>
              )}
            </div>
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}
            {actionError && !page.archived && (
              <p role="alert" className="mt-2 text-sm text-danger">
                {actionError}
              </p>
            )}
          </div>

          {children && (
            <DocumentViewContext.Provider value={setViewName}>
              <div className={cn(wide ? "mt-5" : "mt-4 px-4 md:px-[54px]")}>{children}</div>
            </DocumentViewContext.Provider>
          )}

          {showBody && (
            <div className="mt-4 min-h-[40vh]">
              {pageDoc && synced ? (
                <CollabEditor
                  pageDoc={pageDoc}
                  user={user}
                  editable={editable}
                  level={page.archived || info.level === "none" ? "view" : info.level}
                  workspaceId={workspaceId}
                  pageId={page.id}
                  crumbs={trail}
                  commentsOpen={commentsOpen && !offline}
                  onCloseComments={() => setCommentsOpen(false)}
                  offline={offline}
                  ai={info.ai && editable && !offline && !page.archived}
                />
              ) : (
                // Without a connection the error above explains why nothing loads.
                !error && <div className="px-4 text-sm text-fg-faint md:px-[54px]">{tc("loading")}</div>
              )}
            </div>
          )}
          {/* Databases too: a page can mention one. */}
          <Backlinks workspaceId={workspaceId} pageId={page.id} title={page.title} canLink={!offline && !page.archived} />
        </div>

        {graphOpen && !offline && !page.archived && (
          <LocalGraphPanel workspaceId={workspaceId} pageId={page.id} onClose={() => setGraphOpen(false)} />
        )}
        {historyOpen && (
          <HistoryPanel pageId={page.id} readOnly={page.archived || !canEdit || locked} onClose={() => setHistoryOpen(false)} />
        )}
      </div>
    </DarkScheme>
  );
}

function TitleField({
  inputRef: ref,
  value,
  compact = false,
  editable,
  onChange,
  onEnter,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  /** Wide (database) pages use a smaller title so the views start higher. */
  compact?: boolean;
  editable: boolean;
  onChange: (value: string) => void;
  onEnter: () => void;
}) {
  const t = useTranslations("page");
  const tc = useTranslations("common");
  // What the field shows right now, including keystrokes the doc hasn't echoed back yet.
  const [text, setText] = useState(value);
  // The field is uncontrolled: when someone else's edit changes the title, write it here and keep
  // the caret where it was relative to the text (a controlled value would jump it to the end).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.value === value) return;
    const before = el.value;
    const { selectionStart, selectionEnd } = el;
    el.value = value;
    setText(value);
    if (document.activeElement === el) {
      el.setSelectionRange(shiftIndex(before, value, selectionStart), shiftIndex(before, value, selectionEnd));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- inputRef is a ref object; only a new value matters
  }, [value]);
  // Phones get a step smaller, so a typical title fits on one or two lines.
  const font = cn("font-bold leading-tight", compact ? "text-2xl md:text-3xl" : "text-[1.75rem] md:text-4xl");
  // An invisible copy of the text sizes the box, so the field is only as wide and tall as its text
  // and a click beside the title doesn't start editing it.
  return (
    <div className="relative inline-block min-w-0 max-w-full align-top">
      <span aria-hidden className={cn("invisible block whitespace-pre-wrap break-words", font)}>
        {(text || tc("untitled")) + "\u00a0"}
      </span>
      <textarea
        ref={ref}
        rows={1}
        defaultValue={value}
        readOnly={!editable}
        placeholder={tc("untitled")}
        aria-label={t("title.label")}
        onChange={(e) => {
          const next = e.target.value.replace(/\n/g, "");
          setText(next);
          onChange(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
        className={cn(
          "absolute inset-0 block h-full w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-fg-faint",
          font,
        )}
      />
    </div>
  );
}

/** Where index `i` of `before` ends up in `after`, given one contiguous change between them. */
function shiftIndex(before: string, after: string, i: number) {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  if (i <= start) return i;
  if (i >= before.length - end) return i + after.length - before.length;
  return after.length - end;
}

/** Says the page is locked, next to its sync status, with a way to unlock it for those who may. */
function LockedNotice({ onUnlock, pending }: { onUnlock?: () => void; pending: boolean }) {
  const t = useTranslations("page.header");
  return (
    <span className="mr-1 flex shrink-0 items-center gap-1 text-xs text-fg-muted" title={t("lockPageHint")}>
      <Lock className="h-3.5 w-3.5" aria-hidden />
      <span>{t("locked")}</span>
      {onUnlock && (
        <Button size="sm" variant="ghost" onClick={onUnlock} disabled={pending} className="-my-1 ml-0.5 h-6 px-1.5">
          {t("unlock")}
        </Button>
      )}
    </span>
  );
}

const DOT_COLOR: Record<ConnectionState, string> = {
  live: "bg-emerald-500",
  syncing: "bg-accent",
  connecting: "bg-amber-400",
  reconnecting: "bg-amber-400",
  offline: "bg-fg-faint",
  noAccess: "bg-danger",
};

/** How long "Synced" stays up after edits made offline (or a slow save) have reached the server. */
const SYNCED_NOTICE_MS = 2500;

/**
 * Where the page stands with the server: a dot, with words whenever it isn't simply live. After
 * a stretch of offline or syncing it says "Synced" for a moment, so the user knows their edits
 * made it.
 */
function SyncStatus({ connection, pendingEdits }: { connection: ConnectionState; pendingEdits: boolean }) {
  const t = useTranslations("page.connection");
  const [justSynced, setJustSynced] = useState(false);
  const previous = useRef(connection);
  useEffect(() => {
    const before = previous.current;
    previous.current = connection;
    if (connection !== "live" || (before !== "syncing" && before !== "offline" && before !== "reconnecting")) return;
    setJustSynced(true);
    const timer = setTimeout(() => setJustSynced(false), SYNCED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [connection]);
  const key = connection === "offline" && pendingEdits ? "offlinePending" : connection === "live" && justSynced ? "synced" : connection;
  const label = t(key);
  return (
    <span
      role="status"
      data-sync-state={connection}
      className="mr-1 flex min-w-0 items-center gap-1.5 text-xs text-fg-faint"
      title={connection === "offline" ? t("offlineHint") : label}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_COLOR[connection])} />
      {(connection !== "live" || justSynced) && <span className="truncate">{label}</span>}
      {connection === "live" && !justSynced && <span className="sr-only">{label}</span>}
    </span>
  );
}
