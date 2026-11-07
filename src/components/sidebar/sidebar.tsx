"use client";

import { IconGlyph } from "@/components/builtin-icon";
import {
  Bell,
  BellOff,
  CalendarCheck,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  CloudOff,
  ArrowDownAZ,
  Database,
  ExternalLink,
  FileText,
  Globe,
  Inbox,
  Keyboard,
  LayoutTemplate,
  Link2,
  LogOut as LeaveIcon,
  Mail as MailIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  ScrollText,
  Settings,
  Sparkles,
  SquarePen,
  Trash2,
  Upload,
  FolderPlus,
  Users,
  Waypoints,
  HardDriveDownload,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createMeetingNoteAction } from "@/app/actions/meetings";
import { listFavoritesAction } from "@/app/actions/page-menu";
import { archivePageAction, createPageAction, getSidebarAction, movePageAction, renamePageAction, restorePageAction } from "@/app/actions/pages";
import { showToast } from "@/components/toast";
import { leaveTeamspaceAction, setTeamspaceWatchingAction } from "@/app/actions/teamspaces";
import { setSidebarLayoutAction } from "@/app/actions/workspaces";
import type { SettingsSearchItem } from "@/lib/settings-search";
import type { FavoritePage } from "@/server/page-meta";
import type { SidebarAgent } from "@/server/agents/manage";
import type { AgentCreationInfo } from "@/server/agents/creation";
import { useChannel } from "@/components/collab/use-channel";
import { ViewIcon } from "@/components/database/property-icons";
import { markNewPage } from "@/components/page/new-page-focus";
import { DailyNotesCalendar, JournalStartPicker, useOpenDailyNote } from "@/components/journal/daily-notes";
import { cn, IconButton, MenuItem, MenuSeparator, PageIcon, pageLabel, Popover } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import type { PageKind } from "@/db/schema/app";
import { authClient } from "@/lib/auth-client";
import { closeOfflineDocs } from "@/components/collab/socket";
import { useIsOffline } from "@/components/offline/offline-context";
import { OfflineToggle } from "@/components/offline/offline-toggle";
import { useLocalMode } from "@/components/local-mode";
import {
  loadSnapshot,
  readOfflineState,
  saveSnapshot,
  treeSnapshotKey,
  useOfflineState,
  wipeAllOfflineData,
  writeOfflineState,
} from "@/components/offline/offline-store";
import { reconcileFavorites, wantedPages } from "@/lib/offline";
import { dropPushSubscription } from "@/components/settings/push-device";
import { CELEBRATE_EVENT } from "@/lib/celebrate-event";
import { REMINDER_EVENT } from "@/lib/reminder-event";
import { FAVORITES_EVENT } from "@/lib/favorites-event";
import { TASKS_EVENT } from "@/lib/tasks-event";
import { IMPORT_SPREADSHEET_EVENT, type ImportSpreadsheetDetail } from "@/lib/import-spreadsheet-event";
import { OPEN_SEARCH_EVENT } from "@/lib/search-open";
import { GO_MS, isMac, opensShortcuts, RAIL_GO_KEYS, railGoPlace, startsGo, type RailPlace } from "@/lib/shortcuts";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { INBOX_PREFERENCES_EVENT } from "@/lib/inbox-event";
import type { SidebarData, TreeNode } from "@/server/pages";
import type { TeamspaceSummary } from "@/server/teamspaces";
import type { JoinableWorkspace } from "@/server/join-requests";
import { JoinableWorkspaces } from "./joinable-workspaces";
import { PRIVATE_SECTION, SHARED_SECTION, type TreeSection } from "@/lib/tree-sections";
import { sidebarOrder, withSection, type SidebarLayout, type SidebarSection } from "@/lib/sidebar-sections";
import { addGroup, settled, sortByName, type AgentArrangement } from "@/lib/agent-arrangement";
import { agentSettingsPath } from "@/lib/agent-settings";
import { AgentList, newGroupId } from "./agent-list";
import { PanelEmpty, panelHeading, panelSection } from "./panel";
import { CustomizeSections } from "./customize-sections";
import { TeamspaceDialog } from "@/components/teamspaces/teamspace-dialog";
import { useAiChat } from "@/components/ai-chat/chat-panel";
import { ConversationList } from "@/components/ai-chat/conversation-list";
import { useAnswering, useWaiting } from "@/components/ai-chat/answering";
import { conversationStatus } from "@/lib/chat-status";
import { chatPath, isChatPath } from "@/lib/ai-chat";
import { NewWorkspaceDialog } from "./new-workspace-dialog";
import { SearchDialog } from "./search-dialog";
import { inlineSign } from "@/components/direction";
import { SIDEBAR_WIDTH } from "@/lib/sidebar-layout";
import { isSettingsPath, useSidebar } from "./sidebar-context";
import { RailCount, railIconClass, railItemClass, RailKey, railSelectedClass, RailTabs, type RailTab } from "./sidebar-rail";
import { BookOpenIcon, CalendarIcon, ChatsIcon, CheckSquareIcon, EnvelopeIcon, GearIcon, HouseIcon, NotebookIcon, RobotIcon, SearchIcon, SidebarIcon, TrayIcon, type RailIcon } from "./rail-icons";
import { TrashDialog } from "./trash-dialog";
import { TemplatesDialog } from "@/components/workspace/templates-dialog";
import { BuildWithAiDialog } from "@/components/workspace/build-with-ai";
import { lazyPart } from "@/components/lazy-part";
import { useArrivals } from "./use-arrivals";
import { useMoreBelow } from "./use-more-below";
import { useDueReminders } from "./use-due-reminders";
import { read } from "@/components/read";

// Loaded the first time the inbox opens: it is not needed to show a page.
const InboxDialog = lazyPart(() => import("./inbox-dialog").then((m) => m.InboxDialog));
// Loaded the first time the account row at the bottom opens (or a pointer nears it).
const AccountMenu = lazyPart(() => import("./account-menu").then((m) => m.AccountMenu));
const ReminderPrompt = lazyPart(() => import("./reminder-prompt").then((m) => m.ReminderPrompt));
const ArrivalCards = lazyPart(() => import("./arrival-cards").then((m) => m.ArrivalCards));
const NewAgentDialog = lazyPart(() => import("./new-agent").then((m) => m.NewAgentDialog));
// Loaded the first time the Mail tab opens: most people open it now and then.
const TaskPanel = lazyPart(() => import("./task-panel").then((m) => m.TaskPanel));
const MeetingPanel = lazyPart(() => import("./meeting-panel").then((m) => m.MeetingPanel));
const CalendarPanel = lazyPart(() => import("./calendar-panel").then((m) => m.CalendarPanel));
const MailSidebar = lazyPart(() => import("@/components/mail/mail-sidebar").then((m) => m.MailSidebar));
// Loaded the first time the import dialog opens, with the readers of every format it takes.
const ImportDialog = lazyPart(() => import("@/components/workspace/import-dialog").then((m) => m.ImportDialog));

type Workspace = { id: string; name: string; icon: string | null; role: string };

const EXPANDED_KEY = "leafdesk:expanded";
/** Teamspaces the user opened: like pages, a teamspace stays closed until opened. */
const OPEN_TEAMSPACES_KEY = "leafdesk:open-teamspaces";
const TEAMSPACES_GROUP: SidebarSection = "teamspaces";
const FAVORITES_SECTION: SidebarSection = "favorites";
const PAGES_SECTION: SidebarSection = "pages";
/** How often the agents list reads its runs again while it is open. */
const AGENT_COUNTS_MS = 15_000;
/** Top-level pages "Private" and "Shared" show before a "More" row. */
const SECTION_LIMIT = 10;
/** A teamspace this many people are in asks before a page is added at its top, once per browser (WIDE_ADD_KEY). */
const WIDE_TEAMSPACE = 10;
const WIDE_ADD_KEY = "leafdesk:wide-add-ok";

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

/**
 * What the panel beside the rail lists: the pages (with the home page), My tasks' views, the
 * person's coming days, the meetings, the person's daily notes, their AI conversations, their mail or the agents they may
 * talk to. Each is a place too: the tab follows the page that is open, and a tab opens where the
 * person last was in it (its start when there is none, or when it is already the open tab; the
 * agents have no start of their own).
 */
type SidebarTab = "home" | "tasks" | "calendar" | "meetings" | "journal" | "chat" | "mail" | "agents";
type ListedApart = SidebarData["listedApart"];
const NOTHING_APART: ListedApart = { taskList: null, meetings: [] };
const TAB_ICONS: Record<SidebarTab, RailIcon> = {
  home: HouseIcon,
  tasks: CheckSquareIcon,
  calendar: CalendarIcon,
  meetings: NotebookIcon,
  journal: BookOpenIcon,
  chat: ChatsIcon,
  mail: EnvelopeIcon,
  agents: RobotIcon,
};
/** The rail's groups of places, parted by a little room: pages and daily notes, tasks, the calendar and meetings, mail and the AI. */
const TAB_GROUPS: Record<SidebarTab, string> = {
  home: "pages",
  journal: "pages",
  tasks: "work",
  calendar: "work",
  meetings: "work",
  mail: "talk",
  chat: "talk",
  agents: "talk",
};
/** How long the pointer rests on a rail item before the hidden panel peeks out with what it shows. */
const PEEK_DELAY = 120;
/** Keys pressed alone on the way to another (Shift for a capital): they leave a waiting g be. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);
/** How often the rail's My tasks count is read again while the window is shown. */
const DUE_TASKS_MS = 5 * 60_000;
/** How often the conversations are read for the rail's Chat mark while the chat isn't shown. */
const CHAT_MARK_MS = 2 * 60_000;

