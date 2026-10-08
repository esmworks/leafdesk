"use client";

import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  CloudOff,
  Database,
  FileText,
  House,
  Inbox,
  Keyboard,
  LayoutTemplate,
  LogOut,
  LogOut as LeaveIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Trash2,
  Upload,
  UserRound,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { unreadCountAction } from "@/app/actions/notifications";
import { listFavoritesAction } from "@/app/actions/page-menu";
import { archivePageAction, createPageAction, getSidebarAction, movePageAction, renamePageAction } from "@/app/actions/pages";
import { leaveTeamspaceAction } from "@/app/actions/teamspaces";
import { setSidebarLayoutAction } from "@/app/actions/workspaces";
import type { FavoritePage } from "@/server/page-meta";
import { useChannel } from "@/components/collab/use-channel";
import { ViewIcon } from "@/components/database/property-icons";
import { markNewPage } from "@/components/page/new-page-focus";
import { cn, IconButton, MenuItem, MenuSeparator, PageIcon, pageLabel, Popover } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import type { PageKind } from "@/db/schema/app";
import { authClient } from "@/lib/auth-client";
import { closeOfflineDocs } from "@/components/collab/socket";
import { useIsOffline } from "@/components/offline/offline-context";
import { loadSnapshot, readOfflineState, saveSnapshot, treeSnapshotKey, wipeAllOfflineData } from "@/components/offline/offline-store";
import { InstallAppMenuItem } from "@/components/offline/install-app";
import { FAVORITES_EVENT } from "@/lib/favorites-event";
import { comboText, isMac, opensShortcuts } from "@/lib/shortcuts";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { INBOX_PREFERENCES_EVENT } from "@/lib/inbox-event";
import type { TreeNode } from "@/server/pages";
import type { TeamspaceSummary } from "@/server/teamspaces";
import type { JoinableWorkspace } from "@/server/join-requests";
import { JoinableWorkspaces } from "./joinable-workspaces";
import { PRIVATE_SECTION, SHARED_SECTION, type TreeSection } from "@/lib/tree-sections";
import { sidebarOrder, withSection, type SidebarLayout, type SidebarSection } from "@/lib/sidebar-sections";
import { CustomizeSections } from "./customize-sections";
import { TeamspaceDialog } from "@/components/teamspaces/teamspace-dialog";
import { useAiChat } from "@/components/ai-chat/chat-panel";
import { ConversationList } from "@/components/ai-chat/conversation-list";
import { chatPath, isChatPath } from "@/lib/ai-chat";
import { InboxDialog } from "./inbox-dialog";
import { NewWorkspaceDialog } from "./new-workspace-dialog";
import { SearchDialog } from "./search-dialog";
import { SIDEBAR_WIDTH } from "@/lib/sidebar-layout";
import { isSettingsPath, SidebarPeekEdge, useSidebar } from "./sidebar-context";
import { TrashDialog } from "./trash-dialog";
import { TemplatesDialog } from "@/components/workspace/templates-dialog";
import { ImportDialog } from "@/components/workspace/import-dialog";

type Workspace = { id: string; name: string; icon: string | null; role: string };

const EXPANDED_KEY = "leafdesk:expanded";
/** Teamspaces the user opened: like pages, a teamspace stays closed until opened. */
const OPEN_TEAMSPACES_KEY = "leafdesk:open-teamspaces";
const TEAMSPACES_GROUP: SidebarSection = "teamspaces";
const FAVORITES_SECTION: SidebarSection = "favorites";
/** Top-level pages "Private" and "Shared" show before a "More" row. */
const SECTION_LIMIT = 10;

const canEdit = (node: TreeNode) => node.level === "edit" || node.level === "full";

function loadSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]"));
  } catch {
    return new Set();
  }
}

function saveSet(key: string, set: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {}
}

/** Where a new top-level page goes: a teamspace, null for private, undefined for the workspace default. */
type Target = string | null | undefined;

