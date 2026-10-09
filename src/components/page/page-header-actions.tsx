"use client";

import {
  ArrowRightLeft,
  Copy,
  CornerUpLeft,
  Download,
  FileArchive,
  FileSpreadsheet,
  FileText,
  History,
  LayoutTemplate,
  Link2,
  Lock,
  MessageSquare,
  MoreHorizontal,
  MoveHorizontal,
  Printer,
  Search,
  Sparkles,
  Star,
  Trash2,
  Type,
  Waypoints,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type * as Y from "yjs";
import {
  duplicatePageAction,
  getPageHeaderAction,
  setDatabaseLockedAction,
  setFavoriteAction,
  setPageLockedAction,
} from "@/app/actions/page-menu";
import { getSidebarAction, movePageAction } from "@/app/actions/pages";
import { deleteTemplateAction, saveAsTemplateAction } from "@/app/actions/templates";
import { useAiChat } from "@/components/ai-chat/chat-panel";
import { cn, Dialog, IconButton, MenuItem, MenuSeparator, PageIcon, pageLabel, Popover, Switch } from "@/components/ui";
import { useZipExport } from "@/components/use-zip-export";
import type { PageKind } from "@/db/schema/app";
import { FAVORITES_EVENT } from "@/lib/favorites-event";
import { OPEN_SHARE_EVENT } from "@/lib/share-event";
import type { Presence } from "@/lib/presence";
import { PAGE_FONTS, type PageStyle } from "@/lib/page-style";
import { printPath } from "@/lib/print";
import { relativeTime } from "@/lib/relative-time";
import type { PageHeaderInfo } from "@/server/page-meta";
import type { TreeNode } from "@/server/pages";
import type { TeamspaceSummary } from "@/server/teamspaces";
import { PresenceAvatars } from "./presence-avatars";
import { SharePanel } from "./share-panel";
import { searchFold } from "@/lib/search-fold";

const RANK = { none: 0, view: 1, comment: 2, edit: 3, full: 4 } as const;
/** Client-side mirror of the server's level check, for hiding what the server would refuse. */
export const hasLevel = (level: PageHeaderInfo["level"], needed: Exclude<PageHeaderInfo["level"], "none">) => RANK[level] >= RANK[needed];

/**
 * The collab server stores a changed doc 2 s after the last edit, and at least every 10 s while
 * edits keep coming. Refetch the header a little after that so "Edited …" and its author stay current.
 */
const STORE_SETTLE_MS = 4000;
const STORE_MAX_WAIT_MS = 11_000;

/**
 * Right side of the page header: when it was last edited (with who made and changed
 * it), who else has the page open, Share, the favorite star and the page menu.
 */
export function PageHeaderActions({
  workspaceId,
  page,
  currentUser,
  info: initialInfo,
  doc,
  viewers = [],
  onHistory,
  onComments,
  commentsOpen = false,
  onGraph,
  onMoveToTrash,
  offline = false,
  style,
  onStyle,
  onLocked,
}: {
  workspaceId: string;
  page: { id: string; kind: PageKind; parentId: string | null; archived: boolean; hasBody: boolean; isRow?: boolean };
  currentUser: { id: string; name: string };
  info: PageHeaderInfo;
  /** The page's shared doc once synced; its edits trigger a refetch of the header info. */
  doc?: Y.Doc;
  /** Everyone else who has the page open. */
  viewers?: Presence[];
  onHistory: () => void;
  /** Opens or closes the comments beside the page; pages without a body have none. */
  onComments?: () => void;
  commentsOpen?: boolean;
  /** Opens or closes the graph of the page beside it. */
  onGraph?: () => void;
  onMoveToTrash: () => void;
  /** The server can't be reached: sharing, comments, favorites and the page menu need it. */
  offline?: boolean;
  /** The page's style, for pages with a body. */
  style?: PageStyle;
  /** Changes the style; unset while the page can't be edited here (the menu then leaves it out). */
  onStyle?: (change: Partial<PageStyle>) => void;
  /** Hears whether the page is locked as the header learns it: from the menu at once, else refetched. */
  onLocked?: (locked: boolean) => void;
}) {
  const t = useTranslations("page.header");
  const tOffline = useTranslations("offline");
  const [info, setInfo] = useState(initialInfo);
  useEffect(() => onLocked?.(info.locked), [info.locked, onLocked]);
  const offlineTitle = (label: string) => (offline ? tOffline("needsConnection", { action: label }) : label);
  const aiChat = useAiChat();
  const tAi = useTranslations("ai.chat");
  useEffect(() => setInfo(initialInfo), [initialInfo]);
  // The Share panel also opens from elsewhere: an event for this page, or `?share=1` in the URL.
  const searchParams = useSearchParams();
  const [shareOpen, setShareOpen] = useState(() => searchParams.get("share") === "1" && !page.archived);
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<{ pageId: string }>).detail?.pageId !== page.id || page.archived) return;
      e.preventDefault();
      setShareOpen(true);
    };
    window.addEventListener(OPEN_SHARE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SHARE_EVENT, onOpen);
  }, [page.id, page.archived]);
  const refresh = useCallback(() => {
    getPageHeaderAction(page.id).then(setInfo).catch(() => {});
  }, [page.id]);

  useEffect(() => {
    if (!doc) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstEdit = 0;
    const onUpdate = () => {
      const now = Date.now();
      if (!timer) firstEdit = now;
      clearTimeout(timer);
      const wait = Math.min(STORE_SETTLE_MS, firstEdit + STORE_MAX_WAIT_MS - now);
      timer = setTimeout(() => {
        timer = undefined;
        refresh();
      }, Math.max(0, wait));
    };
    doc.on("update", onUpdate);
    return () => {
      doc.off("update", onUpdate);
      clearTimeout(timer);
    };
  }, [doc, refresh]);

  const toggleFavorite = async () => {
    const favorite = !info.favorite;
    setInfo((i) => ({ ...i, favorite }));
    try {
      await setFavoriteAction(page.id, favorite);
      window.dispatchEvent(new Event(FAVORITES_EVENT));
    } catch {
      setInfo((i) => ({ ...i, favorite: !favorite }));
    }
  };

  return (
    <>
      {/* Popover's own wrapper is inline-flex, so hide from outside it on small screens. */}
      <span className="hidden md:inline-flex">
        <EditedButton info={info} onOpen={refresh} />
      </span>
      <PresenceAvatars viewers={viewers} />
      {!page.archived && (
        <Popover
          align="end"
          open={shareOpen}
          onOpenChange={setShareOpen}
          // On phones the button isn't at the screen edge, so pin the panel to the viewport instead.
          className="p-0 max-md:fixed max-md:inset-x-4 max-md:top-12"
          trigger={({ toggle }) => (
            <button
              type="button"
              onClick={toggle}
              disabled={offline}
              title={offline ? offlineTitle(t("share")) : undefined}
              className="inline-flex h-7 items-center rounded-md px-2 text-sm text-fg hover:bg-bg-hover disabled:cursor-default disabled:text-fg-faint disabled:hover:bg-transparent"
            >
              {t("share")}
              {info.accessRequests > 0 && (
                <span
                  title={t("accessRequests", { count: info.accessRequests })}
                  className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-medium text-accent-fg"
                >
                  <span aria-hidden>{info.accessRequests}</span>
                  <span className="sr-only">{t("accessRequests", { count: info.accessRequests })}</span>
                </span>
              )}
            </button>
          )}
        >
          <SharePanel pageId={page.id} currentUser={currentUser} publishable={!info.template} onChange={refresh} />
        </Popover>
      )}
      {/* The AI chat beside the page; there's no AI to ask without a provider on the server. */}
      {aiChat && (
        <IconButton
          label={tAi("open")}
          title={offlineTitle(tAi("open"))}
          aria-pressed={aiChat.open && !offline}
          disabled={offline}
          className={cn("h-7 w-7 disabled:opacity-40 disabled:hover:bg-transparent", aiChat.open && !offline && "bg-bg-hover")}
          onClick={() => (aiChat.open ? aiChat.setOpen(false) : aiChat.openPanel())}
        >
          <Sparkles className="h-4 w-4" />
        </IconButton>
      )}
      {onComments && (
        <IconButton
          label={t("comments")}
          title={offlineTitle(t("comments"))}
          aria-pressed={commentsOpen && !offline}
          disabled={offline}
          className={cn("h-7 w-7 disabled:opacity-40 disabled:hover:bg-transparent", commentsOpen && !offline && "bg-bg-hover")}
          onClick={onComments}
        >
          <MessageSquare className="h-4 w-4" />
        </IconButton>
      )}
      {/* Templates aren't listed under Favorites, so they get no star. */}
      {!page.archived && !info.template && (
        <IconButton
          label={info.favorite ? t("removeFavorite") : t("addFavorite")}
          title={offlineTitle(info.favorite ? t("removeFavorite") : t("addFavorite"))}
          aria-pressed={info.favorite}
          disabled={offline}
          className="h-7 w-7 disabled:opacity-40 disabled:hover:bg-transparent"
          onClick={() => void toggleFavorite()}
        >
          <Star className={cn("h-4 w-4", info.favorite && "fill-amber-400 text-amber-400")} />
        </IconButton>
      )}
      <PageMenu
        workspaceId={workspaceId}
        page={page}
        info={info}
        onInfo={setInfo}
        onHistory={onHistory}
        onGraph={onGraph}
        onMoveToTrash={onMoveToTrash}
        offline={offline}
        style={style}
        onStyle={onStyle}
      />
    </>
  );
}

