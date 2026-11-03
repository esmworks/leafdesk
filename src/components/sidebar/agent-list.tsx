"use client";

import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronRight, ExternalLink, Folder, FolderMinus, FolderPlus, MoreHorizontal, Pencil, Search, Settings2, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { SidebarAgent } from "@/server/agents/manage";
import { IconGlyph } from "@/components/builtin-icon";
import { cn, IconButton, MenuItem, MenuSeparator, Popover } from "@/components/ui";
import { addGroup, arrangeAgents, foldGroup, MAX_AGENT_GROUP_NAME, moveAgent, moveGroup, removeGroup, renameGroup, settled, type AgentArrangement, type AgentPlace } from "@/lib/agent-arrangement";
import { agentPagePath } from "@/lib/agent-page";
import { agentSettingsPath } from "@/lib/agent-settings";

/** From this many agents on, the list gets a filter box. */
const FILTER_FROM = 6;
const AGENT_DRAG = "application/x-leafdesk-agent";
const GROUP_DRAG = "application/x-leafdesk-agent-group";

type Drag = { kind: "agent" | "group"; id: string };
type Zone = "before" | "after" | "inside";
type MenuAt = { x: number; y: number } | Element;
type OpenMenu = { kind: "agent" | "group"; id: string; at: MenuAt };

const zoneOf = (e: React.DragEvent<HTMLElement>): "before" | "after" => {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY - rect.top < rect.height / 2 ? "before" : "after";
};

/** A new group's id: kept only in the person's own layout. */
export const newGroupId = () => crypto.randomUUID();

export type AgentListProps = {
  agents: SidebarAgent[];
  workspaceId: string;
  activePath: string;
  /** How the person grouped and ordered the agents (lib/agent-arrangement.ts). */
  arrangement: AgentArrangement | undefined;
  /** Saves a new arrangement; absent, the list can't be rearranged (offline). */
  onArrange?: (next: AgentArrangement) => void;
  /** The group whose name is being written, and how the list starts or ends that. */
  renamingGroup?: string | null;
  onRenamingGroup?: (groupId: string | null) => void;
  /** Goes to a page of the app (the agent's settings). */
  navigate?: (href: string) => void;
};

/**
 * The agents a person may talk to, one link each, in their own groups and order. In the agents
 * tab, rows and groups move by dragging or from their menus (a right click or the row's ⋯), groups
 * fold, are renamed and removed; each row shows what the agent does and its runs (going, waiting for
 * an answer).
 */
export function AgentList(props: AgentListProps) {
  const { agents, arrangement } = props;
  const t = useTranslations("sidebar.agentList");
  const [query, setQuery] = useState("");
  const { groups, loose } = arrangeAgents(agents, arrangement);

  if (agents.length === 0) return <p className="px-2.5 py-2 text-sm text-fg-muted">{t("empty")}</p>;

  const needle = query.trim().toLocaleLowerCase();
  const filterable = agents.length >= FILTER_FROM;
  return (
    <div className="flex flex-col">
      {filterable && (
        <label className="mb-1.5 flex h-8 items-center gap-2 rounded-md border border-transparent bg-bg-hover ps-2.5 pe-1 text-fg-icon focus-within:border-border focus-within:bg-bg">
          <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              setQuery("");
              e.currentTarget.blur();
            }}
            placeholder={t("filter")}
            aria-label={t("filter")}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <IconButton label={t("clearFilter")} className="h-6 w-6" onClick={() => setQuery("")}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </label>
      )}
      {needle ? <Matches {...props} needle={needle} /> : <Arranged {...props} groups={groups} loose={loose} />}
    </div>
  );
}