export function Sidebar({
  workspaceId,
  workspaces,
  initialTree,
  initialTeamspaces,
  canCreateTeamspace,
  canCreateWorkspace,
  isInstanceAdmin,
  initialFavorites,
  topLevel,
  initialLayout,
  user,
  joinable = [],
}: {
  workspaceId: string;
  workspaces: Workspace[];
  /** Workspaces their email domain lets them join or ask to join (allowed email domains). */
  joinable?: JoinableWorkspace[];
  initialTree: TreeNode[];
  /** The teamspaces they are in, each a sidebar section. */
  initialTeamspaces: TeamspaceSummary[];
  canCreateTeamspace: boolean;
  /** WORKSPACE_CREATION may keep "New workspace" to the server's administrators. */
  canCreateWorkspace: boolean;
  /** Listed in ADMIN_EMAILS: the menu links to /admin. */
  isInstanceAdmin: boolean;
  initialFavorites: FavoritePage[];
  /** Whether they may add top-level pages; a guest's are private to them. */
  topLevel: "shared" | "private" | null;
  /** How they arranged the sidebar in this workspace: section order, hidden and folded sections. */
  initialLayout: SidebarLayout;
  user: { id: string; name: string; email: string; image: string | null };
}) {
  const router = useRouter();
  const t = useTranslations("sidebar");
  const tc = useTranslations("common");
  const pathname = usePathname();
  const activeId = /\/p\/([\w-]+)/.exec(pathname)?.[1] ?? null;
  const activeViewId = useSearchParams().get("view");
  const sidebar = useSidebar();
  const [tree, setTree] = useState(initialTree);
  const [teamspaces, setTeamspaces] = useState(initialTeamspaces);
  const [layout, setLayout] = useState(initialLayout);
  const folded = useMemo(() => new Set<string>(layout.folded ?? []), [layout.folded]);
  // Folded sections opened to show the page being opened: only here, the saved layout stays folded.
  const [revealedSections, setRevealedSections] = useState<Set<string>>(() => new Set());
  const isFolded = (section: SidebarSection) => folded.has(section) && !revealedSections.has(section);
  // Layout saves still on their way: a server render read before they land mustn't undo them.
  const savingLayout = useRef(0);
  const [customizing, setCustomizing] = useState(false);
  const [openSpaces, setOpenSpaces] = useState<Set<string>>(() => new Set());
  // Sections showing all their top-level pages rather than the first SECTION_LIMIT.
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());
  const [teamspaceDialog, setTeamspaceDialog] = useState<{ teamspace?: TeamspaceSummary } | null>(null);
  const [favorites, setFavorites] = useState(initialFavorites);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // The section the templates or import dialog was opened from.
  const [dialogTarget, setDialogTarget] = useState<Target>(undefined);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  // Bumped on every inbox signal so an open inbox reloads.
  const [inboxVersion, setInboxVersion] = useState(0);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [, startTransition] = useTransition();
  const [moveError, setMoveError] = useState(false);
  // Creating or trashing a page failed (e.g. access changed meanwhile), or leaving a teamspace did.
  const [actionError, setActionError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  // Guests only see pages shared with them (and their own private pages) and can't move pages to the top.
  const guest = workspace?.role === "guest";

  const offline = useIsOffline();
  const aiChat = useAiChat();
  const onChatPage = Boolean(aiChat) && isChatPath(pathname, workspaceId);
  const tAi = useTranslations("ai.chat");
  const tOffline = useTranslations("offline");
  const tShortcuts = useTranslations("shortcuts");
  /** Tooltip for a control that needs the server while it can't be reached. */
  const needsServer = (label: string) => (offline ? tOffline("needsConnection", { action: label }) : undefined);

  useEffect(() => {
    setExpanded(loadSet(EXPANDED_KEY));
    setOpenSpaces(loadSet(OPEN_TEAMSPACES_KEY));
    // Folded headings used to be kept here for every workspace at once; they are per workspace now.
    try {
      localStorage.removeItem("leafdesk:folded-sections");
    } catch {}
  }, []);
  useEffect(() => setTree(initialTree), [initialTree]);
  useEffect(() => {
    if (!savingLayout.current) setLayout(initialLayout);
  }, [initialLayout]);
  useEffect(() => setTeamspaces(initialTeamspaces), [initialTeamspaces]);
  useEffect(() => setFavorites(initialFavorites), [initialFavorites]);

  const refreshFavorites = useCallback(() => {
    listFavoritesAction(workspaceId).then(setFavorites).catch(() => {});
  }, [workspaceId]);
  const refresh = useCallback(() => {
    getSidebarAction(workspaceId)
      .then((next) => {
        setTree(next.tree);
        setTeamspaces(next.teamspaces);
      })
      .catch(() => {});
    // Renames, trash and sharing changes show up in Favorites too.
    refreshFavorites();
  }, [workspaceId, refreshFavorites]);
  const refreshInbox = useCallback(() => {
    unreadCountAction(workspaceId).then(setUnread).catch(() => {});
  }, [workspaceId]);
  // The tree as last loaded is kept in this browser; offline, it replaces the one the page came
  // with (a cached page may be older than the last tree seen).
  useEffect(() => {
    if (!offline) void saveSnapshot(user.id, treeSnapshotKey(workspaceId), { tree, teamspaces });
  }, [offline, tree, teamspaces, user.id, workspaceId]);
  useEffect(() => {
    if (!offline) return;
    let current = true;
    void loadSnapshot<{ tree: TreeNode[]; teamspaces: TeamspaceSummary[] }>(user.id, treeSnapshotKey(workspaceId)).then((kept) => {
      // Copies from before teamspaces were kept as a bare tree; those wait for the next load.
      if (!current || !kept || Array.isArray(kept.data)) return;
      setTree(kept.data.tree);
      setTeamspaces(kept.data.teamspaces);
    });
    return () => {
      current = false;
    };
  }, [offline, user.id, workspaceId]);
  // Back online: signals sent while the connection was down were missed.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (offline) wasOffline.current = true;
    else if (wasOffline.current) {
      wasOffline.current = false;
      refresh();
      refreshInbox();
    }
  }, [offline, refresh, refreshInbox]);

  useChannel(`ws:${workspaceId}`, (event) => {
    if (event === "inbox") {
      refreshInbox();
      setInboxVersion((v) => v + 1);
    } else refresh();
  });
  // Also on focus: a signal sent while the connection was down would otherwise be missed.
  useEffect(() => {
    refreshInbox();
    window.addEventListener("focus", refreshInbox);
    window.addEventListener(INBOX_PREFERENCES_EVENT, refreshInbox);
    return () => {
      window.removeEventListener("focus", refreshInbox);
      window.removeEventListener(INBOX_PREFERENCES_EVENT, refreshInbox);
    };
  }, [refreshInbox]);
  useEffect(() => {
    window.addEventListener(FAVORITES_EVENT, refreshFavorites);
    return () => window.removeEventListener(FAVORITES_EVENT, refreshFavorites);
  }, [refreshFavorites]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (opensShortcuts(e, isMac())) {
        e.preventDefault();
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Pages by parent; the tops of the sections under `@<section>`.
  const children = useMemo(() => {
    const map = new Map<string, TreeNode[]>();
    const ids = new Set(tree.map((n) => n.id));
    for (const node of tree) {
      // Children of hidden parents (e.g. rows) never reach the tree; orphans go to the top.
      const key = node.parentId && ids.has(node.parentId) ? node.parentId : `@${node.section}`;
      map.set(key, [...(map.get(key) ?? []), node]);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [tree]);
  const byId = useMemo(() => new Map(tree.map((n) => [n.id, n])), [tree]);
  const rootsOf = (section: TreeSection) => children.get(`@${section}`) ?? [];

  /** The teamspace a page lands in under `parentId`, or at the top of `section` (null: private). */
  function spaceAt(parentId: string | null, section: TreeSection) {
    if (parentId) return byId.get(parentId)?.teamspaceId ?? null;
    return section === PRIVATE_SECTION ? null : section;
  }

  /**
   * Whether a dragged page may go under `parentId`, or to the top of `section` when that is null,
   * mirroring movePage's checks.
   */
  function canDrop(draggedId: string, parentId: string | null, section: TreeSection) {
    const dragged = byId.get(draggedId);
    if (!dragged || !canEdit(dragged)) return false;
    // Not into itself or one of its subpages: that would cut the branch off the tree.
    for (let id = parentId; id; id = byId.get(id)?.parentId ?? null) if (id === draggedId) return false;
    if (!parentId) {
      // The top of "shared" is not a place: those pages live elsewhere.
      if (section === SHARED_SECTION) return false;
      if (dragged.parentId === null && dragged.section === section) return true;
      if (guest || dragged.level !== "full") return false;
      return section === PRIVATE_SECTION || teamspaces.some((ts) => ts.id === section);
    }
    if (parentId === dragged.parentId) return true;
    // Another parent changes who inherits access to the page: that takes full access.
    if (dragged.level !== "full") return false;
    const parent = byId.get(parentId);
    return !!parent && canEdit(parent) && !(parent.kind === "database" && dragged.kind === "database");
  }

  /**
   * Saves part of the sidebar's layout in this workspace, for this person on every device. Only the
   * parts given are sent, so another tab changing other parts meanwhile keeps its change.
   */
  function saveLayout(patch: SidebarLayout) {
    setLayout((prev) => ({ ...prev, ...patch }));
    savingLayout.current++;
    setSidebarLayoutAction(workspaceId, patch)
      // Offline or failed, it still applies here until the next load; folding isn't worth an error.
      .catch(() => {})
      .finally(() => savingLayout.current--);
  }

  const sectionLabel = (key: SidebarSection) =>
    ({
      favorites: t("pages.favorites"),
      teamspaces: t("teamspaces.heading"),
      shared: t("sections.shared"),
      private: t("sections.private"),
    })[key];

  /** Folds or unfolds a section heading (`open` unfolds or folds it; without it, it toggles). */
  function fold(section: SidebarSection, open?: boolean) {
    const foldIt = open === undefined ? !isFolded(section) : !open;
    setRevealedSections((prev) => withMember(prev, section, false));
    if (foldIt !== folded.has(section)) saveLayout({ folded: withSection(layout, "folded", section, foldIt).folded });
  }

  /** Opens a folded section to show a page, without changing how it is saved. */
  function reveal(section: SidebarSection) {
    if (folded.has(section)) setRevealedSections((prev) => withMember(prev, section, true));
  }

  function toggle(id: string, open?: boolean) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      saveSet(EXPANDED_KEY, next);
      return next;
    });
  }

  function toggleSpace(id: string, open?: boolean) {
    setOpenSpaces((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      saveSet(OPEN_TEAMSPACES_KEY, next);
      return next;
    });
  }

  // Opening a page (a link, search, a new page) unfolds the way to it, once per page, so the
  // sidebar shows where it is; folding it again afterwards is left alone.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    const node = activeId ? byId.get(activeId) : undefined;
    if (!node || revealed.current === activeId) return;
    revealed.current = activeId;
    const ancestors: string[] = [];
    for (let id = node.parentId; id; id = byId.get(id)?.parentId ?? null) {
      if (ancestors.includes(id)) break;
      ancestors.push(id);
    }
    if (ancestors.some((id) => !expanded.has(id))) {
      setExpanded((prev) => {
        const next = new Set([...prev, ...ancestors]);
        saveSet(EXPANDED_KEY, next);
        return next;
      });
    }
    const section = node.section;
    if (section === PRIVATE_SECTION || section === SHARED_SECTION) reveal(section);
    else {
      reveal(TEAMSPACES_GROUP);
      toggleSpace(section, true);
    }
    requestAnimationFrame(() =>
      document.querySelector(`[data-sidebar-page="${CSS.escape(node.id)}"]`)?.scrollIntoView({ block: "nearest" }),
    );
    // Only when another page opens (or the tree first holds it), not on every fold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, byId]);

  function create(parentId: string | null, kind: PageKind = "page", target?: Target) {
    setActionError(null);
    startTransition(async () => {
      try {
        const { id } = await createPageAction({ workspaceId, parentId, kind, ...(parentId ? {} : { teamspaceId: target }) });
        if (parentId) toggle(parentId, true);
        else if (target) toggleSpace(target, true);
        else if (target === null) fold(PRIVATE_SECTION, true);
        markNewPage(id);
        router.push(`/w/${workspaceId}/p/${id}`);
      } catch {
        setActionError(tc("genericError"));
      } finally {
        refresh();
      }
    });
  }

  function archive(id: string) {
    setActionError(null);
    startTransition(async () => {
      try {
        await archivePageAction(id);
        if (activeId === id) router.refresh();
      } catch {
        setActionError(tc("genericError"));
      } finally {
        refresh();
      }
    });
  }

  function rename(id: string, title: string) {
    const before = byId.get(id)?.title;
    if (title === before) return;
    setActionError(null);
    // Shown right away: the saved title reaches the tree only once the page's doc is stored.
    setTree((t) => t.map((n) => (n.id === id ? { ...n, title } : n)));
    startTransition(async () => {
      const undo = (message: string) => {
        setTree((t) => t.map((n) => (n.id === id && before !== undefined ? { ...n, title: before } : n)));
        setActionError(message);
      };
      try {
        const result = await renamePageAction(id, title);
        if (!result.ok) undo(t("pages.renameLocked"));
      } catch {
        undo(t("pages.renameFailed"));
      }
    });
  }

  function placeName(space: string | null) {
    return space ? (teamspaces.find((ts) => ts.id === space)?.name ?? t("teamspaces.another")) : t("sections.private");
  }

  function move(id: string, parentId: string | null, position: number, section: TreeSection) {
    const dragged = byId.get(id);
    const space = spaceAt(parentId, section);
    // Another teamspace (or private) means other people see it: say so before it happens.
    if (dragged && space !== dragged.teamspaceId && !confirm(t("pages.confirmMoveSpace", { place: placeName(space) }))) return;
    setTree((t) =>
      t.map((n) => (n.id === id ? { ...n, parentId, position, ...(parentId ? {} : { section, teamspaceId: space }) } : n)),
    );
    if (parentId) toggle(parentId, true);
    setMoveError(false);
    startTransition(async () => {
      try {
        await movePageAction(id, parentId, position, parentId ? undefined : space);
      } catch {
        // Usually access: a new parent needs full access on the page. The refresh puts it back.
        setMoveError(true);
      } finally {
        refresh();
      }
    });
  }
  useEffect(() => {
    if (!moveError) return;
    const timer = setTimeout(() => setMoveError(false), 5000);
    return () => clearTimeout(timer);
  }, [moveError]);
  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 5000);
    return () => clearTimeout(timer);
  }, [actionError]);

  function leave(ts: TeamspaceSummary) {
    if (!confirm(t("teamspaces.confirmLeave", { name: ts.name }))) return;
    setActionError(null);
    startTransition(async () => {
      const result = await leaveTeamspaceAction(workspaceId, ts.id);
      if (!result.ok) setActionError(result.error);
      refresh();
      router.refresh();
    });
  }

  function openTemplates(target: Target) {
    setDialogTarget(target);
    setTemplatesOpen(true);
  }

  function openImport(target: Target) {
    setDialogTarget(target);
    setImportOpen(true);
  }

  /** The "+" menu of a section: what to add at its top. */
  // eslint-disable-next-line react/display-name -- a Popover render callback, not a component
  const newMenu = (target: string | null) => (close: () => void) => (
    <>
      <MenuItem
        icon={<FileText className="h-4 w-4" />}
        onClick={() => {
          close();
          create(null, "page", target);
        }}
      >
        {t("pages.newPage")}
      </MenuItem>
      <MenuItem
        icon={<Database className="h-4 w-4" />}
        onClick={() => {
          close();
          create(null, "database", target);
        }}
      >
        {t("pages.newDatabase")}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<LayoutTemplate className="h-4 w-4" />}
        onClick={() => {
          close();
          openTemplates(target);
        }}
      >
        {t("pages.fromTemplate")}
      </MenuItem>
      <MenuItem
        icon={<Upload className="h-4 w-4" />}
        onClick={() => {
          close();
          openImport(target);
        }}
      >
        {t("pages.import")}
      </MenuItem>
    </>
  );

  async function signOut() {
    // Edits made offline that never reached the server are lost with the offline copies.
    if (readOfflineState(user.id).dirty.length && !confirm(tOffline("signOutUnsynced"))) return;
    await authClient.signOut();
    // Nothing of this account stays in the browser: offline pages, rows and cached HTML.
    await closeOfflineDocs();
    await wipeAllOfflineData();
    router.push("/sign-in");
    router.refresh();
  }

  const accountPath = `/w/${workspaceId}/settings?tab=profile`;
  const treeProps: TreeContext = {
    childrenOf: children,
    expanded,
    activeId,
    activeViewId,
    workspaceId,
    onToggle: toggle,
    onCreate: create,
    onArchive: archive,
    onRename: rename,
    onMove: move,
    dragging,
    onDragging: setDragging,
    canDrop,
    offline,
  };

  if (isSettingsPath(pathname)) return null;

  // Each section as it shows (or null when it has nothing to show), placed in the person's order.
  const sectionContent: Record<SidebarSection, React.ReactNode> = {
    favorites: favorites.length > 0 && (
      <SectionGroup label={t("pages.favorites")} open={!isFolded(FAVORITES_SECTION)} onToggle={() => fold(FAVORITES_SECTION)}>
        <ul className="space-y-px">
          {favorites.map((f) => (
            <li key={f.id}>
              <Link
                href={`/w/${workspaceId}/p/${f.id}`}
                className={cn(
                  "flex h-7 items-center gap-0.5 rounded-md pl-1 hover:bg-bg-hover",
                  activeId === f.id && "bg-bg-active font-medium",
                )}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                  <PageIcon icon={f.icon} kind={f.kind} className="text-sm" />
                </span>
                <span className="truncate pl-0.5">{pageLabel(f.title, tc("untitled"))}</span>
              </Link>
            </li>
          ))}
        </ul>
      </SectionGroup>
    ),
    teamspaces: !guest && (
      <SectionGroup
        label={t("teamspaces.heading")}
        open={!isFolded(TEAMSPACES_GROUP)}
        onToggle={() => fold(TEAMSPACES_GROUP)}
        actions={
          <Popover
            align="end"
            trigger={({ toggle }) => (
              <IconButton label={t("teamspaces.options")} onClick={toggle}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            {(close) => (
              <>
                {canCreateTeamspace && (
                  <MenuItem
                    icon={<Plus className="h-4 w-4" />}
                    disabled={offline}
                    title={needsServer(t("teamspaces.new"))}
                    onClick={() => {
                      close();
                      setTeamspaceDialog({});
                    }}
                  >
                    {t("teamspaces.new")}
                  </MenuItem>
                )}
                <MenuItem
                  icon={<Users className="h-4 w-4" />}
                  onClick={() => {
                    close();
                    router.push(`/w/${workspaceId}/settings?tab=teamspaces`);
                  }}
                >
                  {t("teamspaces.browse")}
                </MenuItem>
              </>
            )}
          </Popover>
        }
      >
        {teamspaces.length === 0 && (
          <Link
            href={`/w/${workspaceId}/settings?tab=teamspaces`}
            className="block rounded-md px-2 py-1.5 text-xs text-fg-muted hover:bg-bg-hover"
          >
            {t("teamspaces.none")}
          </Link>
        )}
        <ul>
          {teamspaces.map((ts) => (
            <TeamspaceSection
              key={ts.id}
              teamspace={ts}
              open={openSpaces.has(ts.id)}
              onToggle={() => toggleSpace(ts.id)}
              roots={rootsOf(ts.id)}
              newMenu={newMenu(ts.id)}
              onCreate={() => create(null, "page", ts.id)}
              onEdit={ts.canManage ? () => setTeamspaceDialog({ teamspace: ts }) : undefined}
              onLeave={ts.canLeave ? () => leave(ts) : undefined}
              tree={treeProps}
            />
          ))}
        </ul>
        {/* "Add new": a new teamspace, or the list to join one from. */}
        <button
          type="button"
          onClick={() =>
            canCreateTeamspace ? setTeamspaceDialog({}) : router.push(`/w/${workspaceId}/settings?tab=teamspaces`)
          }
          disabled={canCreateTeamspace && offline}
          title={canCreateTeamspace ? needsServer(t("teamspaces.new")) : undefined}
          className="flex h-7 w-full items-center gap-0.5 rounded-md pl-1 text-left text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center">
            <Plus className="h-3.5 w-3.5" />
          </span>
          <span className="truncate pl-1.5">{canCreateTeamspace ? t("teamspaces.addNew") : t("teamspaces.browse")}</span>
        </button>
      </SectionGroup>
    ),
    shared: rootsOf(SHARED_SECTION).length > 0 && (
      <SectionGroup label={t("sections.shared")} open={!isFolded(SHARED_SECTION)} onToggle={() => fold(SHARED_SECTION)}>
        <LimitedRoots
          nodes={rootsOf(SHARED_SECTION)}
          all={showAll.has(SHARED_SECTION)}
          onAll={(all) => setShowAll((prev) => withMember(prev, SHARED_SECTION, all))}
          {...treeProps}
        />
      </SectionGroup>
    ),
    private: (topLevel || rootsOf(PRIVATE_SECTION).length > 0) && (
      <SectionGroup
        label={t("sections.private")}
        open={!isFolded(PRIVATE_SECTION)}
        onToggle={() => fold(PRIVATE_SECTION)}
        drop={{ section: PRIVATE_SECTION, roots: rootsOf(PRIVATE_SECTION), ...treeProps }}
        actions={
          topLevel && (
            <Popover
              align="end"
              trigger={({ toggle }) => (
                <IconButton label={t("sections.newPrivate")} onClick={toggle} disabled={offline} className="disabled:opacity-40 disabled:hover:bg-transparent">
                  <Plus className="h-3.5 w-3.5" />
                </IconButton>
              )}
            >
              {newMenu(null)}
            </Popover>
          )
        }
      >
        {rootsOf(PRIVATE_SECTION).length === 0 && topLevel && (
          <button
            type="button"
            onClick={() => create(null, "page", null)}
            disabled={offline}
            title={needsServer(t("pages.createFirst"))}
            className="w-full rounded-md px-2 py-1.5 text-left text-fg-muted hover:bg-bg-hover disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {t("pages.createFirst")}
          </button>
        )}
        <LimitedRoots
          nodes={rootsOf(PRIVATE_SECTION)}
          all={showAll.has(PRIVATE_SECTION)}
          onAll={(all) => setShowAll((prev) => withMember(prev, PRIVATE_SECTION, all))}
          {...treeProps}
        />
      </SectionGroup>
    ),
  };
  const hiddenSections = new Set(layout.hidden ?? []);

  return (
    <>
      {sidebar?.drawerOpen && (
        <div aria-hidden className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={sidebar.close} />
      )}
      <SidebarPeekEdge />
      <aside
        // Desktop: an in-flow column the user can resize, or — when hidden — a panel that slides out
        // over the page while hovered. Phones: a drawer over the page.
        style={{ "--sidebar-w": `${sidebar?.width ?? 256}px` } as React.CSSProperties}
        onMouseEnter={sidebar?.collapsed ? sidebar.showPeek : undefined}
        onMouseLeave={sidebar?.collapsed ? sidebar.hidePeek : undefined}
        className={cn(
          "relative flex shrink-0 flex-col border-r border-border bg-bg-subtle text-sm",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[min(18rem,85vw)] max-md:shadow-xl md:w-[var(--sidebar-w)]",
          sidebar?.collapsed &&
            "md:fixed md:top-12 md:bottom-3 md:left-0 md:z-50 md:rounded-r-xl md:border md:border-l-0 md:shadow-2xl md:transition-[translate,visibility] md:duration-200 md:ease-out",
          sidebar?.collapsed && (sidebar.peek ? "md:translate-x-0" : "md:invisible md:-translate-x-[calc(100%+1rem)]"),
          !sidebar?.drawerOpen && "max-md:hidden",
          // Phones: rows and their buttons grow from 28px to 36px so they are easy to tap.
          "max-md:[&_.h-7]:h-9 max-md:[&_.w-7]:w-9",
        )}
      >
        {sidebar && !sidebar.collapsed && <ResizeHandle />}
        <div className="p-2">
          <div className="group/head flex items-center gap-1">
            <Popover
              trigger={({ toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-bg-hover"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-fg text-[11px] font-semibold text-bg">
                    {workspace?.icon ?? workspace?.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="flex-1 truncate font-medium">{workspace?.name}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-fg-muted" />
                </button>
              )}
              className="w-64"
              wrapperClassName="flex min-w-0 flex-1"
            >
              {(close) => (
                <>
                  {/* Who is signed in; opens their account page (profile, password, sessions, …). */}
                  <button
                    type="button"
                    title={t("workspaceMenu.myAccount")}
                    onClick={() => {
                      close();
                      router.push(accountPath);
                    }}
                    className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left hover:bg-bg-hover"
                  >
                    <UserAvatar name={user.name || user.email} image={user.image} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{user.name || user.email}</span>
                      <span className="block truncate text-xs text-fg-muted">{user.email}</span>
                    </span>
                  </button>
                  <MenuSeparator />
                  {workspaces.map((w) => (
                    <MenuItem
                      key={w.id}
                      active={w.id === workspaceId}
                      onClick={() => {
                        close();
                        router.push(`/w/${w.id}`);
                      }}
                    >
                      {w.name}
                    </MenuItem>
                  ))}
                  {joinable.length > 0 && <JoinableWorkspaces workspaces={joinable} onJoined={close} />}
                  {canCreateWorkspace && (
                    <MenuItem
                      icon={<Plus className="h-4 w-4" />}
                      disabled={offline}
                      title={needsServer(t("workspaceMenu.newWorkspace"))}
                      onClick={() => {
                        close();
                        setNewWorkspaceOpen(true);
                      }}
                    >
                      {t("workspaceMenu.newWorkspace")}
                    </MenuItem>
                  )}
                  <MenuSeparator />
                  <MenuItem
                    icon={<Settings className="h-4 w-4" />}
                    onClick={() => {
                      close();
                      router.push(`/w/${workspaceId}/settings`);
                    }}
                  >
                    {t("workspaceMenu.settingsAndMembers")}
                  </MenuItem>
                  <MenuItem
                    icon={<UserRound className="h-4 w-4" />}
                    onClick={() => {
                      close();
                      router.push(accountPath);
                    }}
                  >
                    {t("workspaceMenu.myAccount")}
                  </MenuItem>
                  <MenuItem
                    icon={<Keyboard className="h-4 w-4" />}
                    trailing={<kbd className="font-sans text-xs text-fg-faint pointer-coarse:hidden">{comboText(["Mod", "/"], isMac())}</kbd>}
                    onClick={() => {
                      close();
                      setShortcutsOpen(true);
                    }}
                  >
                    {tShortcuts("title")}
                  </MenuItem>
                  {isInstanceAdmin && (
                    <MenuItem
                      icon={<ShieldCheck className="h-4 w-4" />}
                      onClick={() => {
                        close();
                        router.push(`/admin?from=${encodeURIComponent(workspaceId)}`);
                      }}
                    >
                      {t("workspaceMenu.admin")}
                    </MenuItem>
                  )}
                  <InstallAppMenuItem onDone={close} />
                  <MenuItem icon={<LogOut className="h-4 w-4" />} onClick={signOut} disabled={offline} title={needsServer(t("workspaceMenu.signOut"))}>
                    {t("workspaceMenu.signOut")}
                  </MenuItem>
                </>
              )}
            </Popover>
            <IconButton
              label={unread > 0 ? `${t("nav.inbox")} · ${t("inbox.unreadCount", { count: unread })}` : t("nav.inbox")}
              title={needsServer(t("nav.inbox"))}
              onClick={() => setInboxOpen(true)}
              disabled={offline}
              className="relative h-7 w-7 disabled:opacity-50"
            >
              <Inbox className="h-4 w-4" />
              {unread > 0 && (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-accent px-0.5 text-center text-[9px] leading-3.5 font-semibold text-white tabular-nums"
                >
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </IconButton>
            {topLevel && (
              <IconButton
                label={t("pages.newPage")}
                title={needsServer(t("pages.newPage"))}
                onClick={() => create(null, "page", undefined)}
                disabled={offline}
                className="h-7 w-7 disabled:opacity-50"
              >
                <SquarePen className="h-4 w-4" />
              </IconButton>
            )}
            {sidebar &&
              (sidebar.collapsed ? (
                // Floating over the page: offer to pin it back (desktop only; phones use the drawer).
                <IconButton
                  label={t("toggle.pin")}
                  title={`${t("toggle.pin")} (⌘\\)`}
                  onClick={sidebar.toggle}
                  className="hidden h-7 w-7 md:inline-flex"
                >
                  <ChevronsRight className="h-4 w-4" />
                </IconButton>
              ) : null)}
            {sidebar && (
              <IconButton
                label={t("toggle.close")}
                title={`${t("toggle.close")} (⌘\\)`}
                onClick={sidebar.toggle}
                className={cn(
                  "h-7 w-7 md:hidden md:group-hover/head:inline-flex md:focus-visible:inline-flex",
                  sidebar.collapsed && "md:!hidden",
                )}
              >
                <ChevronsLeft className="h-4 w-4" />
              </IconButton>
            )}
          </div>

          {offline && (
            <p role="status" className="mt-1 flex items-center gap-2 px-2 py-1 text-xs text-fg-muted" title={tOffline("hint")}>
              <CloudOff className="h-3.5 w-3.5 shrink-0" />
              {tOffline("banner")}
            </p>
          )}
          {/* Looks like a search field; opens the search dialog. */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            disabled={offline}
            title={needsServer(t("nav.search"))}
            className="mt-1.5 flex h-8 w-full items-center gap-2 rounded-md border border-border bg-bg px-2 text-left text-fg-muted shadow-xs hover:border-fg-faint hover:text-fg disabled:cursor-default disabled:opacity-50"
          >
            <Search className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">{t("nav.search")}</span>
            <kbd className="font-sans text-xs text-fg-faint pointer-coarse:hidden">⌘K</kbd>
          </button>
          <div className="mt-1.5 space-y-px">
            <div className="group/home flex items-center gap-0.5">
              <SidebarButton icon={<House className="h-4 w-4" />} href={`/w/${workspaceId}`} active={pathname === `/w/${workspaceId}`}>
                {t("nav.home")}
              </SidebarButton>
              {/* The people directory, like the members list, isn't for guests. */}
              {!guest && (
                <Link
                  href={`/w/${workspaceId}/people`}
                  aria-label={t("nav.people")}
                  title={t("nav.people")}
                  aria-current={pathname === `/w/${workspaceId}/people` ? "page" : undefined}
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg",
                    pathname === `/w/${workspaceId}/people` && "bg-bg-active text-fg",
                  )}
                >
                  <Users className="h-4 w-4" />
                </Link>
              )}
              {/* The full-page AI chat sits beside Home as an icon, keeping the list above the pages short. */}
              {aiChat &&
                (offline ? (
                  <button
                    type="button"
                    disabled
                    aria-label={tAi("open")}
                    title={needsServer(tAi("open"))}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted opacity-50"
                  >
                    <Sparkles className="h-4 w-4" />
                  </button>
                ) : (
                  <Link
                    href={chatPath(workspaceId)}
                    aria-label={tAi("open")}
                    title={tAi("open")}
                    aria-current={onChatPage ? "page" : undefined}
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg",
                      onChatPage && "bg-bg-active text-fg",
                    )}
                  >
                    <Sparkles className="h-4 w-4" />
                  </Link>
                ))}
            </div>
          </div>
        </div>

        <div className="pt-1" />
        {moveError && (
          <p role="alert" className="mx-4 mb-1 text-xs text-danger">
            {t("pages.moveFailed")}
          </p>
        )}
        {actionError && (
          <p role="alert" className="mx-4 mb-1 text-xs text-danger">
            {actionError}
          </p>
        )}
        <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label={onChatPage ? tAi("history") : t("pages.heading")}>
          {/* The full-page chat lists the conversations in place of the pages. */}
          {onChatPage ? (
            <ConversationList />
          ) : customizing ? (
            <CustomizeSections
              sections={sidebarOrder(layout)
                .filter((key) => !(guest && key === TEAMSPACES_GROUP))
                .map((key) => ({ key, label: sectionLabel(key) }))}
              hidden={hiddenSections}
              onChange={(order, hidden) => saveLayout({ order, hidden })}
              onDone={() => setCustomizing(false)}
            />
          ) : (
            sidebarOrder(layout)
              .filter((key) => !hiddenSections.has(key))
              .map((key) => <Fragment key={key}>{sectionContent[key]}</Fragment>)
          )}
          {!onChatPage && guest && tree.length === 0 && !topLevel && <p className="px-2 py-1.5 text-fg-muted">{t("pages.nothingShared")}</p>}
        </nav>

        <div className="flex items-center gap-0.5 border-t border-border px-2 py-1.5">
          <FooterButton
            icon={<Settings className="h-4 w-4" />}
            label={t("nav.settings")}
            href={`/w/${workspaceId}/settings`}
            active={pathname.startsWith(`/w/${workspaceId}/settings`)}
          />
          {/* Templates live here rather than in the page tree; making pages from them needs the top level. */}
          {topLevel && (
            <FooterButton
              icon={<LayoutTemplate className="h-4 w-4" />}
              label={t("nav.templates")}
              onClick={() => openTemplates(undefined)}
              disabled={offline}
              title={needsServer(t("nav.templates"))}
            />
          )}
          <FooterButton
            icon={<SlidersHorizontal className="h-4 w-4" />}
            label={t("customize.open")}
            onClick={() => setCustomizing(!customizing)}
            active={customizing}
          />
          <FooterButton
            icon={<Upload className="h-4 w-4" />}
            label={t("nav.import")}
            onClick={() => openImport(undefined)}
            disabled={offline}
            title={needsServer(t("nav.import"))}
          />
          <FooterButton
            icon={<Trash2 className="h-4 w-4" />}
            label={t("nav.trash")}
            onClick={() => setTrashOpen(true)}
            disabled={offline}
            title={needsServer(t("nav.trash"))}
          />
        </div>
      </aside>
      {/* Outside the aside: its slide transform would otherwise anchor these fixed dialogs. */}
      <SearchDialog workspaceId={workspaceId} open={searchOpen} onClose={() => setSearchOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <InboxDialog
        workspaceId={workspaceId}
        open={inboxOpen}
        onClose={() => setInboxOpen(false)}
        version={inboxVersion}
        onRead={refreshInbox}
      />
      {canCreateWorkspace && <NewWorkspaceDialog open={newWorkspaceOpen} onClose={() => setNewWorkspaceOpen(false)} />}
      <TemplatesDialog
        workspaceId={workspaceId}
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        teamspaceId={dialogTarget}
      />
      <ImportDialog
        workspaceId={workspaceId}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        tree={tree}
        topLevel={Boolean(topLevel)}
        // From a section's menu it starts at that section's top rather than at the open page.
        activeId={dialogTarget === undefined ? activeId : null}
        teamspaceId={dialogTarget}
      />
      <TeamspaceDialog
        workspaceId={workspaceId}
        open={teamspaceDialog !== null}
        onClose={() => setTeamspaceDialog(null)}
        teamspace={teamspaceDialog?.teamspace}
        isWorkspaceOwner={workspace?.role === "owner"}
        onSaved={(id) => {
          if (!teamspaceDialog?.teamspace) toggleSpace(id, true);
          setTeamspaceDialog(null);
          refresh();
        }}
      />
      <TrashDialog
        workspaceId={workspaceId}
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onChange={() => {
          refresh();
          router.refresh();
        }}
      />
    </>
  );
}

/** Dropping a page on a section's heading puts it last at the top of that section. */
type RootDrop = TreeContext & { section: TreeSection; roots: TreeNode[] };

function useRootDrop(drop: RootDrop | undefined) {
  const [over, setOver] = useState(false);
  if (!drop) return { over: false, handlers: {} };
  const { section, roots, dragging, onDragging, canDrop, onMove } = drop;
  const handlers = {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE) || !dragging || !canDrop(dragging, null, section)) return setOver(false);
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      onDragging(null);
      const draggedId = e.dataTransfer.getData(DRAG_TYPE);
      if (!draggedId || !canDrop(draggedId, null, section)) return;
      const last = roots.filter((n) => n.id !== draggedId).at(-1);
      onMove(draggedId, null, (last?.position ?? 0) + 1, section);
    },
  };
  return { over, handlers };
}

