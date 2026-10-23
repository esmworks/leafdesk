"use client";

import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  BellOff,
  Braces,
  ChevronRight,
  Copy,
  CornerUpLeft,
  ExternalLink,
  GripVertical,
  Hash,
  Link2,
  Maximize2,
  Merge,
  MessageSquare,
  PanelRight,
  Pencil,
  Search,
  Smile,
  Star,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { getPageHeaderAction, setFavoriteAction, setFollowingAction } from "@/app/actions/page-menu";
import { EMOJIS } from "@/components/page/icon-picker";
import { hasLevel, MoveDialog } from "@/components/page/page-header-actions";
import { cn, MenuItem, MenuSeparator } from "@/components/ui";
import type { ReorderDragHandlers } from "@/components/use-reorder-drag";
import { requestComments } from "@/lib/comments-request";
import { FAVORITES_EVENT } from "@/lib/favorites-event";
import { comboText, isMac, ROW_MENU_COMBOS, rowMenuShortcut } from "@/lib/shortcuts";
import { searchFold } from "@/lib/search-fold";
import type { PageHeaderInfo } from "@/server/page-meta";
import { Floating, useFloating } from "./floating";
import { MergeWithDialog } from "./merge-rows-dialog";
import { PropertyTypeIcon } from "./property-icons";
import { openInNewTab, type RowOpener } from "./row-panel-context";
import type { Property, Row } from "./types";
import type { DatabaseApi } from "./use-database";

/** A column whose value the menu's "Edit property" opens in the row's cell. */
export type EditableColumn = { key: string; name: string; type: Property["type"] | "title" };

type Item = {
  key: string;
  label: string;
  icon: React.ReactNode;
  run: () => void;
  submenu?: boolean;
  danger?: boolean;
  title?: string;
  /** Its key while the menu is open (lib/shortcuts ROW_MENU_COMBOS). */
  shortcut?: keyof typeof ROW_MENU_COMBOS;
};
type Page = "main" | "icon" | "property" | "openIn" | "developer";

const icon = (Icon: React.ComponentType<{ className?: string }>) => <Icon className="h-3.5 w-3.5" />;

/**
 * The handle before a table row: dragging it moves the row (`drag`, while no sort orders the rows),
 * clicking it opens the row's menu. What the menu offers past the basics depends on the viewer's
 * access to the row, which it reads from the server as it opens.
 */
