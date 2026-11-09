"use client";

/**
 * The workspace's library (app/w/[workspaceId]/library): one row of tabs, each a list of what the
 * workspace holds (teamspaces, recent, favorite, shared and private pages, meeting notes, agents,
 * skills), with a search over the tab's list and the one button that makes something new there.
 * The tabs are links (`?tab=`): the server loads only the tab shown.
 */
import { Plus, Search, Sparkles, SquarePen } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";
import { createMeetingNoteAction } from "@/app/actions/meetings";
import { createPageAction } from "@/app/actions/pages";
import { createSkillAction } from "@/app/actions/skills";
import { IconGlyph } from "@/components/builtin-icon";
import { lazyPart } from "@/components/lazy-part";
import { markNewPage } from "@/components/page/new-page-focus";
import { PlaceTopBar } from "@/components/place-top-bar";
import { BooksIcon, RobotIcon } from "@/components/sidebar/rail-icons";
import { TeamspaceDialog } from "@/components/teamspaces/teamspace-dialog";
import { Button, cn, Input, MenuItem, PageIcon, Popover } from "@/components/ui";
import { agentSettingsPath } from "@/lib/agent-settings";
import { pageLabel } from "@/lib/labels";
import { isUpcoming, matchesMeeting, type MeetingListItem } from "@/lib/meeting-list";
import { initialOf } from "@/lib/presence";
import { withRow } from "@/lib/row-panel";
import type { PageKind } from "@/db/schema";
import type { TeamspaceAccess } from "@/db/schema/app";
import type { AgentCreationInfo } from "@/server/agents/creation";

const NewAgentDialog = lazyPart(() => import("@/components/sidebar/new-agent").then((m) => m.NewAgentDialog));

export type LibraryTab = "teamspaces" | "recents" | "favorites" | "shared" | "private" | "meetings" | "agents" | "skills";

export type LibraryPageItem = {
  id: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  href: string;
  /** The page it sits in, if any. */
  place: string | null;
  /** When the person last opened it, or it last changed. */
  when: string | null;
  /** Shared and private pages: how many pages it holds. */
  inside?: number;
};

export type LibraryData =
  | {
      tab: "teamspaces";
      canCreate: boolean;
      isOwner: boolean;
      teamspaces: { id: string; name: string; icon: string | null; description: string; access: TeamspaceAccess; members: number; joined: boolean }[];
    }
  | { tab: "recents" | "favorites" | "shared" | "private"; canCreate: boolean; pages: LibraryPageItem[] }
  | { tab: "meetings"; canCreate: boolean; meetings: MeetingListItem[] }
  | {
      tab: "agents";
      agents: { id: string; name: string; icon: string | null; description: string; enabled: boolean }[];
      /** Null when the person may not create agents. */
      creation: AgentCreationInfo | null;
    }
  | {
      tab: "skills";
      canCreate: boolean;
      skills: { id: string; title: string; icon: string | null; description: string; href: string; database: string | null; when: string }[];
    };

const DAY = 24 * 60 * 60 * 1000;