function withMember(set: Set<string>, value: string, member: boolean) {
  const next = new Set(set);
  if (member) next.add(value);
  else next.delete(value);
  return next;
}

/**
 * The top-level pages of "Private" or "Shared": the first SECTION_LIMIT, then a row showing the
 * rest. The open page stays in sight among the first ones.
 */
function LimitedRoots({
  nodes,
  all,
  onAll,
  ...tree
}: TreeContext & { nodes: TreeNode[]; all: boolean; onAll: (all: boolean) => void }) {
  const t = useTranslations("sidebar.sections");
  const over = nodes.length > SECTION_LIMIT;
  let shown = nodes;
  if (over && !all) {
    shown = nodes.slice(0, SECTION_LIMIT);
    // The open page, or the top of the branch it is in.
    let top = tree.activeId;
    const parents = new Map<string, string | null>();
    for (const [key, list] of tree.childrenOf) for (const n of list) parents.set(n.id, key.startsWith("@") ? null : key);
    for (let up = top ? parents.get(top) : null; up; up = parents.get(up) ?? null) top = up;
    const active = nodes.find((n) => n.id === top);
    if (active && !shown.includes(active)) shown = [...shown, active];
  }
  const hidden = nodes.length - shown.length;
  return (
    <>
      <TreeLevel nodes={shown} depth={0} {...tree} />
      {(all ? over : hidden > 0) && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => onAll(!all)}
          className="flex h-7 w-full items-center gap-0.5 rounded-md pl-1 text-left text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center">
            {all ? <ChevronUp className="h-3.5 w-3.5" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
          </span>
          <span className="pl-0.5">{all ? t("less") : t("more", { count: hidden })}</span>
        </button>
      )}
    </>
  );
}