export function RowMenu({
  workspaceId,
  databaseId,
  opener,
  row,
  drag,
  sorted,
  columns,
  api,
  onEditProperty,
}: {
  workspaceId: string;
  databaseId: string;
  opener: RowOpener;
  row: Row;
  drag?: ReorderDragHandlers;
  /** The view is sorted, so rows don't move by dragging (the handle says so). */
  sorted?: boolean;
  /** The columns shown whose value the viewer may change in this row. */
  columns: EditableColumn[];
  api: DatabaseApi;
  onEditProperty: (key: string) => void;
}) {
  const t = useTranslations("database");
  const th = useTranslations("page.header");
  const ti = useTranslations("page.icon");
  const locale = useLocale();
  const menu = useFloating<HTMLDivElement>();
  const [page, setPage] = useState<Page>("main");
  const [query, setQuery] = useState("");
  const [info, setInfo] = useState<PageHeaderInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"move" | "merge" | null>(null);
  const [pending, startTransition] = useTransition();

  // Favorite, following, access and who last edited it: read again each time the menu opens.
  useEffect(() => {
    if (!menu.open) return;
    let current = true;
    getPageHeaderAction(row.id).then(
      (next) => current && setInfo(next),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [menu.open, row.id]);

  const close = () => {
    menu.close();
    setPage("main");
    setQuery("");
    setError(null);
  };
  /** Closes the menu, then does `fn`. */
  const then = (fn: () => void) => () => {
    close();
    fn();
  };
  const copy = (text: string) =>
    then(() => {
      // A browser that refuses the clipboard leaves things as they were.
      navigator.clipboard.writeText(text).catch(() => {});
    });
  const toggle = (change: (info: PageHeaderInfo) => Promise<PageHeaderInfo>) => () =>
    startTransition(async () => {
      if (!info) return;
      setError(null);
      try {
        setInfo(await change(info));
        close();
      } catch {
        setError(th("actionFailed"));
      }
    });

  // Before the server answers, the viewer counts as an editor: the table shows this menu to editors only.
  const canEdit = info ? hasLevel(info.level, "edit") : true;
  const canComment = info ? hasLevel(info.level, "comment") : true;
  const canManage = !!info && hasLevel(info.level, "full") && !info.template;

  const pageItems: Item[] = [
    ...(info
      ? [
          {
            key: "favorite",
            label: th(info.favorite ? "removeFavorite" : "addFavorite"),
            icon: <Star className={cn("h-3.5 w-3.5", info.favorite && "fill-current text-amber-500")} />,
            run: toggle(async (i) => {
              await setFavoriteAction(row.id, !i.favorite);
              window.dispatchEvent(new Event(FAVORITES_EVENT));
              return { ...i, favorite: !i.favorite };
            }),
          },
        ]
      : []),
    ...(canEdit ? [{ key: "icon", label: t("rowMenu.editIcon"), icon: icon(Smile), run: () => setPage("icon"), submenu: true }] : []),
    ...(columns.length ? [{ key: "property", label: t("rowMenu.editProperty"), icon: icon(Pencil), run: () => setPage("property"), submenu: true }] : []),
  ];
  const openItems: Item[] = [
    { key: "openIn", label: t("rowMenu.openIn"), icon: icon(ArrowUpRight), run: () => setPage("openIn"), submenu: true },
    ...(canComment
      ? [
          {
            key: "comment",
            label: t("rowMenu.comment"),
            icon: icon(MessageSquare),
            shortcut: "comment" as const,
            run: then(() => {
              opener.open(row.id);
              requestComments(row.id);
            }),
          },
        ]
      : []),
  ];
  const rowItems: Item[] = [
    { key: "copyLink", label: t("rowMenu.copyLink"), icon: icon(Link2), run: copy(new URL(opener.href(row.id), window.location.origin).href) },
    {
      key: "duplicate",
      label: t("rowMenu.duplicate"),
      icon: icon(Copy),
      shortcut: "duplicate" as const,
      run: then(() => void api.duplicateRows([row.id])),
    },
    ...(canManage
      ? [{ key: "move", label: th("moveTo"), icon: icon(CornerUpLeft), shortcut: "moveTo" as const, run: then(() => setDialog("move")) }]
      : []),
    // The rows merged into this one go to the trash, which guests don't have.
    ...(info && canEdit && !info.guest && !info.template
      ? [{ key: "merge", label: t("merge.menuItem"), icon: icon(Merge), run: then(() => setDialog("merge")) }]
      : []),
    ...(info && info.following !== null
      ? [
          {
            key: "follow",
            label: th(info.following ? "unfollow" : "follow"),
            title: th(info.following ? "unfollowHint" : "followHint"),
            icon: info.following ? icon(BellOff) : icon(Bell),
            run: toggle(async (i) => {
              await setFollowingAction(row.id, !i.following);
              return { ...i, following: !i.following };
            }),
          },
        ]
      : []),
    {
      key: "trash",
      label: th("moveToTrash"),
      icon: icon(Trash2),
      danger: true,
      shortcut: "trash" as const,
      run: then(() => void api.deleteRow(row.id)),
    },
  ];
  const developerItems: Item[] = [
    { key: "developer", label: t("rowMenu.developer"), icon: icon(Braces), run: () => setPage("developer"), submenu: true },
  ];
  const sections = [pageItems, openItems, rowItems, developerItems];

  // The menu's keys work while it is open, wherever the focus is in it (or on the page behind).
  const byShortcut = useRef(new Map<string, () => void>());
  const shortcuts = new Map(sections.flat().flatMap((item) => (item.shortcut ? [[item.shortcut, item.run] as const] : [])));
  useEffect(() => {
    byShortcut.current = shortcuts;
  });
  useEffect(() => {
    if (!menu.open) return;
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      const action = rowMenuShortcut(e, mac);
      const run = action && byShortcut.current.get(action);
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu.open]);

  const q = searchFold(query.trim());
  const matches = q ? sections.flat().filter((item) => searchFold(item.label).includes(q)) : null;

  const renderItem = (item: Item) => (
    <MenuItem
      key={item.key}
      icon={item.icon}
      danger={item.danger}
      title={item.title}
      trailing={
        item.submenu ? (
          <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />
        ) : item.shortcut ? (
          <kbd className="font-sans text-xs text-fg-faint pointer-coarse:hidden">{comboText(ROW_MENU_COMBOS[item.shortcut], isMac())}</kbd>
        ) : undefined
      }
      onClick={item.run}
    >
      {item.label}
    </MenuItem>
  );

  const edited = info ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(info.updatedAt)) : null;

  const main = (
    <>
      <div className="flex items-center gap-2 rounded-md border border-border px-2 focus-within:border-accent">
        <Search className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches?.length) {
              e.preventDefault();
              matches[0].run();
            }
          }}
          placeholder={t("rowMenu.search")}
          aria-label={t("rowMenu.search")}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      {matches ? (
        matches.length ? (
          <div className="mt-1">{matches.map(renderItem)}</div>
        ) : (
          <p className="px-2 py-2 text-sm text-fg-muted">{t("rowMenu.noMatches")}</p>
        )
      ) : (
        <>
          <p className="px-2 pt-2 pb-1 text-xs font-medium text-fg-faint">{t("rowMenu.page")}</p>
          {sections
            .filter((items) => items.length)
            .map((items, i) => (
              <div key={items[0].key}>
                {i > 0 && <MenuSeparator />}
                {items.map(renderItem)}
              </div>
            ))}
        </>
      )}
      {error && (
        <p role="alert" className="px-2 pt-1 text-xs text-danger">
          {error}
        </p>
      )}
      {info && !matches && (
        <>
          <MenuSeparator />
          <div className="px-2 pt-0.5 pb-1 text-xs text-fg-faint">
            <div className="font-medium">{t("rowMenu.lastEdited")}</div>
            <div className="mt-1 truncate text-fg-muted">{info.updatedBy ?? th("someone")}</div>
            <div>{edited}</div>
            <div className="mt-1">{th("wordCount", { words: info.words, characters: info.characters })}</div>
          </div>
        </>
      )}
    </>
  );

  const submenu = (title: string, body: React.ReactNode) => (
    <>
      <div className="flex items-center gap-1 px-1 pb-1">
        <button
          type="button"
          aria-label={t("propertyMenu.back")}
          onClick={() => setPage("main")}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
        </button>
        <span className="text-sm font-medium">{title}</span>
      </div>
      {body}
    </>
  );

  const content =
    page === "icon"
      ? submenu(
          t("rowMenu.editIcon"),
          <>
            <div className="grid grid-cols-8 gap-0.5">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={then(() => void api.setRowIcon(row.id, e))}
                  className={cn("flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-bg-hover", row.icon === e && "bg-bg-hover")}
                >
                  {e}
                </button>
              ))}
            </div>
            {row.icon && (
              <>
                <MenuSeparator />
                <MenuItem icon={icon(Trash2)} onClick={then(() => void api.setRowIcon(row.id, null))}>
                  {ti("remove")}
                </MenuItem>
              </>
            )}
          </>,
        )
      : page === "property"
        ? submenu(
            t("rowMenu.editProperty"),
            <div className="max-h-80 overflow-y-auto">
              {columns.map((c) => (
                <MenuItem
                  key={c.key}
                  icon={<PropertyTypeIcon type={c.type} />}
                  onClick={then(() => onEditProperty(c.key))}
                >
                  {c.name}
                </MenuItem>
              ))}
            </div>,
          )
        : page === "openIn"
          ? submenu(
              t("rowMenu.openIn"),
              <>
                {opener.inPanel && (
                  <MenuItem icon={<PanelRight className="h-3.5 w-3.5 rtl:-scale-x-100" />} onClick={then(() => opener.open(row.id))}>
                    {t("rowMenu.sidePanel")}
                  </MenuItem>
                )}
                <MenuItem icon={icon(Maximize2)} onClick={then(() => opener.openPage(row.id))}>
                  {t("rowMenu.fullPage")}
                </MenuItem>
                <MenuItem icon={icon(ExternalLink)} onClick={then(() => openInNewTab(opener.href(row.id)))}>
                  {t("rowMenu.newTab")}
                </MenuItem>
              </>,
            )
          : page === "developer"
            ? submenu(
                t("rowMenu.developer"),
                <>
                  {/* For the REST API and MCP clients, which take a row's or a database's id. */}
                  <MenuItem icon={icon(Hash)} onClick={copy(row.id)}>
                    {th("copyId")}
                  </MenuItem>
                  <MenuItem icon={icon(Hash)} onClick={copy(databaseId)}>
                    {t("rowMenu.copyDatabaseId")}
                  </MenuItem>
                </>,
              )
            : main;

  return (
    <>
      {/* A div rather than a button: some browsers don't start a drag from a button. */}
      <div
        ref={menu.ref}
        role="button"
        tabIndex={0}
        aria-label={t("table.rowActions")}
        title={drag ? `${t("table.dragToMove")}\n${t("table.clickForMenu")}` : sorted ? t("table.sortedNoDrag") : t("table.rowActions")}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => (menu.open ? close() : menu.setOpen(true))}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          if (menu.open) close();
          else menu.setOpen(true);
        }}
        draggable={!!drag}
        onDragStart={(e) => {
          if (!drag) return;
          close();
          drag.onDragStart(e);
          // The whole row follows the pointer, not just the handle.
          const tr = e.currentTarget.closest("tr");
          if (tr) e.dataTransfer.setDragImage(tr, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
        }}
        onDragEnd={drag?.onDragEnd}
        className={cn(
          "flex h-6 w-5 items-center justify-center rounded text-fg-faint select-none hover:bg-bg-hover hover:text-fg",
          drag ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          menu.open ? "visible" : "invisible group-hover:visible pointer-coarse:visible",
        )}
      >
        <GripVertical className="h-4 w-4" />
      </div>
      <Floating open={menu.open} anchor={menu.el} onClose={close} className={cn("w-64", pending && "pointer-events-none opacity-70")}>
        {content}
      </Floating>
      {dialog === "move" &&
        info &&
        createPortal(
          <MoveDialog
            workspaceId={workspaceId}
            pageId={row.id}
            isDatabase={false}
            currentParentId={databaseId}
            guest={info.guest}
            onClose={() => setDialog(null)}
            onMoved={() => void api.refetch()}
          />,
          document.body,
        )}
      {dialog === "merge" && (
        <MergeWithDialog
          rowId={row.id}
          onClose={() => setDialog(null)}
          onMerged={() => {
            setDialog(null);
            void api.refetch();
          }}
        />
      )}
    </>
  );
}