function EditedButton({ info, onOpen }: { info: PageHeaderInfo; onOpen: () => void }) {
  const t = useTranslations("page.header");
  const locale = useLocale();
  // Re-render every minute so "5 minutes ago" keeps counting.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const ago = (date: Date) => relativeTime(date, locale);
  return (
    <Popover
      align="end"
      className="w-72 p-0"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={() => {
            if (!open) onOpen();
            toggle();
          }}
          className="inline-flex h-7 items-center rounded-md px-2 text-sm text-fg-muted hover:bg-bg-hover"
        >
          {t("edited", { time: ago(info.updatedAt) })}
        </button>
      )}
    >
      <div className="border-b border-border px-3 py-2 text-xs font-medium text-fg-muted">{t("activity")}</div>
      <ul className="space-y-1.5 px-3 py-2 text-sm">
        <ActivityLine label={t("editedBy", { name: info.updatedBy ?? t("someone") })} time={ago(info.updatedAt)} />
        <ActivityLine label={t("createdBy", { name: info.createdBy ?? t("someone") })} time={ago(info.createdAt)} />
      </ul>
    </Popover>
  );
}

function ActivityLine({ label, time }: { label: string; time: string }) {
  return (
    <li className="flex items-baseline gap-3">
      <span className="min-w-0 flex-1 truncate text-fg-muted">{label}</span>
      <span className="shrink-0 text-xs text-fg-faint">{time}</span>
    </li>
  );
}