/** What the filter finds, in one list, without groups. */
function Matches({ agents, workspaceId, activePath, needle }: AgentListProps & { needle: string }) {
  const t = useTranslations("sidebar.agentList");
  const shown = agents.filter((a) => a.name.toLocaleLowerCase().includes(needle) || a.description.toLocaleLowerCase().includes(needle));
  if (shown.length === 0) return <p className="px-2.5 py-2 text-sm text-fg-muted">{t("noMatch")}</p>;
  return (
    <ul className="space-y-0.5">
      {shown.map((agent) => (
        <li key={agent.id}>
          <div className="group relative flex items-center rounded-md hover:bg-bg-hover has-[[aria-current=page]]:bg-bg-active">
            <RowLink agent={agent} workspaceId={workspaceId} activePath={activePath} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Arranged({
  agents,
  workspaceId,
  activePath,
  arrangement,
  onArrange,
  renamingGroup = null,
  onRenamingGroup,
  navigate,
  groups,
  loose,
}: AgentListProps & ReturnType<typeof arrangeAgents<SidebarAgent>>) {
  const t = useTranslations("sidebar.agentList");
  const tp = useTranslations("sidebar.pages");
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<{ key: string; zone: Zone } | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // Every change starts from the arrangement as shown: each agent placed once, none that is gone.
  const current = settled(agents, arrangement);
  const movable = Boolean(onArrange);

  const arrange = (next: AgentArrangement) => onArrange?.(next);
  const groupOf = (agentId: string) => current.groups.find((g) => g.agents.includes(agentId))?.id ?? null;
  const listOf = (groupId: string | null) => (groupId === null ? current.loose : (current.groups.find((g) => g.id === groupId)?.agents ?? []));
  const endDrag = () => {
    setDragging(null);
    setDrop(null);
  };

  /** Moves an agent one place up or down in its list (the keyboard's way to drag). */
  function stepAgent(agentId: string, delta: -1 | 1) {
    const group = groupOf(agentId);
    const index = listOf(group).indexOf(agentId);
    arrange(moveAgent(current, agentId, { group, index: delta > 0 ? index + 2 : index - 1 }));
  }
  function stepGroup(groupId: string, delta: -1 | 1) {
    const index = current.groups.findIndex((g) => g.id === groupId);
    arrange(moveGroup(current, groupId, delta > 0 ? index + 2 : index - 1));
  }
  function startGroup(agentId?: string) {
    const id = newGroupId();
    arrange(addGroup(current, id, t("groupDefault"), agentId));
    onRenamingGroup?.(id);
  }

  /** Drag handlers for a place agents can be dropped on (a row's edge, a group's heading, an empty group). */
  function agentTarget(key: string, place: (zone: Zone) => AgentPlace | null, zoneFor: (e: React.DragEvent<HTMLElement>) => Zone) {
    return {
      onDragOver: (e: React.DragEvent<HTMLElement>) => {
        if (!movable || dragging?.kind !== "agent" || !e.dataTransfer.types.includes(AGENT_DRAG)) return;
        const zone = zoneFor(e);
        if (!place(zone)) return setDrop(null);
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDrop({ key, zone });
      },
      onDragLeave: () => setDrop((d) => (d?.key === key ? null : d)),
      onDrop: (e: React.DragEvent<HTMLElement>) => {
        if (dragging?.kind !== "agent") return;
        e.preventDefault();
        const target = place(zoneFor(e));
        const agentId = e.dataTransfer.getData(AGENT_DRAG) || dragging.id;
        endDrag();
        if (target) arrange(moveAgent(current, agentId, target));
      },
    };
  }

  const agentRow = (agent: SidebarAgent, groupId: string | null, index: number, count: number) => {
    const key = `agent:${agent.id}`;
    const zone = drop?.key === key ? drop.zone : null;
    const menuOpen = menu?.kind === "agent" && menu.id === agent.id;
    const inGroup = groupId !== null;
    return (
      <li key={agent.id}>
        <div
          draggable={movable}
          onDragStart={(e) => {
            e.dataTransfer.setData(AGENT_DRAG, agent.id);
            e.dataTransfer.effectAllowed = "move";
            setDragging({ kind: "agent", id: agent.id });
          }}
          onDragEnd={endDrag}
          {...agentTarget(
            key,
            (z) => (dragging?.id === agent.id ? null : { group: groupId, index: index + (z === "after" ? 1 : 0) }),
            zoneOf,
          )}
          onContextMenu={(e) => {
            if (!movable) return;
            e.preventDefault();
            setMenu({ kind: "agent", id: agent.id, at: { x: e.clientX, y: e.clientY } });
          }}
          className={cn(
            "group relative flex items-center rounded-md hover:bg-bg-hover has-[[data-open]]:bg-bg-hover has-[[aria-current=page]]:bg-bg-active",
            dragging?.id === agent.id && "opacity-50",
          )}
        >
          {zone && <span className={cn("pointer-events-none absolute inset-s-1 inset-e-1 h-0.5 rounded bg-accent", zone === "before" ? "-top-px" : "-bottom-px")} />}
          <RowLink agent={agent} workspaceId={workspaceId} activePath={activePath} />
          {movable && (
            // No transform here: it would hold the menu, placed in the window, inside the scrolling list.
            <div className="absolute inset-y-0 inset-e-1 hidden items-center bg-inherit group-hover:flex has-[[data-open]]:flex focus-within:flex pointer-coarse:flex">
              <Popover
                align="end"
                open={menuOpen}
                onOpenChange={(open) => setMenu(open ? (menu ?? null) : null)}
                at={menuOpen ? menu.at : null}
                trigger={() => (
                  <IconButton label={t("agentActions")} onClick={(e) => setMenu({ kind: "agent", id: agent.id, at: e.currentTarget })}>
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              >
                {(close) => (
                  <div className="w-60">
                    <MenuItem
                      icon={<ExternalLink className="h-4 w-4" />}
                      onClick={() => {
                        close();
                        window.open(agentPagePath(workspaceId, agent.id), "_blank", "noopener");
                      }}
                    >
                      {tp("openInNewTab")}
                    </MenuItem>
                    {agent.edits && navigate && (
                      <MenuItem
                        icon={<Settings2 className="h-4 w-4" />}
                        onClick={() => {
                          close();
                          navigate(agentSettingsPath(workspaceId, agent.id));
                        }}
                      >
                        {t("settings")}
                      </MenuItem>
                    )}
                    <MenuSeparator />
                    <p className="px-2 pt-1 pb-0.5 text-xs text-fg-faint">{t("moveTo")}</p>
                    {current.groups.map((g) => (
                      <MenuItem
                        key={g.id}
                        icon={<Folder className="h-4 w-4" />}
                        trailing={g.id === groupId ? <Check className="h-3.5 w-3.5" /> : undefined}
                        onClick={() => {
                          close();
                          if (g.id !== groupId) arrange(moveAgent(current, agent.id, { group: g.id, index: g.agents.length }));
                        }}
                      >
                        {g.name}
                      </MenuItem>
                    ))}
                    <MenuItem
                      icon={<FolderPlus className="h-4 w-4" />}
                      onClick={() => {
                        close();
                        startGroup(agent.id);
                      }}
                    >
                      {t("newGroup")}
                    </MenuItem>
                    {inGroup && (
                      <MenuItem
                        icon={<FolderMinus className="h-4 w-4" />}
                        onClick={() => {
                          close();
                          arrange(moveAgent(current, agent.id, { group: null, index: current.loose.length }));
                        }}
                      >
                        {t("removeFromGroup")}
                      </MenuItem>
                    )}
                    <MenuSeparator />
                    <MenuItem
                      icon={<ArrowUp className="h-4 w-4" />}
                      disabled={index === 0}
                      onClick={() => {
                        close();
                        stepAgent(agent.id, -1);
                      }}
                    >
                      {t("moveUp")}
                    </MenuItem>
                    <MenuItem
                      icon={<ArrowDown className="h-4 w-4" />}
                      disabled={index === count - 1}
                      onClick={() => {
                        close();
                        stepAgent(agent.id, 1);
                      }}
                    >
                      {t("moveDown")}
                    </MenuItem>
                  </div>
                )}
              </Popover>
            </div>
          )}
        </div>
      </li>
    );
  };

  const draggingAgent = dragging?.kind === "agent";
  return (
    <div className="flex flex-col gap-1">
      {groups.map(({ group, agents: inGroup }, gi) => {
        const open = !group.folded;
        const key = `group:${group.id}`;
        const zone = drop?.key === key ? drop.zone : null;
        const menuOpen = menu?.kind === "group" && menu.id === group.id;
        const agentDrop = agentTarget(key, () => ({ group: group.id, index: inGroup.length }), () => "inside");
        return (
          <section key={group.id} aria-label={group.name}>
            <div
              draggable={movable && renamingGroup !== group.id}
              onDragStart={(e) => {
                e.dataTransfer.setData(GROUP_DRAG, group.id);
                e.dataTransfer.effectAllowed = "move";
                setDragging({ kind: "group", id: group.id });
              }}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                if (dragging?.kind === "agent") return agentDrop.onDragOver(e);
                if (!movable || dragging?.kind !== "group" || dragging.id === group.id || !e.dataTransfer.types.includes(GROUP_DRAG)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDrop({ key, zone: zoneOf(e) });
              }}
              onDragLeave={agentDrop.onDragLeave}
              onDrop={(e) => {
                if (dragging?.kind === "agent") return agentDrop.onDrop(e);
                if (dragging?.kind !== "group") return;
                e.preventDefault();
                const after = zoneOf(e) === "after";
                const groupId = e.dataTransfer.getData(GROUP_DRAG) || dragging.id;
                endDrag();
                arrange(moveGroup(current, groupId, gi + (after ? 1 : 0)));
              }}
              onContextMenu={(e) => {
                if (!movable || renamingGroup === group.id) return;
                e.preventDefault();
                setMenu({ kind: "group", id: group.id, at: { x: e.clientX, y: e.clientY } });
              }}
              className={cn(
                "group/agentgroup relative flex h-7 items-center rounded-md pe-1 hover:bg-bg-hover has-[[data-open]]:bg-bg-hover",
                zone === "inside" && "bg-accent/15",
                dragging?.id === group.id && "opacity-50",
              )}
            >
              {(zone === "before" || zone === "after") && (
                <span className={cn("pointer-events-none absolute inset-s-1 inset-e-1 h-0.5 rounded bg-accent", zone === "before" ? "-top-px" : "-bottom-px")} />
              )}
              {renamingGroup === group.id ? (
                <GroupNameInput
                  name={group.name}
                  label={t("groupName")}
                  onDone={(name) => {
                    onRenamingGroup?.(null);
                    if (name !== null) arrange(renameGroup(current, group.id, name));
                  }}
                />
              ) : (
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => arrange(foldGroup(current, group.id, open))}
                  className="flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-start text-xs font-medium text-fg-faint hover:text-fg-muted"
                >
                  {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0 rtl:-scale-x-100" />}
                  <span className="truncate">{group.name}</span>
                  <span className="tabular-nums font-normal">{inGroup.length}</span>
                </button>
              )}
              {movable && renamingGroup !== group.id && (
                <div className="flex items-center opacity-0 group-hover/agentgroup:opacity-100 focus-within:opacity-100 has-[[data-open]]:opacity-100 pointer-coarse:opacity-100">
                  <Popover
                    align="end"
                    open={menuOpen}
                    onOpenChange={(o) => setMenu(o ? (menu ?? null) : null)}
                    at={menuOpen ? menu.at : null}
                    trigger={() => (
                      <IconButton label={t("groupActions")} onClick={(e) => setMenu({ kind: "group", id: group.id, at: e.currentTarget })}>
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                  >
                    {(close) => (
                      <div className="w-56">
                        <MenuItem
                          icon={<Pencil className="h-4 w-4" />}
                          onClick={() => {
                            close();
                            onRenamingGroup?.(group.id);
                          }}
                        >
                          {t("renameGroup")}
                        </MenuItem>
                        <MenuItem
                          icon={<ArrowUp className="h-4 w-4" />}
                          disabled={gi === 0}
                          onClick={() => {
                            close();
                            stepGroup(group.id, -1);
                          }}
                        >
                          {t("moveUp")}
                        </MenuItem>
                        <MenuItem
                          icon={<ArrowDown className="h-4 w-4" />}
                          disabled={gi === groups.length - 1}
                          onClick={() => {
                            close();
                            stepGroup(group.id, 1);
                          }}
                        >
                          {t("moveDown")}
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          danger
                          icon={<Trash2 className="h-4 w-4" />}
                          onClick={() => {
                            close();
                            arrange(removeGroup(current, group.id));
                          }}
                        >
                          {t("removeGroup")}
                        </MenuItem>
                      </div>
                    )}
                  </Popover>
                </div>
              )}
            </div>
            {open &&
              (inGroup.length > 0 ? (
                <ul className="space-y-0.5">{inGroup.map((agent, i) => agentRow(agent, group.id, i, inGroup.length))}</ul>
              ) : (
                <p
                  {...agentTarget(`empty:${group.id}`, () => ({ group: group.id, index: 0 }), () => "inside")}
                  className={cn("rounded-md px-2.5 py-1.5 text-xs text-fg-faint", drop?.key === `empty:${group.id}` && "bg-accent/15")}
                >
                  {t("emptyGroup")}
                </p>
              ))}
          </section>
        );
      })}
      {(loose.length > 0 || draggingAgent) && (
        <section aria-label={groups.length > 0 ? t("other") : undefined}>
          {groups.length > 0 && (
            <p
              {...agentTarget("loose", () => ({ group: null, index: 0 }), () => "inside")}
              className={cn("flex h-7 items-center rounded-md px-2 text-xs font-medium text-fg-faint", drop?.key === "loose" && "bg-accent/15")}
            >
              {t("other")}
            </p>
          )}
          <ul className="space-y-0.5">{loose.map((agent, i) => agentRow(agent, null, i, loose.length))}</ul>
        </section>
      )}
    </div>
  );
}

/** The row's link: icon, name, what the agent does (or that it is off) and its runs. */
function RowLink({ agent, workspaceId, activePath }: { agent: SidebarAgent; workspaceId: string; activePath: string }) {
  const t = useTranslations("sidebar.agentList");
  const href = agentPagePath(workspaceId, agent.id);
  const current = activePath === href || activePath.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      draggable={false}
      aria-current={current ? "page" : undefined}
      className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 rounded-md py-2 ps-1.5 pe-2"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center">
        {agent.icon ? <IconGlyph icon={agent.icon} className="text-base" /> : <Bot className="h-4 w-4 text-fg-muted" aria-hidden />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-sm font-medium", agent.enabled ? "text-fg" : "text-fg-muted")}>{agent.name}</span>
        {(agent.description || !agent.enabled) && <span className="truncate text-xs text-fg-faint">{agent.enabled ? agent.description : t("off")}</span>}
      </span>
      <AgentState agent={agent} />
    </Link>
  );
}

/** The group's name being written: Enter or leaving keeps it, Escape keeps the old one. */
function GroupNameInput({ name, label, onDone }: { name: string; label: string; onDone: (name: string | null) => void }) {
  const cancelled = useRef(false);
  return (
    <input
      autoFocus
      defaultValue={name}
      aria-label={label}
      maxLength={MAX_AGENT_GROUP_NAME}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          // Stops the sidebar or a dialog from closing too.
          e.stopPropagation();
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => onDone(cancelled.current ? null : e.currentTarget.value)}
      className="mx-1 h-6 min-w-0 flex-1 rounded border border-border bg-bg px-1.5 text-sm outline-none focus:border-accent"
    />
  );
}

/**
 * A running dot, and a count of runs waiting for an answer, on the row's end; a dot for a run of
 * someone else's waiting for the owner's decision.
 */
function AgentState({ agent }: { agent: SidebarAgent }) {
  const t = useTranslations("sidebar");
  if (agent.waiting > 0) {
    return (
      <span className="shrink-0 rounded-full bg-accent px-1.5 text-[11px] leading-4 font-semibold text-white tabular-nums">
        <span className="sr-only">{t("agentList.waiting", { count: agent.waiting })}</span>
        <span aria-hidden>{agent.waiting > 99 ? "99+" : agent.waiting}</span>
      </span>
    );
  }
  if (agent.approval) {
    return <span className="size-1.5 shrink-0 rounded-full bg-accent" role="img" aria-label={t("rail.agentWaiting")} title={t("rail.agentWaiting")} />;
  }
  if (agent.active > 0) {
    return <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" role="img" aria-label={t("agentList.running")} title={t("agentList.running")} />;
  }
  return null;
}