/** A heading ("Teamspaces", "Shared", "Private") that folds what is under it. */
function SectionGroup({
  label,
  open,
  onToggle,
  actions,
  drop,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  drop?: RootDrop;
  children: React.ReactNode;
}) {
  const { over, handlers } = useRootDrop(drop);
  return (
    <section className="mb-2" aria-label={label}>
      <div
        {...handlers}
        className={cn("group/section flex h-7 items-center rounded-md pr-1 hover:bg-bg-hover has-[[data-open]]:bg-bg-hover", over && "bg-accent/15")}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-left text-xs font-medium text-fg-muted"
        >
          <span className="truncate">{label}</span>
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 opacity-0 group-hover/section:opacity-100 pointer-coarse:opacity-100" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
        </button>
        {actions && (
          <div className="flex items-center opacity-0 group-hover/section:opacity-100 focus-within:opacity-100 has-[[data-open]]:opacity-100 pointer-coarse:opacity-100">
            {actions}
          </div>
        )}
      </div>
      {open && children}
    </section>
  );
}

function TeamspaceIcon({ teamspace }: { teamspace: TeamspaceSummary }) {
  if (teamspace.icon) return <span className="text-sm leading-none">{teamspace.icon}</span>;
  return (
    <span className="flex h-4 w-4 items-center justify-center rounded bg-fg-muted text-[10px] font-semibold text-bg">
      {teamspace.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** A teamspace the user is in: its heading row (a drop target) and, unfolded, its pages. */
function TeamspaceSection({
  teamspace,
  open,
  onToggle,
  roots,
  newMenu,
  onCreate,
  onEdit,
  onLeave,
  tree,
}: {
  teamspace: TeamspaceSummary;
  open: boolean;
  onToggle: () => void;
  roots: TreeNode[];
  newMenu: (close: () => void) => React.ReactNode;
  onCreate: () => void;
  onEdit?: () => void;
  onLeave?: () => void;
  tree: TreeContext;
}) {
  const t = useTranslations("sidebar");
  const router = useRouter();
  const { over, handlers } = useRootDrop({ ...tree, section: teamspace.id, roots });
  return (
    <li>
      <div
        {...handlers}
        data-teamspace={teamspace.id}
        className={cn("group relative flex h-7 items-center gap-0.5 rounded-md pr-1 pl-1 hover:bg-bg-hover has-[[data-open]]:bg-bg-hover", over && "bg-accent/15")}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          title={teamspace.description || undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center">
            <span className="flex group-hover:hidden pointer-coarse:hidden">
              <TeamspaceIcon teamspace={teamspace} />
            </span>
            {open ? (
              <ChevronDown className="hidden h-3.5 w-3.5 text-fg-faint group-hover:block pointer-coarse:block" />
            ) : (
              <ChevronRight className="hidden h-3.5 w-3.5 text-fg-faint group-hover:block pointer-coarse:block" />
            )}
          </span>
          <span className="truncate">{teamspace.name}</span>
        </button>
        <div className="hidden items-center group-hover:flex focus-within:flex has-[[data-open]]:flex pointer-coarse:flex">
          <Popover
            align="end"
            trigger={({ toggle }) => (
              <IconButton label={t("teamspaces.actions", { name: teamspace.name })} onClick={toggle}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            {(close) => (
              <>
                {onEdit && (
                  <MenuItem
                    icon={<Settings className="h-4 w-4" />}
                    disabled={tree.offline}
                    onClick={() => {
                      close();
                      onEdit();
                    }}
                  >
                    {t("teamspaces.edit")}
                  </MenuItem>
                )}
                <MenuItem
                  icon={<Users className="h-4 w-4" />}
                  onClick={() => {
                    close();
                    router.push(`/w/${tree.workspaceId}/settings?tab=teamspaces`);
                  }}
                >
                  {t("teamspaces.members")}
                </MenuItem>
                {onLeave && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      danger
                      icon={<LeaveIcon className="h-4 w-4" />}
                      disabled={tree.offline}
                      onClick={() => {
                        close();
                        onLeave();
                      }}
                    >
                      {t("teamspaces.leave")}
                    </MenuItem>
                  </>
                )}
              </>
            )}
          </Popover>
          <Popover
            align="end"
            trigger={({ toggle }) => (
              <IconButton
                label={t("teamspaces.addPage", { name: teamspace.name })}
                onClick={toggle}
                disabled={tree.offline}
                className="disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            {newMenu}
          </Popover>
        </div>
      </div>
      {open &&
        (roots.length > 0 ? (
          <TreeLevel nodes={roots} depth={1} {...tree} />
        ) : (
          <button
            type="button"
            onClick={onCreate}
            disabled={tree.offline}
            className="block w-full rounded-md py-1 pr-2 text-left text-xs text-fg-faint hover:bg-bg-hover disabled:hover:bg-transparent"
            style={{ paddingLeft: 32 }}
          >
            {t("teamspaces.empty")}
          </button>
        ))}
    </li>
  );
}

/** Drag the sidebar's right edge to resize it; double-click restores the default width. */
function ResizeHandle() {
  const t = useTranslations("sidebar.toggle");
  const sidebar = useSidebar();
  const start = useRef<{ x: number; width: number } | null>(null);
  if (!sidebar) return null;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("resize")}
      title={t("resize")}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width: sidebar.width };
      }}
      onPointerMove={(e) => {
        if (start.current) sidebar.setWidth(start.current.width + e.clientX - start.current.x);
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        sidebar.setWidth(start.current.width + e.clientX - start.current.x, true);
        start.current = null;
      }}
      onDoubleClick={() => sidebar.setWidth(SIDEBAR_WIDTH.default, true)}
      className="absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:transition-colors hover:after:bg-accent/60 md:block"
    />
  );
}

function SidebarButton({
  icon,
  children,
  onClick,
  href,
  hint,
  active,
  badge,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  hint?: string;
  active?: boolean;
  /** Needs the server, which can't be reached: `title` says so. */
  disabled?: boolean;
  title?: string;
  /** A count shown at the end (e.g. unread notifications), with its spoken label. */
  badge?: { count: number; label: string };
}) {
  const className = cn(
    "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-fg-muted hover:bg-bg-hover hover:text-fg",
    "disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-muted",
    active && "bg-bg-active font-medium text-fg hover:bg-bg-active",
  );
  const content = (
    <>
      {icon}
      <span className="flex-1">{children}</span>
      {hint && <span className="text-xs text-fg-faint pointer-coarse:hidden">{hint}</span>}
      {badge && (
        <span
          aria-label={badge.label}
          title={badge.label}
          className="min-w-5 rounded bg-accent px-1 text-center text-[11px] leading-[18px] font-medium text-white tabular-nums"
        >
          {badge.count > 99 ? "99+" : badge.count}
        </span>
      )}
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={className} disabled={disabled} title={title}>
      {content}
    </button>
  );
}

/** An icon in the sidebar's bottom bar; its name shows as a tooltip. */
function FooterButton({
  icon,
  label,
  href,
  onClick,
  active,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  href?: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  /** Tooltip instead of the label, e.g. why it is disabled. */
  title?: string;
}) {
  const className = cn(
    "flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg",
    "disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-muted",
    active && "bg-bg-active text-fg hover:bg-bg-active",
  );
  return href ? (
    <Link href={href} aria-label={label} title={title ?? label} aria-current={active ? "page" : undefined} className={className}>
      {icon}
    </Link>
  ) : (
    <button type="button" aria-label={label} title={title ?? label} onClick={onClick} disabled={disabled} className={className}>
      {icon}
    </button>
  );
}

type DropTarget = { id: string; zone: "before" | "inside" | "after" } | null;

type TreeContext = {
  childrenOf: Map<string, TreeNode[]>;
  expanded: Set<string>;
  activeId: string | null;
  activeViewId: string | null;
  workspaceId: string;
  onToggle: (id: string, open?: boolean) => void;
  onCreate: (parentId: string | null, kind?: PageKind) => void;
  onArchive: (id: string) => void;
  onRename: (id: string, title: string) => void;
  /** `section`: the section whose top it goes to when `parentId` is null. */
  onMove: (id: string, parentId: string | null, position: number, section: TreeSection) => void;
  /** The page being dragged in this tree, if any. */
  dragging: string | null;
  onDragging: (id: string | null) => void;
  canDrop: (draggedId: string, parentId: string | null, section: TreeSection) => boolean;
  /** No server: no creating, trashing or moving pages. */
  offline: boolean;
};

type TreeProps = TreeContext & { depth: number };

function TreeLevel({ nodes, ...props }: TreeProps & { nodes: TreeNode[] }) {
  return (
    <ul>
      {nodes.map((node, i) => (
        <TreeItem key={node.id} node={node} prev={nodes[i - 1]} next={nodes[i + 1]} {...props} />
      ))}
    </ul>
  );
}

const DRAG_TYPE = "application/x-leafdesk-page";

function TreeItem({
  node,
  prev,
  next,
  ...props
}: TreeProps & { node: TreeNode; prev?: TreeNode; next?: TreeNode }) {
  const { depth, childrenOf, expanded, activeId, activeViewId, workspaceId, onToggle, onCreate, onArchive, onRename, onMove } = props;
  const { dragging, onDragging, canDrop } = props;
  const t = useTranslations("sidebar");
  const tc = useTranslations("common");
  const kids = childrenOf.get(node.id) ?? [];
  const isOpen = expanded.has(node.id);
  const [drop, setDrop] = useState<DropTarget>(null);
  const [renaming, setRenaming] = useState(false);
  // Escape closes the field without saving: the blur that follows must not save it.
  const renameCancelled = useRef(false);
  // Database rows are not shown in the tree; dropping into a database would turn a page into a row.
  const canNest = node.kind === "page";
  // Trashing, adding subpages and moving all need edit access on the server (and the server).
  const editable = canEdit(node) && !props.offline;
  // Databases expand to their views instead of child pages.
  const views = node.kind === "database" ? (node.views ?? []) : [];
  const expandable = canNest || views.length > 0;
  const active = activeId === node.id;
  const currentViewId = active ? (activeViewId && views.some((v) => v.id === activeViewId) ? activeViewId : views[0]?.id) : null;

  function zoneFor(e: React.DragEvent<HTMLDivElement>): "before" | "inside" | "after" {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    if (y < 0.28) return "before";
    if (y > 0.72) return "after";
    return canNest ? "inside" : y < 0.5 ? "before" : "after";
  }

  const parentFor = (zone: "before" | "inside" | "after") => (zone === "inside" ? node.id : node.parentId);

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData(DRAG_TYPE);
    const zone = zoneFor(e);
    setDrop(null);
    onDragging(null);
    if (!draggedId || draggedId === node.id || !canDrop(draggedId, parentFor(zone), node.section)) return;
    if (zone === "inside") {
      const last = kids[kids.length - 1];
      onMove(draggedId, node.id, (last?.position ?? 0) + 1, node.section);
    } else if (zone === "before") {
      onMove(draggedId, node.parentId, prev ? (prev.position + node.position) / 2 : node.position - 1, node.section);
    } else {
      onMove(draggedId, node.parentId, next ? (node.position + next.position) / 2 : node.position + 1, node.section);
    }
  }

  return (
    <li>
      <div
        data-sidebar-page={node.id}
        draggable={editable && !renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, node.id);
          e.dataTransfer.effectAllowed = "move";
          onDragging(node.id);
        }}
        onDragEnd={() => onDragging(null)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          const zone = zoneFor(e);
          // Not accepting the drop shows the "not allowed" cursor.
          if (!dragging || !canDrop(dragging, parentFor(zone), node.section)) return setDrop(null);
          e.preventDefault();
          setDrop({ id: node.id, zone });
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={onDrop}
        className={cn(
          "group relative flex h-7 items-center gap-0.5 rounded-md pr-1 hover:bg-bg-hover has-[[data-open]]:bg-bg-hover",
          // An open database highlights its current view row instead.
          active && !(isOpen && currentViewId) && "bg-bg-active font-medium hover:bg-bg-active has-[[data-open]]:bg-bg-active",
          drop?.zone === "inside" && "bg-accent/15",
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {drop && drop.zone !== "inside" && (
          <span
            className={cn("pointer-events-none absolute left-1 right-1 h-0.5 rounded bg-accent", drop.zone === "before" ? "top-0" : "bottom-0")}
          />
        )}
        {/* The icon doubles as the expand toggle: it turns into a chevron on hover (always on touch). */}
        <button
          type="button"
          aria-label={isOpen ? t("pages.collapse") : t("pages.expand")}
          aria-expanded={expandable ? isOpen : undefined}
          disabled={!expandable}
          onClick={() => onToggle(node.id)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-bg-active hover:text-fg disabled:hover:bg-transparent"
        >
          <span className={cn("flex", expandable && "group-hover:hidden pointer-coarse:hidden")}>
            <PageIcon icon={node.icon} kind={node.kind} className="text-sm" />
          </span>
          {expandable &&
            (isOpen ? (
              <ChevronDown className="hidden h-3.5 w-3.5 group-hover:block pointer-coarse:block" />
            ) : (
              <ChevronRight className="hidden h-3.5 w-3.5 group-hover:block pointer-coarse:block" />
            ))}
        </button>
        {renaming ? (
          <input
            autoFocus
            defaultValue={node.title}
            placeholder={tc("untitled")}
            aria-label={t("pages.renameLabel")}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                // Stops the sidebar or a dialog from closing too.
                e.stopPropagation();
                renameCancelled.current = true;
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              setRenaming(false);
              if (renameCancelled.current) return void (renameCancelled.current = false);
              onRename(node.id, e.currentTarget.value.trim());
            }}
            className="ml-0.5 h-6 min-w-0 flex-1 rounded border border-border bg-bg px-1.5 text-sm outline-none focus:border-accent"
          />
        ) : (
          <Link
            href={`/w/${workspaceId}/p/${node.id}`}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-0.5"
          >
            {expandable && (
              <PageIcon icon={node.icon} kind={node.kind} className="hidden text-sm pointer-coarse:inline" />
            )}
            <span className="truncate">{pageLabel(node.title, tc("untitled"))}</span>
          </Link>
        )}
        {editable && !renaming && (
          <div className="hidden items-center group-hover:flex focus-within:flex has-[[data-open]]:flex pointer-coarse:flex">
            <Popover
              align="end"
              trigger={({ toggle }) => (
                <IconButton label={t("pages.actions")} onClick={toggle}>
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </IconButton>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    icon={<Pencil className="h-4 w-4" />}
                    onClick={() => {
                      close();
                      setRenaming(true);
                    }}
                  >
                    {t("pages.rename")}
                  </MenuItem>
                  <MenuItem
                    danger
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => {
                      close();
                      onArchive(node.id);
                    }}
                  >
                    {t("pages.moveToTrash")}
                  </MenuItem>
                </>
              )}
            </Popover>
            {canNest && (
              <IconButton label={t("pages.addInside")} onClick={() => onCreate(node.id)}>
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>
        )}
      </div>
      {isOpen && views.length > 0 && (
        <ul>
          {views.map((v) => (
            <li key={v.id}>
              <Link
                href={`/w/${workspaceId}/p/${node.id}?view=${v.id}`}
                aria-current={v.id === currentViewId ? "page" : undefined}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md pr-2 text-fg-muted hover:bg-bg-hover hover:text-fg",
                  v.id === currentViewId && "bg-bg-active font-medium text-fg hover:bg-bg-active",
                )}
                style={{ paddingLeft: 4 + (depth + 1) * 14 }}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                  <ViewIcon type={v.type} className="h-3.5 w-3.5" />
                </span>
                <span className="truncate">{v.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {isOpen && canNest && (
        kids.length > 0 ? (
          <TreeLevel nodes={kids} {...props} depth={depth + 1} />
        ) : (
          <p className="py-1 text-xs text-fg-faint" style={{ paddingLeft: 28 + depth * 14 }}>
            {t("pages.noChildren")}
          </p>
        )
      )}
    </li>
  );
}