/**
 * Top of the page menu: the page's typeface, small text and full width. Changes go into the shared
 * doc, so they show for everyone at once; the menu stays open to compare.
 */
function StyleControls({ style, onStyle }: { style: PageStyle; onStyle: (change: Partial<PageStyle>) => void }) {
  const t = useTranslations("page.header.style");
  return (
    <>
      <div className="px-1 pt-0.5 pb-1">
        <span className="mb-1 block px-1 text-xs text-fg-muted">{t("font")}</span>
        <div role="radiogroup" aria-label={t("font")} className="grid grid-cols-3 gap-1">
          {PAGE_FONTS.map((font) => {
            const selected = style.font === font;
            return (
              <button
                key={font}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t(font)}
                onClick={() => onStyle({ font })}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md border py-1.5",
                  selected ? "border-accent bg-bg-active text-fg" : "border-transparent text-fg-muted hover:bg-bg-hover hover:text-fg",
                )}
              >
                <span aria-hidden className={cn("text-xl leading-none", font !== "default" && `page-font-${font}`)}>
                  Ag
                </span>
                <span className="text-xs">{t(font)}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm">
        <Type className="h-4 w-4 text-fg-muted" />
        <span className="flex-1">{t("smallText")}</span>
        <Switch checked={style.smallText} onChange={(smallText) => onStyle({ smallText })} label={t("smallText")} />
      </div>
      <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm">
        <MoveHorizontal className="h-4 w-4 text-fg-muted" />
        <span className="flex-1">{t("fullWidth")}</span>
        <Switch checked={style.fullWidth} onChange={(fullWidth) => onStyle({ fullWidth })} label={t("fullWidth")} />
      </div>
      <MenuSeparator />
    </>
  );
}

function PageMenu({
  workspaceId,
  page,
  info,
  onInfo,
  onHistory,
  onGraph,
  onMoveToTrash,
  offline,
  style,
  onStyle,
}: {
  workspaceId: string;
  page: { id: string; kind: PageKind; parentId: string | null; archived: boolean; hasBody: boolean; isRow?: boolean };
  info: PageHeaderInfo;
  onInfo: (info: PageHeaderInfo) => void;
  onHistory: () => void;
  onGraph?: () => void;
  onMoveToTrash: () => void;
  offline: boolean;
  style?: PageStyle;
  onStyle?: (change: Partial<PageStyle>) => void;
}) {
  const t = useTranslations("page.header");
  const tOffline = useTranslations("offline");
  const tTemplate = useTranslations("page.template");
  const locale = useLocale();
  const router = useRouter();
  const [moveOpen, setMoveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const zipExport = useZipExport();
  const canEdit = hasLevel(info.level, "edit");
  const canManage = hasLevel(info.level, "full");
  const isDatabase = page.kind === "database";
  // A template (or a row template) itself: deleted rather than trashed, and it stays where it is listed.
  const templateRoot = info.template === "workspace" || info.template === "row";
  // Rows become row templates of their database (edit access there); other pages go to the top level.
  const canSaveTemplate = !page.archived && !info.template && (page.isRow ? canEdit : info.topLevel);

  const saveAsTemplate = (close: () => void) =>
    startTransition(async () => {
      setError(null);
      const result = await saveAsTemplateAction(page.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      close();
      router.push(`/w/${result.data.workspaceId}/p/${result.data.id}`);
    });

  const deleteTemplate = (close: () => void) => {
    if (!confirm(tTemplate("confirmDelete"))) return;
    startTransition(async () => {
      setError(null);
      const result = await deleteTemplateAction(page.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      close();
      router.push(result.data.databaseId ? `/w/${workspaceId}/p/${result.data.databaseId}` : `/w/${workspaceId}`);
      router.refresh();
    });
  };

  const duplicate = (close: () => void) =>
    startTransition(async () => {
      setError(null);
      const result = await duplicatePageAction(page.id);
      if (!result.ok) {
        setError(t("duplicateFailed"));
        return;
      }
      close();
      router.push(`/w/${result.workspaceId}/p/${result.id}`);
    });

  const setLocked = (locked: boolean) =>
    startTransition(async () => {
      setError(null);
      onInfo({ ...info, locked });
      try {
        if (isDatabase) await setDatabaseLockedAction(workspaceId, page.id, locked);
        else await setPageLockedAction(workspaceId, page.id, locked);
      } catch {
        onInfo({ ...info, locked: !locked });
        setError(t("actionFailed"));
      }
    });

  const edited = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(info.updatedAt),
  );

  return (
    <>
      <Popover
        align="end"
        className="w-64"
        trigger={({ toggle }) => (
          <IconButton
            label={t("more")}
            title={offline ? tOffline("needsConnection", { action: t("more") }) : t("more")}
            disabled={offline}
            className="h-7 w-7 disabled:opacity-40 disabled:hover:bg-transparent"
            onClick={toggle}
          >
            <MoreHorizontal className="h-4 w-4" />
          </IconButton>
        )}
      >
        {(close) => (
          <div className={cn(pending && "pointer-events-none opacity-70")}>
            {style && onStyle && !page.archived && <StyleControls style={style} onStyle={onStyle} />}
            <MenuItem
              icon={<Link2 className="h-4 w-4" />}
              onClick={() => {
                void navigator.clipboard.writeText(window.location.href);
                close();
              }}
            >
              {t("copyLink")}
            </MenuItem>
            {/* The page and the pages around it: beside the page, else in the workspace graph. */}
            {!page.archived && !offline && (
              <MenuItem
                icon={<Waypoints className="h-4 w-4" />}
                onClick={() => {
                  close();
                  if (onGraph) onGraph();
                  else router.push(`/w/${workspaceId}/graph?focus=${encodeURIComponent(page.id)}`);
                }}
              >
                {t("showInGraph")}
              </MenuItem>
            )}
            {/* The copy lands beside the original; at the top level that isn't open to every guest. */}
            {!page.archived && canEdit && (page.parentId !== null || info.topLevel) && (
              <MenuItem icon={<Copy className="h-4 w-4" />} onClick={() => duplicate(close)}>
                {t("duplicate")}
              </MenuItem>
            )}
            {canSaveTemplate && (
              <MenuItem icon={<LayoutTemplate className="h-4 w-4" />} onClick={() => saveAsTemplate(close)}>
                {page.isRow ? t("saveAsRowTemplate") : t("saveAsTemplate")}
              </MenuItem>
            )}
            {/* Moving to another parent needs full access on the page. Templates don't move. */}
            {!page.archived && canManage && !info.template && (
              <MenuItem
                icon={<CornerUpLeft className="h-4 w-4" />}
                onClick={() => {
                  close();
                  setMoveOpen(true);
                }}
              >
                {t("moveTo")}
              </MenuItem>
            )}
            {!page.archived && canEdit && !templateRoot && (
              <MenuItem
                icon={<Trash2 className="h-4 w-4" />}
                onClick={() => {
                  close();
                  onMoveToTrash();
                }}
              >
                {t("moveToTrash")}
              </MenuItem>
            )}
            {templateRoot && canManage && (
              <MenuItem icon={<Trash2 className="h-4 w-4" />} onClick={() => deleteTemplate(close)}>
                {t("deleteTemplate")}
              </MenuItem>
            )}

            {isDatabase && !page.archived && (canManage || info.locked) && (
              <>
                <MenuSeparator />
                <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm" title={t("lockHint")}>
                  <Lock className="h-4 w-4 text-fg-muted" />
                  <span className="flex-1">{t("lockDatabase")}</span>
                  <Switch
                    checked={info.locked}
                    disabled={!canManage || pending}
                    onChange={setLocked}
                    label={t("lockDatabase")}
                  />
                </div>
              </>
            )}
            {/* A guard against accidental edits, not a permission: whoever may edit the page may unlock it. */}
            {!isDatabase && !page.archived && (canEdit || info.locked) && (
              <>
                <MenuSeparator />
                <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm" title={t("lockPageHint")}>
                  <Lock className="h-4 w-4 text-fg-muted" />
                  <span className="flex-1">{t("lockPage")}</span>
                  <Switch checked={info.locked} disabled={!canEdit || pending} onChange={setLocked} label={t("lockPage")} />
                </div>
              </>
            )}

            <MenuSeparator />
            {/* Hidden while the workspace has export turned off; the routes refuse it too. */}
            {info.exportable && (
              <>
                <a
                  href={`/w/${workspaceId}/p/${page.id}/export`}
                  download
                  onClick={() => close()}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover"
                >
                  <span className="flex h-4 w-4 items-center justify-center text-fg-muted">
                    {isDatabase ? <Download className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                  </span>
                  <span className="flex-1 truncate">{isDatabase ? t("exportCsv") : t("exportMarkdown")}</span>
                </a>
                {isDatabase && (
                  <a
                    href={`/w/${workspaceId}/p/${page.id}/export?format=xlsx`}
                    download
                    onClick={() => close()}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover"
                  >
                    <span className="flex h-4 w-4 items-center justify-center text-fg-muted">
                      <FileSpreadsheet className="h-4 w-4" />
                    </span>
                    <span className="flex-1 truncate">{t("exportXlsx")}</span>
                  </a>
                )}
                <MenuItem
                  icon={<FileArchive className="h-4 w-4" />}
                  onClick={() => void zipExport.start(`/w/${workspaceId}/p/${page.id}/export?subpages=1`, close)}
                >
                  {zipExport.pending ? t("exportPreparing") : isDatabase ? t("exportZipDatabase") : t("exportZip")}
                </MenuItem>
                {/* The print view in a new tab; it opens the browser's print dialog ("Save as PDF") once loaded. */}
                <a
                  href={printPath(page.id, { auto: true })}
                  target="_blank"
                  rel="noopener"
                  onClick={() => close()}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover"
                >
                  <span className="flex h-4 w-4 items-center justify-center text-fg-muted">
                    <Printer className="h-4 w-4" />
                  </span>
                  <span className="flex-1 truncate">{t("exportPdf")}</span>
                </a>
              </>
            )}
            {page.hasBody && (
              <MenuItem
                icon={<History className="h-4 w-4" />}
                onClick={() => {
                  close();
                  onHistory();
                }}
              >
                {t("versionHistory")}
              </MenuItem>
            )}

            {(error || zipExport.error) && (
              <p role="alert" className="px-2 pt-1 text-xs text-danger">
                {error ?? zipExport.error}
              </p>
            )}
            <MenuSeparator />
            <div className="px-2 pt-0.5 pb-1 text-xs text-fg-faint">
              <div className="truncate">{t("lastEdited", { name: info.updatedBy ?? t("someone") })}</div>
              <div>{edited}</div>
            </div>
          </div>
        )}
      </Popover>
      <MoveDialog
        open={moveOpen}
        workspaceId={workspaceId}
        pageId={page.id}
        isDatabase={isDatabase}
        currentParentId={page.parentId}
        guest={info.guest}
        onClose={() => setMoveOpen(false)}
      />
    </>
  );
}

/** Pick a new parent: any page or database in the sidebar tree except this page and its subpages. */
function MoveDialog({
  open,
  workspaceId,
  pageId,
  isDatabase,
  currentParentId,
  guest,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  pageId: string;
  isDatabase: boolean;
  currentParentId: string | null;
  guest: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("page.move");
  const tc = useTranslations("common");
  const router = useRouter();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [teamspaces, setTeamspaces] = useState<TeamspaceSummary[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    getSidebarAction(workspaceId)
      .then((next) => {
        setTree(next.tree);
        setTeamspaces(next.teamspaces);
      })
      .catch(() => setTree([]));
  }, [open, workspaceId]);

  const targets = useMemo(() => {
    // This page and everything under it can't take it in.
    const blocked = new Set([pageId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of tree) {
        if (n.parentId && blocked.has(n.parentId) && !blocked.has(n.id)) {
          blocked.add(n.id);
          grew = true;
        }
      }
    }
    const q = searchFold(query.trim());
    return tree
      .filter((n) => !blocked.has(n.id) && n.id !== currentParentId)
      // Moving into a page needs edit access to it, as the server checks.
      .filter((n) => hasLevel(n.level, "edit"))
      // A database can't become a row of another database.
      .filter((n) => !(isDatabase && n.kind === "database"))
      .filter((n) => !q || searchFold(pageLabel(n.title, tc("untitled"))).includes(q))
      .slice(0, 50);
  }, [tree, pageId, isDatabase, currentParentId, query, tc]);

  // The tops of the teamspaces they are in and their private pages, except where the page is now.
  const here = tree.find((n) => n.id === pageId);
  const q = searchFold(query.trim());
  const roots: { key: string; teamspaceId: string | null; label: string; hint: string; icon: string | null }[] = guest
    ? []
    : [
        ...teamspaces.map((ts) => ({
          key: ts.id,
          teamspaceId: ts.id as string | null,
          label: ts.name,
          hint: t("teamspaceHint"),
          icon: ts.icon,
        })),
        { key: "private", teamspaceId: null, label: t("private"), hint: t("privateHint"), icon: null },
      ]
        .filter((r) => currentParentId || !here || r.teamspaceId !== here.teamspaceId)
        .filter((r) => !q || searchFold(r.label).includes(q));
  const spaceName = new Map(teamspaces.map((ts) => [ts.id, ts.name]));

  const move = (parentId: string | null, teamspaceId?: string | null) =>
    startTransition(async () => {
      setError(null);
      try {
        await movePageAction(pageId, parentId, undefined, parentId ? undefined : teamspaceId);
        onClose();
        router.refresh();
      } catch {
        setError(t("failed"));
      }
    });

  return (
    <Dialog open={open} onClose={onClose} className="max-w-md">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="h-4 w-4 text-fg-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search")}
          aria-label={t("title")}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      <div className={cn("max-h-80 overflow-y-auto p-1", pending && "pointer-events-none opacity-70")}>
        {roots.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => move(null, r.teamspaceId)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-hover"
          >
            {r.icon ? (
              <span className="flex h-4 w-4 items-center justify-center text-sm">{r.icon}</span>
            ) : (
              <ArrowRightLeft className="h-4 w-4 text-fg-muted" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{r.label}</span>
              <span className="block text-xs text-fg-muted">{r.hint}</span>
            </span>
          </button>
        ))}
        {roots.length > 0 && targets.length > 0 && <div className="my-1 border-t border-border" />}
        {targets.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => move(n.id)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover"
          >
            <PageIcon icon={n.icon} kind={n.kind} className="text-sm" />
            <span className="min-w-0 flex-1 truncate">{pageLabel(n.title, tc("untitled"))}</span>
            <span className="max-w-[40%] shrink-0 truncate text-xs text-fg-faint">
              {n.teamspaceId ? (spaceName.get(n.teamspaceId) ?? "") : t("private")}
            </span>
          </button>
        ))}
        {!targets.length && !roots.length && <p className="px-2 py-3 text-sm text-fg-muted">{t("empty")}</p>}
      </div>
      {error && (
        <p role="alert" className="border-t border-border px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