export function LibraryPage({
  workspaceId,
  tabs,
  data,
  privateOnly,
}: {
  workspaceId: string;
  tabs: readonly LibraryTab[];
  data: LibraryData;
  /** A guest whose new pages can only be private. */
  privateOnly: boolean;
}) {
  const t = useTranslations("sidebar");
  const tc = useTranslations("common");
  const tm = useTranslations("meetings");
  const ts = useTranslations("settings");
  const tt = useTranslations("teamspaces");
  const tk = useTranslations("skills");
  const tdb = useTranslations("database");
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [teamspaceOpen, setTeamspaceOpen] = useState(false);
  const [newAgent, setNewAgent] = useState<"blank" | "describe" | null>(null);

  const tabLabel: Record<LibraryTab, string> = {
    teamspaces: t("teamspaces.heading"),
    recents: t("library.recents"),
    favorites: t("pages.favorites"),
    shared: t("sections.shared"),
    private: t("sections.private"),
    meetings: tm("heading"),
    agents: t("sections.agents"),
    skills: t("nav.skills"),
  };
  const tabHref = (tab: LibraryTab) => `/w/${workspaceId}/library${tab === tabs[0] ? "" : `?tab=${tab}`}`;

  const words = query.toLocaleLowerCase(locale).split(/\s+/).filter(Boolean);
  const found = (...texts: (string | null | undefined)[]) => {
    const text = texts.filter(Boolean).join("\n").toLocaleLowerCase(locale);
    return words.every((word) => text.includes(word));
  };

  const thisYear = new Date().getFullYear();
  const day = (iso: string | null) => {
    if (!iso) return "";
    const date = new Date(iso);
    return format.dateTime(date, date.getFullYear() === thisYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
  };

  function create(run: () => Promise<string | null>) {
    setError(null);
    startTransition(async () => {
      try {
        const href = await run();
        if (href) router.push(href);
      } catch {
        setError(tc("genericError"));
      }
    });
  }

  const newPage = () =>
    create(async () => {
      const { id } = await createPageAction({ workspaceId, ...(privateOnly || data.tab === "private" ? { teamspaceId: null } : {}) });
      markNewPage(id);
      return `/w/${workspaceId}/p/${id}`;
    });

  const primary = (label: string, onClick: () => void) => (
    <Button variant="primary" size="sm" disabled={pending} onClick={onClick}>
      <Plus className="h-3.5 w-3.5" />
      {label}
    </Button>
  );

  let action: ReactNode = null;
  switch (data.tab) {
    case "teamspaces":
      if (data.canCreate) action = primary(t("teamspaces.new"), () => setTeamspaceOpen(true));
      break;
    case "recents":
    case "favorites":
    case "shared":
    case "private":
      if (data.canCreate) action = primary(t("pages.newPage"), newPage);
      break;
    case "meetings":
      if (data.canCreate)
        action = primary(tm("newMeeting"), () =>
          create(async () => {
            const result = await createMeetingNoteAction(workspaceId);
            if (!result.ok) throw new Error(result.error);
            return `/w/${workspaceId}/p/${result.data.id}`;
          }),
        );
      break;
    case "agents":
      if (data.creation)
        action = (
          <Popover
            align="end"
            trigger={({ open, toggle }) => (
              <Button variant="primary" size="sm" aria-expanded={open} onClick={toggle}>
                <Plus className="h-3.5 w-3.5" />
                {t("agentList.newAgent")}
              </Button>
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
                  disabled={data.creation?.ai !== "on"}
                  onClick={() => {
                    close();
                    setNewAgent("describe");
                  }}
                >
                  {t("agentList.newDescribe")}
                </MenuItem>
              </div>
            )}
          </Popover>
        );
      break;
    case "skills":
      if (data.canCreate)
        action = primary(tk("new"), () =>
          create(async () => {
            const result = await createSkillAction(workspaceId);
            if (!result.ok) throw new Error(result.error);
            markNewPage(result.data.id);
            return withRow(`/w/${workspaceId}/p/${result.data.databaseId}`, result.data.id);
          }),
        );
      break;
  }

  return (
    <>
      <PlaceTopBar icon={<BooksIcon />} title={t("nav.library")} />
      <div className="page-gutter pt-6 pb-16">
        <header className="mb-6 flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2.5 font-display text-2xl leading-tight tracking-tight md:text-3xl">
              <BooksIcon className="h-7 w-7 shrink-0 text-fg-icon" />
              {t("nav.library")}
            </h1>
            <p className="mt-2 text-sm text-fg-muted">{t("library.description")}</p>
          </div>
          {action && <div className="shrink-0 pt-1">{action}</div>}
        </header>

        <div className="relative flex flex-wrap items-end gap-x-4">
          <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-border" />
          <nav aria-label={t("nav.library")} className="relative flex max-w-full min-w-0 gap-4 overflow-x-auto [scrollbar-width:none]">
            {tabs.map((tab) => {
              const current = tab === data.tab;
              return (
                <Link
                  key={tab}
                  href={tabHref(tab)}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "shrink-0 border-b-2 py-2 text-sm whitespace-nowrap transition-colors",
                    current ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg",
                  )}
                >
                  {tabLabel[tab]}
                </Link>
              );
            })}
          </nav>
          <div className="relative ms-auto pb-1.5">
            <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-[calc(50%+3px)] text-fg-faint" />
            <Input
              type="search"
              aria-label={t("nav.search")}
              placeholder={t("nav.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-7 w-44 ps-7 sm:w-56"
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="pt-3">
          {data.tab === "teamspaces" && (
            <Table
              columns="grid-cols-[minmax(0,1fr)_6rem] md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_7rem_6rem]"
              head={[tdb("nameColumn"), tt("dialog.description"), ts("teamspaces.columns.access"), ts("nav.members")]}
              wide={[1, 2]}
              empty={t("library.empty")}
              rows={data.teamspaces
                .filter((s) => found(s.name, s.description))
                .map((s) => ({
                  key: s.id,
                  href: `/w/${workspaceId}/settings?tab=teamspaces`,
                  cells: [
                    <Name key="name" icon={
                        s.icon ? (
                          <IconGlyph icon={s.icon} />
                        ) : (
                          <span className="flex h-4 w-4 items-center justify-center rounded bg-fg-muted text-[10px] font-semibold text-bg">
                            {initialOf(s.name, locale)}
                          </span>
                        )
                      } title={s.name} />,
                    <Muted key="description">{s.description}</Muted>,
                    <Muted key="access">{tt(`access.${s.access}`)}</Muted>,
                    <Meta key="members">{format.number(s.members)}</Meta>,
                  ],
                }))}
            />
          )}

          {(data.tab === "recents" || data.tab === "favorites" || data.tab === "shared" || data.tab === "private") && (
            <Table
              columns={
                data.tab === "shared" || data.tab === "private"
                  ? "grid-cols-[minmax(0,1fr)]"
                  : "grid-cols-[minmax(0,1fr)_5rem] md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_6rem]"
              }
              head={data.tab === "shared" || data.tab === "private" ? [tdb("nameColumn")] : [tdb("nameColumn"), t("library.location"), t("library.date")]}
              wide={[1]}
              empty={t("library.empty")}
              rows={data.pages
                .filter((p) => found(p.title, p.place))
                .map((p) => ({
                  key: p.id,
                  href: p.href,
                  cells: [
                    <Name
                      key="name"
                      icon={<PageIcon icon={p.icon} kind={p.kind} className="h-4 w-4" />}
                      title={pageLabel(p.title, tc("untitled"))}
                      after={p.inside ? <Meta>{format.number(p.inside)}</Meta> : null}
                    />,
                    ...(data.tab === "shared" || data.tab === "private"
                      ? []
                      : [<Muted key="place">{p.place}</Muted>, <Meta key="when">{day(p.when)}</Meta>]),
                  ],
                }))}
            />
          )}

          {data.tab === "meetings" && (
            <MeetingGroups
              meetings={data.meetings.filter((m) => !words.length || matchesMeeting(m, query))}
              workspaceId={workspaceId}
              day={day}
            />
          )}

          {data.tab === "agents" &&
            (() => {
              const agents = data.agents.filter((a) => found(a.name, a.description));
              if (!agents.length) return <p className="py-6 text-sm text-fg-muted">{t("library.empty")}</p>;
              return (
                <ul className="grid gap-3 pt-2 sm:grid-cols-2 lg:grid-cols-3">
                  {agents.map((a) => (
                    <li key={a.id}>
                      <Link
                        href={`/w/${workspaceId}/agents/${a.id}`}
                        className="flex h-full flex-col gap-2 rounded-lg border border-border p-4 transition-colors hover:bg-bg-hover"
                      >
                        <span className="flex h-8 w-8 items-center justify-center text-xl text-fg-icon">
                          {a.icon ? <IconGlyph icon={a.icon} /> : <RobotIcon className="h-6 w-6" />}
                        </span>
                        <span className="text-sm font-semibold text-fg">{a.name}</span>
                        {a.description && <span className="line-clamp-2 text-[13px] text-fg-muted">{a.description}</span>}
                        <span className="mt-auto pt-1 text-xs text-fg-faint">
                          {a.enabled ? ts("agents.status.active") : ts("agents.status.paused")}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              );
            })()}

          {data.tab === "skills" && (
            <Table
              columns="grid-cols-[minmax(0,1fr)_5rem] md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_minmax(0,10rem)_6rem]"
              head={[tdb("nameColumn"), tt("dialog.description"), t("library.location"), t("library.date")]}
              wide={[1, 2]}
              empty={t("library.empty")}
              rows={data.skills
                .filter((s) => found(s.title, s.description, s.database))
                .map((s) => ({
                  key: s.id,
                  href: s.href,
                  cells: [
                    <Name key="name" icon={<PageIcon icon={s.icon} kind="page" className="h-4 w-4" />} title={pageLabel(s.title, tc("untitled"))} />,
                    <Muted key="description">{s.description}</Muted>,
                    <Muted key="database">{s.database}</Muted>,
                    <Meta key="when">{day(s.when)}</Meta>,
                  ],
                }))}
            />
          )}
        </div>
      </div>

      {data.tab === "teamspaces" && (
        <TeamspaceDialog
          workspaceId={workspaceId}
          open={teamspaceOpen}
          onClose={() => setTeamspaceOpen(false)}
          isWorkspaceOwner={data.isOwner}
          onSaved={() => {
            setTeamspaceOpen(false);
            router.refresh();
          }}
        />
      )}
      {data.tab === "agents" && newAgent && data.creation && (
        <NewAgentDialog
          workspaceId={workspaceId}
          kind={newAgent}
          info={data.creation}
          onClose={() => setNewAgent(null)}
          onCreated={(agent, kind) => {
            setNewAgent(null);
            router.push(agentSettingsPath(workspaceId, agent.id, kind === "blank" ? "access" : "settings"));
          }}
        />
      )}
    </>
  );
}

/**
 * A list drawn as a table: a header line and a row per item, each a link. `wide` names the columns
 * shown only on wide screens (`md:`); the column template must leave them out below that.
 */
function Table({
  columns,
  head,
  wide = [],
  rows,
  empty,
}: {
  columns: string;
  head: string[];
  wide?: number[];
  rows: { key: string; href: string; cells: ReactNode[] }[];
  empty: string;
}) {
  if (!rows.length) return <p className="py-6 text-sm text-fg-muted">{empty}</p>;
  const hide = (i: number) => wide.includes(i) && "max-md:hidden";
  return (
    <div role="table">
      <div role="row" className={cn("grid items-center gap-4 px-2 py-2 text-xs text-fg-faint", columns)}>
        {head.map((label, i) => (
          <span key={i} role="columnheader" className={cn("truncate", hide(i), i === head.length - 1 && i > 0 && "text-end")}>
            {label}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <Link key={row.key} role="row" href={row.href} className={cn("grid min-h-10 items-center gap-4 rounded-md px-2 py-1.5 hover:bg-bg-hover", columns)}>
          {row.cells.map((cell, i) => (
            <span key={i} role="cell" className={cn("min-w-0", hide(i), i === row.cells.length - 1 && i > 0 && "text-end")}>
              {cell}
            </span>
          ))}
        </Link>
      ))}
    </div>
  );
}

function Name({ icon, title, after }: { icon: ReactNode; title: string; after?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[15px] text-fg-icon">{icon}</span>
      <span className="truncate text-sm font-medium text-fg">{title}</span>
      {after}
    </span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="block truncate text-[13px] text-fg-muted">{children}</span>;
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="text-xs text-fg-faint tabular-nums">{children}</span>;
}

/** Meeting notes by when they were held: still to come, the last week, the last month, then by month. */
function MeetingGroups({ meetings, workspaceId, day }: { meetings: MeetingListItem[]; workspaceId: string; day: (iso: string | null) => string }) {
  const t = useTranslations("sidebar");
  const tm = useTranslations("meetings");
  const format = useFormatter();
  const [now] = useState(() => Date.now());
  if (!meetings.length) return <p className="py-6 text-sm text-fg-muted">{t("library.empty")}</p>;

  const groups = new Map<string, { label: string; items: MeetingListItem[] }>();
  for (const item of meetings) {
    const when = item.startedAt ?? item.scheduledAt;
    let key: string;
    let label: string;
    if (isUpcoming(item, now)) [key, label] = ["upcoming", tm("upcoming")];
    else if (!when) [key, label] = ["undated", tm("past")];
    else if (now - Date.parse(when) < 7 * DAY) [key, label] = ["week", t("search.filters.week")];
    else if (now - Date.parse(when) < 30 * DAY) [key, label] = ["month", t("search.filters.month")];
    else {
      const date = new Date(when);
      key = `${date.getFullYear()}-${date.getMonth()}`;
      label = format.dateTime(date, { month: "long", year: "numeric" });
    }
    const group = groups.get(key) ?? { label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const columns = "grid-cols-[minmax(0,1fr)_5rem] md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_6rem]";

  return (
    <div className="space-y-5">
      {[...groups.entries()].map(([key, group]) => (
        <section key={key} aria-label={group.label}>
          <h2 className="px-2 pt-2 pb-1 text-xs font-medium text-fg-muted">{group.label}</h2>
          <div role="table">
            <div role="row" className={cn("grid items-center gap-4 px-2 py-1.5 text-xs text-fg-faint", columns)}>
              <span role="columnheader">{tm("slash.title")}</span>
              <span role="columnheader" className="max-md:hidden">
                {tm("block.attendees")}
              </span>
              <span role="columnheader" className="text-end">
                {t("library.date")}
              </span>
            </div>
            {group.items.map((item) => (
              <Link
                key={item.pageId}
                role="row"
                href={`/w/${workspaceId}/p/${item.pageId}`}
                className={cn("grid min-h-10 items-center gap-4 rounded-md px-2 py-1.5 hover:bg-bg-hover", columns)}
              >
                <span role="cell" className="min-w-0">
                  <Name icon={item.icon ? <IconGlyph icon={item.icon} /> : <PageIcon icon={null} kind="page" className="h-4 w-4" />} title={item.title.trim() || item.pageTitle.trim() || tm("untitled")} />
                </span>
                <span role="cell" className="min-w-0 max-md:hidden">
                  <Muted>{item.attendees.map((a) => a.name).join(", ")}</Muted>
                </span>
                <span role="cell" className="text-end">
                  <Meta>{day(item.startedAt ?? item.scheduledAt)}</Meta>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