export function Sidebar({
  workspaceId,
  workspaces,
  initialTree,
  initialTeamspaces,
  initialJournalPageId = null,
  initialListedApart = NOTHING_APART,
  canCreateTeamspace,
  canCreateWorkspace,
  isInstanceAdmin,
  initialFavorites,
  topLevel,
  initialLayout,
  initialAgents = [],
  canCreateAgents = false,
  user,
  joinable = [],
  mail = false,
}: {
  workspaceId: string;
  workspaces: Workspace[];
  /** Workspaces their email domain lets them join or ask to join (allowed email domains). */
  joinable?: JoinableWorkspace[];
  initialTree: TreeNode[];
  /** The teamspaces they are in, each a sidebar section. */
  initialTeamspaces: TeamspaceSummary[];
  /** The page their daily notes go under: listed in the journal tab rather than with the pages. */
  initialJournalPageId?: string | null;
  /** Their task list and meeting notes: listed in the Tasks and Meetings tabs rather than with the pages. */
  initialListedApart?: ListedApart;
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
  /** The agents they may talk to: each opens its chat. */
  initialAgents?: SidebarAgent[];
  /** They may create agents here: the agents tab offers New agent. */
  canCreateAgents?: boolean;
  user: { id: string; name: string; email: string; image: string | null };
  /** They have a mailbox here and email is on: the Mail tab (server/mail-client). */
  mail?: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("sidebar");
  const tc = useTranslations("common");
  const locale = useLocale();
  const pathname = usePathname();
  const activeId = /\/p\/([\w-]+)/.exec(pathname)?.[1] ?? null;
  const searchParams = useSearchParams();
  const activeViewId = searchParams.get("view");
  const sidebar = useSidebar();
  const [tree, setTree] = useState(initialTree);
  const [linkMenu, setLinkMenu] = useState<LinkMenuAt | null>(null);
  const [teamspaces, setTeamspaces] = useState(initialTeamspaces);
  const [journalPageId, setJournalPageId] = useState(initialJournalPageId);
  const [listedApart, setListedApart] = useState(initialListedApart);
  const [layout, setLayout] = useState(initialLayout);
  const folded = useMemo(() => new Set<string>(layout.folded ?? []), [layout.folded]);
  // Folded sections opened to show the page being opened: only here, the saved layout stays folded.
  const [revealedSections, setRevealedSections] = useState<Set<string>>(() => new Set());
  const isFolded = (section: SidebarSection) => folded.has(section) && !revealedSections.has(section);
  // Layout saves still on their way: a server render read before they land mustn't undo them.
  const savingLayout = useRef(0);
  const [customizing, setCustomizing] = useState(false);
  const [navEl, setNavEl] = useState<HTMLElement | null>(null);
  useMoreBelow(navEl);
  const [openSpaces, setOpenSpaces] = useState<Set<string>>(() => new Set());
  // Sections showing all their top-level pages rather than the first SECTION_LIMIT.
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());
  const [teamspaceDialog, setTeamspaceDialog] = useState<{ teamspace?: TeamspaceSummary } | null>(null);
  const [favorites, setFavorites] = useState(initialFavorites);
  const [agents, setAgents] = useState(initialAgents);
  // The agents' group whose name is being written, and the New agent dialog with what it needs.
  const [renamingAgentGroup, setRenamingAgentGroup] = useState<string | null>(null);
  const [agentCreation, setAgentCreation] = useState<AgentCreationInfo | null>(null);
  const [newAgent, setNewAgent] = useState<"blank" | "describe" | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  // What the search box opens with: a tag clicked in a page (OPEN_SEARCH_EVENT), else nothing.
  const [searchQuery, setSearchQuery] = useState("");
  // The settings the command list finds, asked for the first time the search opens.
  const [settingsFound, setSettingsFound] = useState<{ workspaceId: string; items: SettingsSearchItem[] } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // A workbook a page shows, to import as a database under that page (see IMPORT_SPREADSHEET_EVENT).
  const [importFile, setImportFile] = useState<ImportSpreadsheetDetail | null>(null);
  // Mounted from the first opening on, like the inbox.
  const [importMounted, setImportMounted] = useState(false);
  // "Save from web" opens the import dialog on its web page tab.
  const [importTab, setImportTab] = useState<"web" | undefined>(undefined);
  if (importOpen && !importMounted) setImportMounted(true);
  // The section the templates or import dialog was opened from.
  const [dialogTarget, setDialogTarget] = useState<Target>(undefined);
  // "Build with AI", and the section it was opened from.
  const [buildFor, setBuildFor] = useState<{ target: Target } | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  // Mounted from the first opening on, so it closes with its own transition afterwards.
  const [inboxMounted, setInboxMounted] = useState(false);
  if (inboxOpen && !inboxMounted) setInboxMounted(true);
  const [unread, setUnread] = useState(0);
  // The workspace whose count `unread` is, once it came.
  const [countedIn, setCountedIn] = useState<string | null>(null);
  // The installed app's icon carries the count, where the system shows one.
  useEffect(() => {
    if (!("setAppBadge" in navigator)) return;
    void (unread > 0 ? navigator.setAppBadge(unread) : navigator.clearAppBadge()).catch(() => {});
  }, [unread]);
  // Agents' reminders whose time came, shown over the page one at a time; `reminderWake` is
  // bumped when the server says one came.
  const [reminderWake, setReminderWake] = useState(0);
  const [reminders, reminderSettled] = useDueReminders(workspaceId, unread, reminderWake);
  // What people just sent, as cards at the window's top end.
  const [arrivals, dismissArrivals] = useArrivals(workspaceId, countedIn === workspaceId ? unread : null);
  // The inbox shows them all: their cards go.
  useEffect(() => {
    if (inboxOpen) dismissArrivals();
  }, [inboxOpen, dismissArrivals]);
  // Changes agents proposed that wait for the person (the "For review" page), counted with the inbox.
  const [reviewCount, setReviewCount] = useState(0);
  // Bumped on every inbox signal so an open inbox reloads.
  const [inboxVersion, setInboxVersion] = useState(0);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [, startTransition] = useTransition();
  const [moveError, setMoveError] = useState(false);
  // Creating or trashing a page failed (e.g. access changed meanwhile), or leaving a teamspace did.
  const [actionError, setActionError] = useState<string | null>(null);
  const [creatingMeeting, setCreatingMeeting] = useState(false);
  const [chatActionsEl, setChatActionsEl] = useState<HTMLElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  // Guests only see pages shared with them (and their own private pages) and can't move pages to the top.
  const guest = workspace?.role === "guest";
  // On one computer (local mode) there is no team: the workspace's default teamspace, where new
  // top-level pages go, shows as its plain "Pages", and the teamspaces section only for others
  // made before (or restored from a backup), so none of their pages drop out of sight.
  const localMode = useLocalMode();
  const pagesSpace = localMode ? teamspaces.find((ts) => ts.access === "default" && !ts.archivedAt) : undefined;
  const listedSpaces = pagesSpace ? teamspaces.filter((ts) => ts !== pagesSpace) : teamspaces;
  const showTeamspaces = !guest && !(localMode && listedSpaces.length === 0);

  const offline = useIsOffline();
  const aiChat = useAiChat();

  const settingsAsked = useRef<string | null>(null);
  useEffect(() => {
    if (!searchOpen || offline || settingsAsked.current === workspaceId) return;
    settingsAsked.current = workspaceId;
    read("settingsSearch", workspaceId)
      .then((result) => {
        if (result.ok) setSettingsFound({ workspaceId, items: result.data });
        else settingsAsked.current = null;
      })
      .catch(() => {
        settingsAsked.current = null;
      });
  }, [searchOpen, offline, workspaceId]);
  const onChatPage = Boolean(aiChat) && isChatPath(pathname, workspaceId);
  // An agent's page, a chat with it: the agents tab stays open beside it.
  const onAgentPage = Boolean(aiChat) && pathname.startsWith(`/w/${workspaceId}/agents/`);
  const tAi = useTranslations("ai.chat");
  const tJournal = useTranslations("journal");
  const { open: openDailyNote, pending: openingDailyNote, error: dailyNoteError } = useOpenDailyNote(workspaceId);
  const tOffline = useTranslations("offline");
  const tShortcuts = useTranslations("shortcuts");
  const tBuild = useTranslations("build");
  const tMail = useTranslations("mail");
  const tMeetings = useTranslations("meetings");
  const tTasks = useTranslations("home.myTasks");
  // Databases drafted by AI: where AI is on in the workspace, and the server can be reached.
  const canBuild = Boolean(aiChat?.available) && !offline;
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
  useEffect(() => setJournalPageId(initialJournalPageId), [initialJournalPageId]);
  useEffect(() => setListedApart(initialListedApart), [initialListedApart]);
  useEffect(() => setFavorites(initialFavorites), [initialFavorites]);
  useEffect(() => setAgents(initialAgents), [initialAgents]);
  // Favorites are downloaded for offline use too, unless the person turned that off on this device.
  const offlineState = useOfflineState(user.id);
  const keepFavorites = offlineState.keepFavorites;
  useEffect(() => {
    writeOfflineState(user.id, (s) =>
      reconcileFavorites(
        s,
        workspaceId,
        favorites.filter((f) => !f.outdated).map((f) => ({ id: f.id, title: f.title, icon: f.icon, kind: f.kind })),
      ),
    );
  }, [favorites, keepFavorites, user.id, workspaceId]);
  // Pages downloaded to this device: a quiet mark beside them in the tree.
  const keptOffline = useMemo(() => new Set(wantedPages(offlineState).keys()), [offlineState]);

  const refreshFavorites = useCallback(() => {
    listFavoritesAction(workspaceId).then(setFavorites).catch(() => {});
  }, [workspaceId]);
  const refresh = useCallback(() => {
    getSidebarAction(workspaceId)
      .then((next) => {
        setTree(next.tree);
        setTeamspaces(next.teamspaces);
        setJournalPageId(next.journalPageId);
        setListedApart(next.listedApart);
      })
      .catch(() => {});
    // Renames, trash and sharing changes show up in Favorites too.
    refreshFavorites();
  }, [workspaceId, refreshFavorites]);
  const refreshInbox = useCallback(() => {
    read("unreadCount", workspaceId)
      .then((count) => {
        setUnread(count);
        setCountedIn(workspaceId);
      })
      .catch(() => {});
    read("pendingCount", workspaceId).then(setReviewCount).catch(() => {});
    // Agents made or archived elsewhere (the AI chat, settings, another window) show up with it.
    read("sidebarAgents", workspaceId)
      .then((result) => result.ok && setAgents(result.data))
      .catch(() => {});
  }, [workspaceId]);
  // The tree as last loaded is kept in this browser; offline, it replaces the one the page came
  // with (a cached page may be older than the last tree seen).
  useEffect(() => {
    if (!offline) void saveSnapshot(user.id, treeSnapshotKey(workspaceId), { tree, teamspaces, journalPageId, listedApart });
  }, [offline, tree, teamspaces, journalPageId, listedApart, user.id, workspaceId]);
  useEffect(() => {
    if (!offline) return;
    let current = true;
    void loadSnapshot<{ tree: TreeNode[]; teamspaces: TeamspaceSummary[]; journalPageId?: string | null; listedApart?: ListedApart }>(
      user.id,
      treeSnapshotKey(workspaceId),
    ).then((kept) => {
      // Copies from before teamspaces were kept as a bare tree; those wait for the next load.
      if (!current || !kept || Array.isArray(kept.data)) return;
      setTree(kept.data.tree);
      setTeamspaces(kept.data.teamspaces);
      setJournalPageId(kept.data.journalPageId ?? null);
      setListedApart(kept.data.listedApart ?? NOTHING_APART);
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
    } else if (event === REMINDER_EVENT) {
      setReminderWake((v) => v + 1);
    } else if (event === CELEBRATE_EVENT) {
      // Sent to this person's windows only, by an automation their change started.
      void import("@/components/celebrate").then((m) => m.celebrate(tc("celebrate")));
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
    const onImport = (event: Event) => {
      const { file, pageId } = (event as CustomEvent<ImportSpreadsheetDetail>).detail ?? {};
      if (!(file instanceof File) || typeof pageId !== "string") return;
      setDialogTarget(undefined);
      setImportFile({ file, pageId });
      setImportOpen(true);
    };
    window.addEventListener(IMPORT_SPREADSHEET_EVENT, onImport);
    return () => window.removeEventListener(IMPORT_SPREADSHEET_EVENT, onImport);
  }, []);

  useEffect(() => {
    const onOpenSearch = (event: Event) => {
      const query = (event as CustomEvent<unknown>).detail;
      setSearchQuery(typeof query === "string" ? query : "");
      setSearchOpen(true);
    };
    window.addEventListener(OPEN_SEARCH_EVENT, onOpenSearch);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, onOpenSearch);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (key === "k" || key === "p")) {
        // With text selected in an editor, Mod+K is the editor's link box (Mod+P still searches).
        if (key === "k" && selectedEditableText()) return;
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

  // g then a letter opens a place of the rail (lib/shortcuts.ts RAIL_GO_KEYS); while g waits, the
  // rail shows each place's letter. g is taken as it bubbles, after what it was typed into had its
  // say (a table cell opens with it); the second key while it is caught, before the page's own
  // keys (a row panel's j, the Mail tab's e). On the Mail tab its folder letters stay its own.
  const [goShown, setGoShown] = useState(false);
  const goTo = useRef<(place: RailPlace) => boolean>(() => false);
  const onMailTab = useRef(false);
  useEffect(() => {
    let armedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => {
      armedAt = 0;
      clearTimeout(timer);
      setGoShown(false);
    };
    const onSecond = (e: KeyboardEvent) => {
      if (!armedAt || MODIFIER_KEYS.has(e.key) || startsGo(e)) return;
      const place = Date.now() - armedAt < GO_MS ? railGoPlace(e, onMailTab.current) : null;
      disarm();
      if (place && goTo.current(place)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onFirst = (e: KeyboardEvent) => {
      if (!startsGo(e)) return;
      armedAt = Date.now();
      setGoShown(true);
      clearTimeout(timer);
      timer = setTimeout(disarm, GO_MS);
    };
    window.addEventListener("keydown", onSecond, true);
    window.addEventListener("keydown", onFirst);
    window.addEventListener("blur", disarm);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onSecond, true);
      window.removeEventListener("keydown", onFirst);
      window.removeEventListener("blur", disarm);
    };
  }, []);

  // The pages listed in a tab of their own (with the pages under them), by the tab.
  const apart = useMemo(() => {
    const tabs = new Map<string, SidebarTab>(listedApart.meetings.map((id) => [id, "meetings"]));
    if (listedApart.taskList) tabs.set(listedApart.taskList, "tasks");
    if (journalPageId) tabs.set(journalPageId, "journal");
    return tabs;
  }, [listedApart, journalPageId]);
  // Pages by parent; the tops of the sections under `@<section>`.
  const children = useMemo(() => {
    const map = new Map<string, TreeNode[]>();
    const ids = new Set(tree.map((n) => n.id));
    for (const node of tree) {
      // The journal, the task list and meeting notes are listed in their own tabs, the journal's
      // notes under it there.
      if (apart.has(node.id)) continue;
      // Children of hidden parents (e.g. rows) never reach the tree; orphans go to the top.
      const key = node.parentId && ids.has(node.parentId) ? node.parentId : `@${node.section}`;
      map.set(key, [...(map.get(key) ?? []), node]);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [tree, apart]);
  const byId = useMemo(() => new Map(tree.map((n) => [n.id, n])), [tree]);
  const rootsOf = (section: TreeSection) => children.get(`@${section}`) ?? [];
  const journalNotes = (journalPageId && children.get(journalPageId)) || [];

  /** The tab listing a page apart from the tree (it or a page above it), if any. */
  function listedIn(id: string): SidebarTab | null {
    const seen = new Set<string>();
    for (let at: string | null = id; at && !seen.has(at); at = byId.get(at)?.parentId ?? null) {
      const tab = apart.get(at);
      if (tab) return tab;
      seen.add(at);
    }
    return null;
  }

  // Daily notes are private top-level pages, so the journal only for those who may add them.
  const onMailPage = pathname.startsWith(`/w/${workspaceId}/mail`);
  const tasksPath = `/w/${workspaceId}/tasks`;
  const onTasksPage = pathname === tasksPath;
  const meetingsPath = `/w/${workspaceId}/meetings`;
  const onMeetingsPage = pathname === meetingsPath;
  const calendarPath = `/w/${workspaceId}/calendar`;
  const onCalendarPage = pathname === calendarPath;
  // Settings bring their own navigation as the panel (settings-nav.tsx): the rail stays beside it.
  const onSettingsPage = isSettingsPath(pathname);
  // By kind (TAB_GROUPS): what is written, the work to do, then mail and the AI.
  const tabs: SidebarTab[] = [
    "home",
    ...(topLevel ? (["journal"] as const) : []),
    "tasks",
    "calendar",
    "meetings",
    ...(mail ? (["mail"] as const) : []),
    ...(aiChat ? (["chat"] as const) : []),
    ...(agents.length > 0 || onAgentPage ? (["agents"] as const) : []),
  ];
  // Unread mail in the inboxes, on the Mail tab. The store is loaded after the page, as for composeMail.
  const [mailUnread, setMailUnread] = useState(0);
  useEffect(() => {
    if (!mail) return;
    let stop: (() => void) | undefined;
    let gone = false;
    void import("@/components/mail/mail-store").then(({ watchInboxUnread }) => {
      if (!gone) stop = watchInboxUnread(workspaceId, setMailUnread);
    });
    return () => {
      gone = true;
      stop?.();
      setMailUnread(0);
    };
  }, [mail, workspaceId]);
  // A new message, from the New menu or the search box's commands, on the Mail page.
  const composeMail = () => {
    setTab("mail");
    // The store is the Mail page's, loaded with it: not in every page's first load.
    void import("@/components/mail/mail-store").then(({ requestCompose }) => {
      requestCompose();
      if (!onMailPage) router.push(`/w/${workspaceId}/mail`);
    });
    sidebar?.close();
  };
  // The journal's tab is there only for those who may add private top-level pages.
  const apartTab = activeId ? listedIn(activeId) : null;
  const pageTab: SidebarTab = onTasksPage ? "tasks" : onCalendarPage ? "calendar" : onMeetingsPage ? "meetings" : onAgentPage ? "agents" : onChatPage ? "chat" : onMailPage ? "mail" : apartTab && (apartTab !== "journal" || topLevel) ? apartTab : "home";
  const [tab, setTab] = useState<SidebarTab>(pageTab);
  // The meeting notes the Meetings tab lists: opening one keeps the tab, as a page from the tree doesn't.
  const [meetingPages, setMeetingPages] = useState<ReadonlySet<string>>(() => new Set());
  const noteMeetingPages = useCallback((ids: Set<string>) => setMeetingPages((prev) => (prev.size === ids.size && [...ids].every((id) => prev.has(id)) ? prev : ids)), []);
  // Likewise the pages the Calendar tab lists.
  const [calendarPages, setCalendarPages] = useState<ReadonlySet<string>>(() => new Set());
  const noteCalendarPages = useCallback((ids: Set<string>) => setCalendarPages((prev) => (prev.size === ids.size && [...ids].every((id) => prev.has(id)) ? prev : ids)), []);
  const keptTab = tab === "meetings" ? meetingPages : tab === "calendar" ? calendarPages : null;
  const routeTab: SidebarTab = pageTab === "home" && keptTab && activeId && keptTab.has(activeId) ? tab : pageTab;
  // Where the person last was in each tab, in this visit.
  const lastPath = useRef<Partial<Record<SidebarTab, string>>>({});
  const query = searchParams.toString();
  useEffect(() => {
    setTab(routeTab);
    if (!onSettingsPage) lastPath.current[routeTab] = query ? `${pathname}?${query}` : pathname;
  }, [routeTab, pathname, query, onSettingsPage]);

  // A phone's drawer covers the page: a tab there only changes the list, and what is picked in it opens.
  const drawerOpen = sidebar?.drawerOpen ?? false;
  useEffect(() => {
    if (!drawerOpen) setTab(routeTab);
  }, [drawerOpen, routeTab]);

  function openTab(next: SidebarTab) {
    // From the settings every tab leaves them, back to where the person was in it.
    const back = next === tab && !onSettingsPage ? undefined : lastPath.current[next];
    setTab(next);
    if (drawerOpen) return;
    if (back) router.push(back);
    else if (next === "journal") openDailyNote();
    else if (next === "agents" && !onSettingsPage) return;
    else router.push(next === "tasks" ? tasksPath : next === "calendar" ? calendarPath : next === "meetings" ? meetingsPath : next === "chat" ? chatPath(workspaceId) : next === "mail" ? `/w/${workspaceId}/mail` : `/w/${workspaceId}`);
  }

  // Desktop, the panel hidden (on the settings too): what a rail item shows while the panel peeks out beside it.
  const collapsed = !!sidebar?.collapsed || onSettingsPage;
  // The panel beside the rail: pinned open, or in a phone's open drawer.
  const panelShown = !collapsed || !!sidebar?.drawerOpen;
  const [peekTab, setPeekTab] = useState<SidebarTab | null>(null);
  const shownTab = (collapsed && peekTab) || tab;
  // The runs of the agents' list move on while it is open: its counts are read again every so often.
  useEffect(() => {
    if (shownTab !== "agents" || offline) return;
    const timer = window.setInterval(() => {
      read("sidebarAgents", workspaceId)
        .then((result) => result.ok && setAgents(result.data))
        .catch(() => {});
    }, AGENT_COUNTS_MS);
    return () => window.clearInterval(timer);
  }, [shownTab, offline, workspaceId]);
  // Overdue rows and to-dos and those due today, on My tasks: read as the sidebar comes, every few
  // minutes and as the window comes back (a heavier read than the inbox's, so not on its signals).
  const [dueTasks, setDueTasks] = useState({ overdue: 0, today: 0 });
  useEffect(() => {
    if (offline) return;
    let current = true;
    const count = () => {
      if (document.visibilityState !== "visible") return;
      read("dueTasks", workspaceId)
        .then((due) => current && setDueTasks(due))
        .catch(() => {});
    };
    count();
    const timer = setInterval(count, DUE_TASKS_MS);
    document.addEventListener("visibilitychange", count);
    window.addEventListener(TASKS_EVENT, count);
    return () => {
      current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", count);
      window.removeEventListener(TASKS_EVENT, count);
    };
  }, [offline, workspaceId]);
  // The conversations, for the Chat mark: the chat's list reads them while it is shown, so here
  // only as the sidebar comes, now and then while it isn't, and as the window comes back.
  const refreshConversations = aiChat?.refreshConversations;
  const chatListShown = !!aiChat && shownTab === "chat";
  useEffect(() => {
    if (!refreshConversations || offline || chatListShown) return;
    const again = () => {
      if (document.visibilityState === "visible") void refreshConversations();
    };
    again();
    const timer = setInterval(again, CHAT_MARK_MS);
    document.addEventListener("visibilitychange", again);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", again);
    };
  }, [refreshConversations, offline, chatListShown]);
  const answering = useAnswering();
  const waiting = useWaiting();
  const chatMark = useMemo(() => {
    let mark: "busy" | "accent" | "new" | null = null;
    for (const c of aiChat?.conversations ?? []) {
      const status = conversationStatus(c, { answering: answering.has(c.id), waiting: waiting.has(c.id) }, c.id === aiChat?.shownConversation);
      if (status === "waiting") return "accent";
      if (status === "unread") mark = "new";
      else if (status === "answering" && !mark) mark = "busy";
    }
    return mark;
  }, [aiChat?.conversations, aiChat?.shownConversation, answering, waiting]);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  function hoverTab(next: SidebarTab) {
    if (!collapsed || drawerOpen) return;
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => {
      setPeekTab(next);
      sidebar?.showPeek();
    }, PEEK_DELAY);
  }
  const leaveTab = () => clearTimeout(peekTimer.current);

  /** A rail item of the panel's: with the panel hidden, it comes back showing that tab. */
  function pickTab(next: SidebarTab) {
    if (collapsed && !drawerOpen) {
      clearTimeout(peekTimer.current);
      if (onSettingsPage) return openTab(next);
      sidebar?.expand();
      if (next === tab) return;
    }
    openTab(next);
  }

  /** A new meeting note (private, titled for today), opened with the Meetings tab kept. */
  async function newMeetingNote() {
    setCreatingMeeting(true);
    setActionError(null);
    const res = await createMeetingNoteAction(workspaceId).catch(() => null);
    setCreatingMeeting(false);
    if (!res?.ok) return setActionError(res?.error ?? tc("genericError"));
    setMeetingPages((prev) => new Set(prev).add(res.data.id));
    setTab("meetings");
    router.push(`/w/${workspaceId}/p/${res.data.id}`);
    sidebar?.close();
  }

  /** My tasks with its New task form open (`?new=`, read by the page; a new value each time, so a second click opens it again). */
  function newTask() {
    setTab("tasks");
    router.push(`${tasksPath}?new=${Date.now()}`);
    sidebar?.close();
  }

  function newChat() {
    setTab("chat");
    router.push(chatPath(workspaceId));
    // On the chat page only the address's `?c=` changes, which leaves a phone's drawer open.
    sidebar?.close();
  }

  /** The teamspace a page lands in under `parentId`, or at the top of `section` (null: private). */
  function spaceAt(parentId: string | null, section: TreeSection) {
    if (parentId) return byId.get(parentId)?.teamspaceId ?? null;
    return section === PRIVATE_SECTION ? null : section;
  }

  /**
   * Whether a dragged page may go under `parentId`, or to the top of `section` when that is null,
   * mirroring movePage's checks.
   */
  // Teamspaces whose top-level pages only their managers arrange, when this person doesn't (server/teamspaces.ts).
  const lockedTop = new Set(teamspaces.filter((ts) => !ts.canArrangeTopLevel).map((ts) => ts.id));
  const pinned = (node: TreeNode) => node.parentId === null && lockedTop.has(node.section);

  function canDrop(draggedId: string, parentId: string | null, section: TreeSection) {
    const dragged = byId.get(draggedId);
    if (!dragged || !canEdit(dragged) || pinned(dragged)) return false;
    if (!parentId && lockedTop.has(section)) return false;
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

  /** Saves how the person grouped and ordered the agents' list (lib/agent-arrangement.ts), for them alone. */
  const arrangeAgentList = (next: AgentArrangement) => saveLayout({ agents: settled(agents, next) });
  function newAgentGroup() {
    const id = newGroupId();
    arrangeAgentList(addGroup(settled(agents, layout.agents), id, t("agentList.groupDefault")));
    setRenamingAgentGroup(id);
  }
  const sortAgentsByName = () => arrangeAgentList(sortByName(settled(agents, layout.agents), new Map(agents.map((a) => [a.id, a.name])), locale));
  /** What New agent's dialogs need (whether the AI can draft one), read as its menu first opens. */
  function loadAgentCreation() {
    if (agentCreation) return;
    read("agentCreation", workspaceId)
      .then((result) => (result.ok ? setAgentCreation(result.data) : setNewAgent(null)))
      .catch(() => setNewAgent(null));
  }

  const sectionLabel = (key: SidebarSection) =>
    ({
      favorites: t("pages.favorites"),
      pages: t("pages.heading"),
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

  // Opening a page (a link, search, a new page) unfolds the way to it, once per page and place, so
  // the sidebar shows where it is, and again when the open page moves (to a new teamspace, say);
  // folding it again afterwards is left alone.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    const node = activeId ? byId.get(activeId) : undefined;
    const place = node && `${node.id}@${node.section}`;
    if (!node || revealed.current === place) return;
    revealed.current = place ?? null;
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
    if (listedIn(node.id)) {
      // Listed in a tab of its own, outside the sections.
    } else if (section === PRIVATE_SECTION || section === SHARED_SECTION) reveal(section);
    else if (section === pagesSpace?.id) reveal(PAGES_SECTION);
    else {
      reveal(TEAMSPACES_GROUP);
      toggleSpace(section, true);
    }
    requestAnimationFrame(() =>
      document.querySelector(`[data-sidebar-page="${CSS.escape(node.id)}"]`)?.scrollIntoView({ block: "nearest" }),
    );
    // Only when another page opens, the tree first holds it or it moves, not on every fold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, byId]);

  function create(parentId: string | null, kind: PageKind = "page", target?: Target) {
    if (!parentId && target && !confirmWideAdd(target)) return;
    setActionError(null);
    startTransition(async () => {
      try {
        const { id } = await createPageAction({ workspaceId, parentId, kind, ...(parentId ? {} : { teamspaceId: target }) });
        if (parentId) toggle(parentId, true);
        else if (target && target === pagesSpace?.id) fold(PAGES_SECTION, true);
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

  /**
   * A new page at the top of a teamspace of WIDE_TEAMSPACE people or more is in front of all of
   * them: asked once per teamspace in this browser.
   */
  function confirmWideAdd(teamspaceId: string) {
    const ts = teamspaces.find((s) => s.id === teamspaceId);
    if (!ts || ts.memberCount < WIDE_TEAMSPACE) return true;
    const asked = loadSet(WIDE_ADD_KEY);
    if (asked.has(ts.id)) return true;
    if (!confirm(t("teamspaces.confirmWideAdd", { name: ts.name, count: ts.memberCount }))) return false;
    saveSet(WIDE_ADD_KEY, asked.add(ts.id));
    return true;
  }

  function archive(id: string) {
    setActionError(null);
    startTransition(async () => {
      try {
        await archivePageAction(id);
        if (activeId === id) router.refresh();
        showToast({
          message: tc("toast.trashed"),
          undo: async () => {
            try {
              await restorePageAction(id);
            } catch {
              showToast({ message: tc("toast.undoFailed") });
            }
            refresh();
            if (activeId === id) router.refresh();
          },
        });
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

  // Watching a teamspace watches all its pages (server/page-watch).
  function watch(ts: TeamspaceSummary) {
    setActionError(null);
    startTransition(async () => {
      const result = await setTeamspaceWatchingAction(workspaceId, ts.id, !ts.watching);
      if (!result.ok) setActionError(result.error);
      refresh();
    });
  }

  function openTemplates(target: Target) {
    setDialogTarget(target);
    setTemplatesOpen(true);
  }

  function openImport(target: Target, tab?: "web") {
    setDialogTarget(target);
    setImportFile(null);
    setImportTab(tab);
    setImportOpen(true);
  }

  /** The "+" menu of a section: what to add at its top. */
  // eslint-disable-next-line react/display-name -- a Popover render callback, not a component
  const newMenu = (target: Target) => (close: () => void) => (
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
      {canBuild && (
        <MenuItem
          icon={<Sparkles className="h-4 w-4" />}
          onClick={() => {
            close();
            setBuildFor({ target });
          }}
        >
          {tBuild("menuItem")}
        </MenuItem>
      )}
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
      <MenuItem
        icon={<Globe className="h-4 w-4" />}
        onClick={() => {
          close();
          openImport(target, "web");
        }}
      >
        {t("pages.saveFromWeb")}
      </MenuItem>
    </>
  );

  async function signOut() {
    // Edits made offline that never reached the server are lost with the offline copies.
    if (readOfflineState(user.id).dirty.length && !confirm(tOffline("signOutUnsynced"))) return;
    await authClient.signOut();
    // Nothing of this account stays in the browser: offline pages, rows and cached HTML, and push
    // notifications (the server dropped the subscription with the session).
    await closeOfflineDocs();
    await Promise.all([wipeAllOfflineData(), dropPushSubscription()]);
    router.push("/sign-in");
    router.refresh();
  }

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
    pinned,
    offline,
    keptOffline,
  };

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
                  "flex h-7 items-center gap-0.5 rounded-md ps-1 hover:bg-bg-hover",
                  activeId === f.id && "bg-bg-active font-medium",
                )}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                  <PageIcon icon={f.icon} kind={f.kind} className="text-sm" />
                </span>
                <span className="truncate ps-0.5">{pageLabel(f.title, tc("untitled"))}</span>
              </Link>
            </li>
          ))}
        </ul>
      </SectionGroup>
    ),
    pages: pagesSpace && (
      <SectionGroup
        label={t("pages.heading")}
        open={!isFolded(PAGES_SECTION)}
        onToggle={() => fold(PAGES_SECTION)}
        drop={{ section: pagesSpace.id, roots: rootsOf(pagesSpace.id), ...treeProps }}
        actions={
          <Popover
            align="end"
            trigger={({ toggle }) => (
              <IconButton label={t("pages.newPage")} onClick={toggle} disabled={offline} className="disabled:opacity-40 disabled:hover:bg-transparent">
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            {newMenu(pagesSpace.id)}
          </Popover>
        }
      >
        {rootsOf(pagesSpace.id).length === 0 && (
          <button
            type="button"
            onClick={() => create(null, "page", pagesSpace.id)}
            disabled={offline}
            title={needsServer(t("pages.createFirst"))}
            className="flex h-7 w-full items-center gap-0.5 rounded-md ps-1 text-start text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center">
              <Plus className="h-3.5 w-3.5" />
            </span>
            <span className="truncate ps-0.5">{t("pages.createFirst")}</span>
          </button>
        )}
        <LimitedRoots
          nodes={rootsOf(pagesSpace.id)}
          all={showAll.has(pagesSpace.id)}
          onAll={(all) => setShowAll((prev) => withMember(prev, pagesSpace.id, all))}
          {...treeProps}
        />
      </SectionGroup>
    ),
    teamspaces: showTeamspaces && (
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
        {listedSpaces.length === 0 && (
          <Link
            href={`/w/${workspaceId}/settings?tab=teamspaces`}
            className="block rounded-md px-2 py-1.5 text-xs text-fg-muted hover:bg-bg-hover"
          >
            {t("teamspaces.none")}
          </Link>
        )}
        <ul>
          {listedSpaces.map((ts) => (
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
              onWatch={() => watch(ts)}
              tree={treeProps}
            />
          ))}
        </ul>
        {/* A new teamspace, or the list to join one from, set apart from the last teamspace's pages. */}
        {!localMode && (
          <button
            type="button"
            onClick={() =>
              canCreateTeamspace ? setTeamspaceDialog({}) : router.push(`/w/${workspaceId}/settings?tab=teamspaces`)
            }
            disabled={canCreateTeamspace && offline}
            title={canCreateTeamspace ? needsServer(t("teamspaces.new")) : undefined}
            className="mt-1 flex h-7 w-full items-center gap-0.5 rounded-md ps-1 text-start text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center">
              <Plus className="h-3.5 w-3.5" />
            </span>
            <span className="truncate ps-0.5">{canCreateTeamspace ? t("teamspaces.new") : t("teamspaces.browse")}</span>
          </button>
        )}
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
        {/* With "Pages" above, it asks for the first page; private pages start from "+". */}
        {rootsOf(PRIVATE_SECTION).length === 0 && topLevel && !pagesSpace && (
          <button
            type="button"
            onClick={() => create(null, "page", null)}
            disabled={offline}
            title={needsServer(t("pages.createFirst"))}
            className="flex h-7 w-full items-center gap-0.5 rounded-md ps-1 text-start text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center">
              <Plus className="h-3.5 w-3.5" />
            </span>
            <span className="truncate ps-0.5">{t("pages.createFirst")}</span>
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
  const onSettings = pathname.startsWith(`/w/${workspaceId}/settings`);
  const tabLabel = (key: SidebarTab) =>
    ({ home: t("tabs.home"), tasks: t("sections.tasks"), calendar: t("tabs.calendar"), meetings: t("sections.meetings"), journal: t("tabs.journal"), chat: t("tabs.chat"), mail: t("tabs.mail"), agents: t("sections.agents") })[key];
  const panelTab = (key: SidebarTab): RailTab => {
    const Icon = TAB_ICONS[key];
    const label = tabLabel(key);
    // Opening the daily notes, the chat or mail takes the server.
    const unreachable = offline && key !== "home" && key !== tab;
    // On the settings the panel keeps showing its tab; the rail marks the page.
    const selected = tab === key && !onSettingsPage;
    return {
      key,
      label,
      icon: <Icon className={railIconClass} filled={selected} />,
      selected,
      disabled: unreachable || (key === "journal" && openingDailyNote),
      title: unreachable ? needsServer(label) : undefined,
      count: key === "mail" && mailUnread > 0 ? { value: mailUnread, label: tMail("unreadCount", { count: mailUnread }) } : key === "tasks" ? dueCount : undefined,
      dot:
        key === "chat" && chatMark ? { tone: chatMark, label: t(`rail.chat.${chatMark}`) }
        : key === "agents" && agents.some((a) => a.waiting > 0 || a.approval) ? { tone: "accent", label: t("rail.agentsWaiting") }
        : undefined,
      goKey: RAIL_GO_KEYS[key],
      group: TAB_GROUPS[key],
      onClick: () => pickTab(key),
      onHover: () => hoverTab(key),
      onLeave: leaveTab,
    };
  };
  const due = dueTasks.overdue + dueTasks.today;
  const dueCount: RailTab["count"] =
    due > 0
      ? {
          value: due,
          tone: dueTasks.overdue > 0 ? "danger" : "accent",
          label: [
            dueTasks.overdue > 0 && t("rail.tasksOverdue", { count: dueTasks.overdue }),
            dueTasks.today > 0 && t("rail.tasksToday", { count: dueTasks.today }),
          ]
            .filter(Boolean)
            .join(", "),
        }
      : undefined;
  const railTabs: RailTab[] = tabs.map(panelTab);
  onMailTab.current = onMailPage;
  goTo.current = (place) => {
    if (place === "inbox") {
      if (offline) return false;
      setInboxOpen(true);
    } else if (place === "settings") router.push(`/w/${workspaceId}/settings`);
    else {
      const target = railTabs.find((tab) => tab.key === place);
      if (!target || target.disabled) return false;
      target.onClick();
    }
    return true;
  };
  const panelTitle = shownTab === "home" ? t("pages.heading") : tabLabel(shownTab);
  const headButton = "h-7 w-7 disabled:opacity-50";
  // What the open tab starts: a page (with its other ways in), today's note, a chat, a message.
  const headActions =
    shownTab === "home" ? (
      topLevel && (
        <Popover
          align="end"
          trigger={({ open, toggle }) => (
            <IconButton
              label={t("pages.new")}
              title={needsServer(t("pages.new")) ?? t("pages.new")}
              onClick={toggle}
              aria-expanded={open}
              disabled={offline}
              className={cn(headButton, open && "bg-bg-active text-fg")}
            >
              <SquarePen className="h-4 w-4" />
            </IconButton>
          )}
        >
          {newMenu(undefined)}
        </Popover>
      )
    ) : shownTab === "journal" ? (
      <IconButton
        label={tJournal("openToday")}
        title={needsServer(tJournal("openToday")) ?? tJournal("openToday")}
        onClick={() => openDailyNote()}
        disabled={offline || openingDailyNote}
        className={headButton}
      >
        <CalendarCheck className="h-4 w-4" />
      </IconButton>
    ) : shownTab === "chat" ? (
      <>
        <IconButton label={tAi("newChat")} title={tAi("newChat")} onClick={newChat} className={headButton}>
          <SquarePen className="h-4 w-4" />
        </IconButton>
        {/* The list's ⋯ (select all, delete all), which ConversationList draws here. */}
        <span ref={setChatActionsEl} className="contents" />
      </>
    ) : shownTab === "mail" ? (
      <IconButton label={tMail("compose")} title={tMail("compose")} onClick={composeMail} className={headButton}>
        <SquarePen className="h-4 w-4" />
      </IconButton>
    ) : shownTab === "meetings" ? (
      <IconButton
        label={tMeetings("newMeeting")}
        title={needsServer(tMeetings("newMeeting")) ?? tMeetings("newMeeting")}
        onClick={() => void newMeetingNote()}
        disabled={offline || creatingMeeting}
        className={headButton}
      >
        {creatingMeeting ? <Loader2 className="h-4 w-4 animate-spin" /> : <SquarePen className="h-4 w-4" />}
      </IconButton>
    ) : shownTab === "calendar" ? null : shownTab === "tasks" ? (
      !guest && (
        <IconButton
          label={tTasks("newTask")}
          title={needsServer(tTasks("newTask")) ?? tTasks("newTask")}
          onClick={newTask}
          disabled={offline}
          className={headButton}
        >
          <SquarePen className="h-4 w-4" />
        </IconButton>
      )
    ) : (
      <>
        {canCreateAgents && (
          <Popover
            align="end"
            trigger={({ open, toggle }) => (
              <IconButton
                label={t("agentList.newAgent")}
                title={needsServer(t("agentList.newAgent")) ?? t("agentList.newAgent")}
                onClick={() => {
                  loadAgentCreation();
                  toggle();
                }}
                aria-expanded={open}
                disabled={offline}
                className={cn(headButton, open && "bg-bg-active text-fg")}
              >
                <SquarePen className="h-4 w-4" />
              </IconButton>
            )}
          >
            {(close) => (
              <div className="w-60">
                <MenuItem
                  icon={<SquarePen className="h-4 w-4" />}
                  onClick={() => {
                    close();
                    setNewAgent("blank");
                  }}
                >
                  {t("agentList.newBlank")}
                </MenuItem>
                <MenuItem
                  icon={<Sparkles className="h-4 w-4" />}
                  disabled={agentCreation?.ai !== "on"}
                  onClick={() => {
                    close();
                    setNewAgent("describe");
                  }}
                >
                  {t("agentList.newDescribe")}
                </MenuItem>
                <MenuItem
                  icon={<LayoutTemplate className="h-4 w-4" />}
                  onClick={() => {
                    close();
                    router.push(`/w/${workspaceId}/settings?tab=agents`);
                  }}
                >
                  {t("agentList.newTemplate")}
                </MenuItem>
              </div>
            )}
          </Popover>
        )}
        <Popover
          align="end"
          trigger={({ open, toggle }) => (
            <IconButton
              label={t("agentList.listActions")}
              title={t("agentList.listActions")}
              onClick={toggle}
              aria-expanded={open}
              className={cn(headButton, open && "bg-bg-active text-fg")}
            >
              <MoreHorizontal className="h-4 w-4" />
            </IconButton>
          )}
        >
          {(close) => (
            <div className="w-56">
              <MenuItem
                icon={<FolderPlus className="h-4 w-4" />}
                disabled={offline || agents.length === 0}
                onClick={() => {
                  close();
                  newAgentGroup();
                }}
              >
                {t("agentList.newGroup")}
              </MenuItem>
              <MenuItem
                icon={<ArrowDownAZ className="h-4 w-4" />}
                disabled={offline || agents.length < 2}
                onClick={() => {
                  close();
                  sortAgentsByName();
                }}
              >
                {t("agentList.sortByName")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Settings className="h-4 w-4" />}
                onClick={() => {
                  close();
                  router.push(`/w/${workspaceId}/settings?tab=agents`);
                }}
              >
                {t("sections.manageAgents")}
              </MenuItem>
            </div>
          )}
        </Popover>
      </>
    );

  // The workspace and the menu to change it: at the panel's foot on wide windows, else in the strip on top.
  const workspacePicker = (atBottom: boolean) => (
    <Popover
      side={atBottom ? "top" : "bottom"}
      wrapperClassName={cn("relative flex min-w-0", (atBottom || !collapsed) && "flex-1")}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title={workspace?.name}
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md ps-1.5 pe-2 font-medium text-fg hover:bg-frame-hover max-md:h-10",
            // Beside the hidden panel only the rail's width is left: the workspace's icon alone.
            !atBottom && collapsed && "md:w-8 md:flex-none md:justify-center md:px-0",
            open && "bg-frame-hover",
          )}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-fg text-xs font-semibold text-bg max-md:h-7 max-md:w-7">
            {workspace?.icon ?? workspace?.name.slice(0, 1).toUpperCase()}
          </span>
          <span className={cn("min-w-0 truncate", !atBottom && collapsed && "md:sr-only")}>{workspace?.name}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-fg-muted", !atBottom && collapsed && "md:hidden")} />
        </button>
      )}
      className="w-64"
    >
      {(close) => (
        <>
          {workspaces.map((w) => (
            <MenuItem
              key={w.id}
              active={w.id === workspaceId}
              onClick={() => {
                close();
                // The page opened last there, for those who start on it (app/w/[workspaceId]/page.tsx).
                router.push(`/w/${w.id}?resume`);
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
        </>
      )}
    </Popover>
  );

  return (
    <>
      {sidebar?.drawerOpen && (
        <div aria-hidden data-window-shade className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={sidebar.close} />
      )}
      <aside
        data-sidebar
        data-sidebar-open={(sidebar && !collapsed) || undefined}
        // A right click on a link opens the app's own menu for it; a page's row opens its actions instead.
        onContextMenu={(e) => {
          if (e.defaultPrevented) return;
          const href = (e.target as Element).closest("a[href]")?.getAttribute("href");
          if (!href?.startsWith("/")) return;
          e.preventDefault();
          setLinkMenu({ href, x: e.clientX, y: e.clientY });
        }}
        // Desktop: the rail, then the panel as a column the user can resize, or — when hidden — a
        // panel that slides out over the page beside the rail while a rail item or it is pointed at.
        // Phones: both in a drawer over the page.
        style={{ "--sidebar-w": `${sidebar?.width ?? 256}px` } as React.CSSProperties}
        onMouseLeave={collapsed ? sidebar?.hidePeek : undefined}
        className={cn(
          "relative flex shrink-0 flex-col text-sm select-none",
          "max-md:fixed max-md:inset-y-0 max-md:inset-s-0 max-md:z-50 max-md:w-[min(21rem,90vw)] max-md:bg-frame max-md:shadow-xl",
          !sidebar?.drawerOpen && "max-md:hidden",
          // Phones: rows and their buttons grow from 28px to 36px so they are easy to tap.
          "max-md:[&_.h-7]:h-9 max-md:[&_.w-7]:w-9",
        )}
      >
        <LinkMenu menu={linkMenu} onClose={() => setLinkMenu(null)} />
        {/* The workspace on the rail's top beside the hidden panel; beside the shown panel, and in a phone's
            drawer, it is at the panel's foot instead. */}
        <div
          data-sidebar-strip
          className={cn(
            "flex h-11 shrink-0 items-center bg-frame max-md:hidden",
            collapsed ? "justify-center" : "hidden",
          )}
        >
          {workspacePicker(false)}
        </div>
        <div className="flex min-h-0 flex-1">
          <div
            data-sidebar-rail
            className={cn(
              "flex w-11 shrink-0 flex-col items-center gap-1 bg-frame pt-2 pb-2 max-md:w-13 max-md:pb-[calc(var(--safe-bottom)+0.5rem)]",
            )}
          >
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              disabled={offline}
              aria-label={t("nav.search")}
              title={needsServer(t("nav.search")) ?? `${t("nav.search")} (⌘K)`}
              className={railItemClass}
            >
              <SearchIcon className={railIconClass} />
            </button>
            {/* The rail's full width and a little room above and below, so the counts on the corners aren't cut off by the scrolling. */}
            <div className="-my-1 min-h-0 flex-1 self-stretch overflow-y-auto py-1 [scrollbar-width:none]">
              <RailTabs label={t("tabs.label")} tabs={railTabs} goKeys={goShown} />
            </div>
            {/* Hides the panel or brings it back, in the same place either way (⌘\ too); on phones it closes the drawer.
                The settings' navigation is the panel there. */}
            {sidebar && (!onSettingsPage || drawerOpen) && (
              <button
                type="button"
                onClick={sidebar.toggle}
                aria-label={panelShown ? t("toggle.close") : t("toggle.open")}
                title={`${panelShown ? t("toggle.close") : t("toggle.open")} (⌘\\)`}
                className={railItemClass}
              >
                <SidebarIcon className={cn(railIconClass, "rtl:-scale-x-100")} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setInboxOpen(true)}
              disabled={offline}
              aria-label={unread > 0 ? `${t("nav.inbox")} · ${t("inbox.unreadCount", { count: unread })}` : t("nav.inbox")}
              title={needsServer(t("nav.inbox")) ?? `${t("nav.inbox")} (G ${RAIL_GO_KEYS.inbox})`}
              className={cn(railItemClass, inboxOpen && railSelectedClass)}
            >
              <TrayIcon className={railIconClass} filled={inboxOpen} />
              {unread > 0 && <RailCount value={unread} tone="accent" selected={inboxOpen} />}
              {goShown && !offline && <RailKey letter={RAIL_GO_KEYS.inbox} />}
            </button>
            <Link
              href={`/w/${workspaceId}/settings`}
              aria-label={t("nav.settings")}
              title={`${t("nav.settings")} (G ${RAIL_GO_KEYS.settings})`}
              aria-current={onSettings ? "page" : undefined}
              className={cn(railItemClass, onSettings && railSelectedClass)}
            >
              <GearIcon className={railIconClass} filled={onSettings} />
              {goShown && <RailKey letter={RAIL_GO_KEYS.settings} />}
            </Link>
            {/* Who is signed in, opening what is used now and then. */}
            <Popover
              side="top"
              className="min-w-60"
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={open}
                  aria-label={user.name || user.email}
                  title={user.name || user.email}
                  onPointerEnter={() => void AccountMenu.preload()}
                  onFocus={() => void AccountMenu.preload()}
                  className={cn(railItemClass, (open || customizing) && "bg-frame-hover")}
                >
                  {/* On the rail's frame the usual light fill all but disappears. */}
                  <UserAvatar name={user.name || user.email} image={user.image} size="sm" colors="bg-fg-muted text-bg" />
                </button>
              )}
            >
              {(close) => (
                <AccountMenu
                  close={close}
                  workspaceId={workspaceId}
                  pathname={pathname}
                  user={user}
                  guest={guest}
                  offline={offline}
                  templates={!!topLevel}
                  customizing={customizing}
                  instanceAdmin={!!isInstanceAdmin}
                  needsServer={needsServer}
                  go={(path) => router.push(path)}
                  onTemplates={() => openTemplates(undefined)}
                  onImport={() => openImport(undefined)}
                  onTrash={() => setTrashOpen(true)}
                  onCustomize={() => {
                    // Arranged where they show: the pages tab, open.
                    if (!customizing) {
                      setTab("home");
                      sidebar?.expand();
                    }
                    setCustomizing(!customizing);
                  }}
                  onShortcuts={() => setShortcutsOpen(true)}
                  onSignOut={signOut}
                />
              )}
            </Popover>
          </div>

          <div
            data-sidebar-panel
            onMouseEnter={collapsed ? sidebar?.showPeek : undefined}
            className={cn(
              "relative flex min-w-0 flex-col border-e border-border bg-bg max-md:flex-1 max-md:pb-(--safe-bottom) md:w-[var(--sidebar-w)]",
              // The card the panel and the page make over the frame (globals.css); the page draws the rest of it.
              // In a phone's drawer the panel is that card alone.
              "max-md:mt-2 max-md:rounded-ss-xl max-md:border-s max-md:border-t",
              !collapsed && "md:mt-2 md:rounded-ss-xl md:border-s md:border-t",
              collapsed &&
                "md:fixed md:top-12 md:bottom-3 md:inset-s-11 md:z-50 md:rounded-e-xl md:border md:border-s-0 md:shadow-2xl md:transition-[translate,opacity,visibility] md:duration-200 md:ease-out",
              collapsed && (sidebar?.peek ? "md:translate-x-0" : "md:invisible md:-translate-x-2 md:opacity-0 md:rtl:translate-x-2"),
            )}
          >
            {sidebar && !collapsed && <ResizeHandle />}
            {/* As tall as the page's top bar beside it (page-view.tsx), so the two titles sit on one line. */}
            <div className="flex h-11 shrink-0 items-center gap-1 ps-4 pe-2">
              <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{panelTitle}</h2>
              <div className="flex shrink-0 items-center gap-0.5">
                {headActions}
              </div>
            </div>

            {offline && (
              <p role="status" className="mx-2 mb-1 flex items-center gap-2 px-2 py-1 text-xs text-fg-muted" title={tOffline("hint")}>
                <CloudOff className="h-3.5 w-3.5 shrink-0" />
                {tOffline("banner")}
              </p>
            )}
            {/* Shown while something waits for the person, or while they are on the page. */}
            {(reviewCount > 0 || pathname === `/w/${workspaceId}/review`) && (
              <div className="mb-1 px-2">
                <SidebarButton
                  icon={<ClipboardCheck className="h-4 w-4" />}
                  href={offline ? undefined : `/w/${workspaceId}/review`}
                  active={pathname === `/w/${workspaceId}/review`}
                  disabled={offline}
                  title={offline ? needsServer(t("nav.review")) : undefined}
                  badge={reviewCount > 0 ? { count: reviewCount, label: t("nav.reviewCount", { count: reviewCount }) } : undefined}
                >
                  {t("nav.review")}
                </SidebarButton>
              </div>
            )}
            {dailyNoteError && (
              <p role="alert" className="mx-4 mb-1 text-xs text-danger">
                {dailyNoteError}
              </p>
            )}
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
            {/* Every panel starts the same 4 px under the head, whatever its first block is. */}
            <nav ref={setNavEl} className="peer flex-1 overflow-y-auto px-2 pt-1 pb-2" aria-label={panelTitle}>
              {shownTab === "tasks" ? (
                <TaskPanel
                  workspaceId={workspaceId}
                  onTasksPage={onTasksPage}
                  view={searchParams.get("view")}
                  place={searchParams.get("in")}
                  by={searchParams.get("by")}
                  overdue={dueTasks.overdue}
                  offline={offline}
                />
              ) : shownTab === "calendar" ? (
                <CalendarPanel workspaceId={workspaceId} pathname={pathname} offline={offline} onPages={noteCalendarPages} />
              ) : shownTab === "meetings" ? (
                <MeetingPanel workspaceId={workspaceId} pathname={pathname} offline={offline} onPages={noteMeetingPages} />
              ) : shownTab === "mail" ? (
                <MailSidebar workspaceId={workspaceId} />
              ) : shownTab === "chat" && aiChat ? (
                <ConversationList actionsSlot={chatActionsEl} />
              ) : shownTab === "agents" ? (
                <AgentList
                  agents={agents}
                  workspaceId={workspaceId}
                  activePath={pathname}
                  arrangement={layout.agents}
                  onArrange={offline ? undefined : arrangeAgentList}
                  renamingGroup={renamingAgentGroup}
                  onRenamingGroup={setRenamingAgentGroup}
                  navigate={router.push}
                />
              ) : shownTab === "journal" ? (
                <>
                  <div className="px-1 pb-3">
                    <DailyNotesCalendar workspaceId={workspaceId} notesKey={journalNotes.map((n) => n.id).join()} />
                  </div>
                  <section aria-labelledby="journal-notes-heading">
                    <h2 id="journal-notes-heading" className={panelHeading}>
                      {tJournal("notes")}
                    </h2>
                    {journalNotes.length === 0 ? <PanelEmpty>{tJournal("noNotes")}</PanelEmpty> : <TreeLevel nodes={journalNotes} depth={0} {...treeProps} />}
                  </section>
                  <JournalStartPicker workspaceId={workspaceId} />
                </>
              ) : customizing ? (
                <CustomizeSections
                  sections={sidebarOrder(layout)
                    .filter((key) => (key === PAGES_SECTION ? !!pagesSpace : key === TEAMSPACES_GROUP ? showTeamspaces : true))
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
              {shownTab === "home" && guest && tree.length === 0 && !topLevel && <p className="px-2 py-1.5 text-fg-muted">{t("pages.nothingShared")}</p>}
            </nav>
            <div className="flex h-12 shrink-0 items-center border-t border-border px-2">
              {workspacePicker(true)}
            </div>

            {/*
              The list fades out at the panel's foot while there is more of it below (useMoreBelow): a
              layer in the panel's color, not a mask, which would fade the row menus opened inside it too.
            */}
            <div aria-hidden className="pointer-events-none relative z-10 h-0 opacity-0 transition-opacity peer-data-more-below:opacity-100">
              <div className="absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-bg" />
            </div>
          </div>
        </div>
      </aside>
      {/* Outside the aside: its slide transform would otherwise anchor these fixed dialogs. */}
      <SearchDialog
        workspaceId={workspaceId}
        open={searchOpen}
        initialQuery={searchQuery}
        onClose={() => {
          setSearchOpen(false);
          setSearchQuery("");
        }}
        commands={[
          // What the sidebar itself offers here; making pages, importing and the trash need the server.
          ...(topLevel && !offline
            ? [
                { id: "new-page", label: t("pages.newPage"), icon: <FileText className="h-4 w-4" />, run: () => create(null, "page", undefined) },
                { id: "new-database", label: t("pages.newDatabase"), icon: <Database className="h-4 w-4" />, run: () => create(null, "database", undefined) },
                ...(canBuild ? [{ id: "build-with-ai", label: tBuild("menuItem"), icon: <Sparkles className="h-4 w-4" />, run: () => setBuildFor({ target: undefined }) }] : []),
                { id: "templates", label: t("pages.fromTemplate"), icon: <LayoutTemplate className="h-4 w-4" />, run: () => openTemplates(undefined) },
                { id: "today", label: tJournal("openToday"), icon: <CalendarCheck className="h-4 w-4" />, run: () => openDailyNote() },
              ]
            : []),
          ...(!offline
            ? [
                { id: "import", label: t("nav.import"), icon: <Upload className="h-4 w-4" />, run: () => openImport(undefined) },
                { id: "trash", label: t("nav.trash"), icon: <Trash2 className="h-4 w-4" />, run: () => setTrashOpen(true) },
                { id: "graph", label: t("nav.graph"), icon: <Waypoints className="h-4 w-4" />, run: () => router.push(`/w/${workspaceId}/graph`) },
                { id: "skills", label: t("nav.skills"), icon: <ScrollText className="h-4 w-4" />, run: () => router.push(`/w/${workspaceId}/skills`) },
                { id: "review", label: t("nav.review"), icon: <ClipboardCheck className="h-4 w-4" />, run: () => router.push(`/w/${workspaceId}/review`) },
              ]
            : []),
          ...(!guest
            ? [{ id: "people", label: t("nav.people"), icon: <Users className="h-4 w-4" />, run: () => router.push(`/w/${workspaceId}/people`) }]
            : []),
          ...(mail
            ? [
                { id: "mail", label: tMail("metaTitle"), icon: <MailIcon className="h-4 w-4" />, run: () => router.push(`/w/${workspaceId}/mail`) },
                { id: "mail-compose", label: tMail("compose"), icon: <MailIcon className="h-4 w-4" />, run: composeMail },
              ]
            : []),
          { id: "inbox", label: t("nav.inbox"), icon: <Inbox className="h-4 w-4" />, run: () => setInboxOpen(true) },
          { id: "settings", label: t("nav.settings"), icon: <Settings className="h-4 w-4" />, run: () => router.push(`/w/${workspaceId}/settings`) },
          { id: "shortcuts", label: tShortcuts("title"), icon: <Keyboard className="h-4 w-4" />, run: () => setShortcutsOpen(true) },
          ...(settingsFound?.workspaceId === workspaceId && !offline
            ? settingsFound.items.map((item) => ({
                id: `setting:${item.id}`,
                label: item.label === item.tab ? t("search.settingsTab", { tab: item.tab }) : t("search.setting", { tab: item.tab, setting: item.label }),
                keywords: item.keywords,
                whenTyped: true,
                icon: <Settings className="h-4 w-4" />,
                run: () => router.push(item.href),
              }))
            : []),
        ]}
      />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {newAgent && agentCreation && (
        <NewAgentDialog
          workspaceId={workspaceId}
          kind={newAgent}
          info={agentCreation}
          onClose={() => setNewAgent(null)}
          onCreated={(agent, kind) => {
            setNewAgent(null);
            read("sidebarAgents", workspaceId)
              .then((result) => result.ok && setAgents(result.data))
              .catch(() => {});
            // Next, as Settings > Agents goes on: what a blank one may open, or a drafted one's settings.
            router.push(agentSettingsPath(workspaceId, agent.id, kind === "blank" ? "access" : "settings"));
          }}
        />
      )}
      {inboxMounted && (
        <InboxDialog
          workspaceId={workspaceId}
          open={inboxOpen}
          onClose={() => setInboxOpen(false)}
          version={inboxVersion}
          onRead={refreshInbox}
        />
      )}
      {reminders.length > 0 && (
        <ReminderPrompt
          workspaceId={workspaceId}
          reminders={reminders}
          onSeen={(item) => {
            reminderSettled(item);
            refreshInbox();
          }}
        />
      )}
      {arrivals.length > 0 && !inboxOpen && reminders.length === 0 && (
        <ArrivalCards workspaceId={workspaceId} arrivals={arrivals} onDismiss={dismissArrivals} onRead={refreshInbox} />
      )}
      {canCreateWorkspace && <NewWorkspaceDialog open={newWorkspaceOpen} onClose={() => setNewWorkspaceOpen(false)} />}
      <TemplatesDialog
        workspaceId={workspaceId}
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        teamspaceId={dialogTarget}
      />
      {buildFor && (
        <BuildWithAiDialog
          workspaceId={workspaceId}
          target={{ teamspaceId: buildFor.target }}
          onClose={() => setBuildFor(null)}
          onCreated={(created) => {
            setBuildFor(null);
            refresh();
            router.push(`/w/${workspaceId}/p/${created.rootId}`);
          }}
        />
      )}
      {importMounted && (
        <ImportDialog
          workspaceId={workspaceId}
          open={importOpen}
          onClose={() => {
            setImportOpen(false);
            setImportFile(null);
          }}
          tree={tree}
          topLevel={Boolean(topLevel)}
          // From a section's menu it starts at that section's top rather than at the open page.
          activeId={dialogTarget === undefined ? activeId : null}
          teamspaceId={dialogTarget}
          file={importFile}
          initialTab={importTab}
        />
      )}
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
          className="flex h-7 w-full items-center gap-0.5 rounded-md ps-1 text-start text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center">
            {all ? <ChevronUp className="h-3.5 w-3.5" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
          </span>
          <span className="ps-0.5">{all ? t("less") : t("more", { count: hidden })}</span>
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
    <section className={cn(panelSection, "mb-1 first:mt-0")} aria-label={label}>
      <div
        {...handlers}
        className={cn("group/section flex h-7 items-center rounded-md pe-1 hover:bg-bg-hover has-[[data-open]]:bg-bg-hover", over && "bg-accent/15")}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={cn(panelHeading, "h-full min-w-0 flex-1 gap-1 text-start hover:text-fg-muted")}
        >
          <span className="truncate">{label}</span>
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 opacity-0 group-hover/section:opacity-100 pointer-coarse:opacity-100" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 rtl:-scale-x-100" />
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
  if (teamspace.icon) return <IconGlyph icon={teamspace.icon} className="text-sm" />;
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
  onWatch,
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
  onWatch: () => void;
  tree: TreeContext;
}) {
  const t = useTranslations("sidebar");
  const router = useRouter();
  const { over, handlers } = useRootDrop({ ...tree, section: teamspace.id, roots });
  // Top-level pages locked to those who manage it (server/teamspaces.ts): no adding them here.
  const adds = teamspace.canArrangeTopLevel;
  return (
    // A little room above each teamspace but the first tells where the one before it ends.
    <li className="not-first:mt-1">
      <div
        {...handlers}
        data-teamspace={teamspace.id}
        className={cn("group relative flex h-7 items-center gap-0.5 rounded-md pe-1 ps-1 hover:bg-bg-hover has-[[data-open]]:bg-bg-hover", over && "bg-accent/15")}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          title={teamspace.description || undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-1 text-start"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center">
            <span className="flex group-hover:hidden pointer-coarse:hidden">
              <TeamspaceIcon teamspace={teamspace} />
            </span>
            {open ? (
              <ChevronDown className="hidden h-3.5 w-3.5 text-fg-faint group-hover:block pointer-coarse:block" />
            ) : (
              <ChevronRight className="hidden h-3.5 w-3.5 text-fg-faint group-hover:block pointer-coarse:block rtl:-scale-x-100" />
            )}
          </span>
          <span className="truncate font-medium">{teamspace.name}</span>
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
                <MenuItem
                  icon={teamspace.watching ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                  title={t(teamspace.watching ? "teamspaces.unwatchHint" : "teamspaces.watchHint")}
                  disabled={tree.offline}
                  onClick={() => {
                    close();
                    onWatch();
                  }}
                >
                  {t(teamspace.watching ? "teamspaces.unwatch" : "teamspaces.watch")}
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
          {adds && (
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
          )}
        </div>
      </div>
      {open &&
        (roots.length > 0 ? (
          <TreeLevel nodes={roots} depth={1} {...tree} />
        ) : adds ? (
          <button
            type="button"
            onClick={onCreate}
            disabled={tree.offline}
            className="block w-full rounded-md py-1 pe-2 text-start text-xs text-fg-faint hover:bg-bg-hover disabled:hover:bg-transparent"
            style={{ paddingInlineStart: 32 }}
          >
            {t("teamspaces.empty")}
          </button>
        ) : null)}
    </li>
  );
}

/** Drag the sidebar's edge beside the page to resize it; double-click restores the default width. */
function ResizeHandle() {
  const t = useTranslations("sidebar.toggle");
  const sidebar = useSidebar();
  const start = useRef<{ x: number; width: number; sign: 1 | -1 } | null>(null);
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
        // Right to left the sidebar sits on the right, so it widens as the pointer moves left.
        start.current = { x: e.clientX, width: sidebar.width, sign: inlineSign() };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s) sidebar.setWidth(s.width + (e.clientX - s.x) * s.sign);
      }}
      onPointerUp={(e) => {
        const s = start.current;
        if (!s) return;
        sidebar.setWidth(s.width + (e.clientX - s.x) * s.sign, true);
        start.current = null;
      }}
      onDoubleClick={() => sidebar.setWidth(SIDEBAR_WIDTH.default, true)}
      className="absolute inset-y-0 -inset-e-1 z-10 hidden w-2 cursor-col-resize after:absolute after:inset-y-0 after:inset-s-[3px] after:w-0.5 after:transition-colors hover:after:bg-accent/60 md:block"
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
    "flex h-7 w-full items-center gap-2 rounded-md px-2 text-start text-fg-muted hover:bg-bg-hover hover:text-fg",
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
    <Link href={href} className={className} onClick={onClick}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={className} disabled={disabled} title={title}>
      {content}
    </button>
  );
}

/** A named button in the sidebar's bottom bar. */
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
  /** A top-level page of a teamspace that locks them, for someone who doesn't manage it: it stays put. */
  pinned: (node: TreeNode) => boolean;
  /** No server: no creating, trashing or moving pages. */
  offline: boolean;
  /** Pages downloaded to this device for offline use. */
  keptOffline: ReadonlySet<string>;
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
  const { dragging, onDragging, canDrop, keptOffline } = props;
  const t = useTranslations("sidebar");
  const tOffline = useTranslations("offline.keep");
  const tc = useTranslations("common");
  const kids = childrenOf.get(node.id) ?? [];
  const isOpen = expanded.has(node.id);
  const [drop, setDrop] = useState<DropTarget>(null);
  const [renaming, setRenaming] = useState(false);
  // The actions menu opens below its button or where the row was right-clicked.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | Element | null>(null);
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
        draggable={editable && !renaming && !props.pinned(node)}
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
        onContextMenu={(e) => {
          // While renaming, the field keeps the system's menu for cutting and pasting.
          if (props.offline || renaming) return;
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
          setMenuOpen(true);
        }}
        className={cn(
          "group relative flex h-7 items-center gap-0.5 rounded-md pe-1 hover:bg-bg-hover has-[[data-open]]:bg-bg-hover",
          // An open database highlights its current view row instead.
          active && !(isOpen && currentViewId) && "bg-bg-active font-medium hover:bg-bg-active has-[[data-open]]:bg-bg-active",
          drop?.zone === "inside" && "bg-accent/15",
        )}
        style={{ paddingInlineStart: 4 + depth * 14 }}
      >
        {drop && drop.zone !== "inside" && (
          <span
            className={cn("pointer-events-none absolute inset-s-1 inset-e-1 h-0.5 rounded bg-accent", drop.zone === "before" ? "top-0" : "bottom-0")}
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
              <ChevronRight className="hidden h-3.5 w-3.5 group-hover:block pointer-coarse:block rtl:-scale-x-100" />
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
            className="ms-0.5 h-6 min-w-0 flex-1 rounded border border-border bg-bg px-1.5 text-sm outline-none focus:border-accent"
          />
        ) : (
          <Link
            href={`/w/${workspaceId}/p/${node.id}`}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 ps-0.5"
          >
            {expandable && (
              <PageIcon icon={node.icon} kind={node.kind} className="hidden text-sm pointer-coarse:inline" />
            )}
            <span className="truncate">{pageLabel(node.title, tc("untitled"))}</span>
            {keptOffline.has(node.id) && (
              <HardDriveDownload
                aria-label={tOffline("badge")}
                className="h-3 w-3 shrink-0 text-fg-faint group-hover:hidden group-has-[[data-open]]:hidden pointer-coarse:hidden"
              >
                <title>{tOffline("badge")}</title>
              </HardDriveDownload>
            )}
          </Link>
        )}
        {/* Downloading needs only read access; renaming, trashing and adding pages need edit access. */}
        {!props.offline && !renaming && (
          <div className="hidden items-center group-hover:flex focus-within:flex has-[[data-open]]:flex pointer-coarse:flex">
            <Popover
              align="end"
              open={menuOpen}
              onOpenChange={setMenuOpen}
              at={menuAt}
              trigger={({ toggle }) => (
                <IconButton
                  label={t("pages.actions")}
                  onClick={(e) => {
                    // Placed in the window rather than in the scrolling list, which would cut it off.
                    setMenuAt(e.currentTarget);
                    toggle();
                  }}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </IconButton>
              )}
            >
              {(close) => (
                <div className="w-56">
                  <MenuItem
                    icon={<ExternalLink className="h-4 w-4" />}
                    onClick={() => {
                      close();
                      window.open(`/w/${workspaceId}/p/${node.id}`, "_blank", "noopener");
                    }}
                  >
                    {t("pages.openInNewTab")}
                  </MenuItem>
                  <MenuItem
                    icon={<Link2 className="h-4 w-4" />}
                    onClick={() => {
                      close();
                      copyLink(`/w/${workspaceId}/p/${node.id}`);
                    }}
                  >
                    {t("pages.copyLink")}
                  </MenuItem>
                  <MenuSeparator />
                  {editable && (
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
                      {!props.pinned(node) && (
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
                      )}
                      <MenuSeparator />
                    </>
                  )}
                  <OfflineToggle
                    page={{ id: node.id, workspaceId, title: node.title, icon: node.icon, kind: node.kind, row: false }}
                  />
                </div>
              )}
            </Popover>
            {canNest && editable && (
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
                  "flex h-7 items-center gap-1.5 rounded-md pe-2 text-fg-muted hover:bg-bg-hover hover:text-fg",
                  v.id === currentViewId && "bg-bg-active font-medium text-fg hover:bg-bg-active",
                )}
                style={{ paddingInlineStart: 4 + (depth + 1) * 14 }}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                  <ViewIcon type={v.type} icon={v.icon} className="h-3.5 w-3.5" />
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
          <p className="py-1 text-xs text-fg-faint" style={{ paddingInlineStart: 46 + depth * 14 }}>
            {t("pages.noChildren")}
          </p>
        )
      )}
    </li>
  );
}

type LinkMenuAt = { href: string; x: number; y: number };

function copyLink(href: string) {
  void navigator.clipboard.writeText(new URL(href, window.location.origin).href).catch(() => undefined);
}

/** What a right click on a link in the sidebar offers, where it was clicked. */
function LinkMenu({ menu, onClose }: { menu: LinkMenuAt | null; onClose: () => void }) {
  const t = useTranslations("sidebar");
  return (
    <Popover open={menu !== null} onOpenChange={(open) => !open && onClose()} at={menu} trigger={() => null} wrapperClassName="absolute">
      {(close) =>
        menu && (
          <div className="w-52">
            {/* The desktop app opens it in a tab of its own window, a browser in one of its tabs. */}
            <MenuItem
              icon={<ExternalLink className="h-4 w-4" />}
              onClick={() => {
                close();
                window.open(menu.href, "_blank", "noopener");
              }}
            >
              {t("pages.openInNewTab")}
            </MenuItem>
            <MenuItem
              icon={<Link2 className="h-4 w-4" />}
              onClick={() => {
                close();
                copyLink(menu.href);
              }}
            >
              {t("pages.copyLink")}
            </MenuItem>
          </div>
        )
      }
    </Popover>
  );
}

/** Whether text is selected in something editable: a page's editor, a field. */
function selectedEditableText(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const node = selection.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element?.closest("[contenteditable='true']"));
}
