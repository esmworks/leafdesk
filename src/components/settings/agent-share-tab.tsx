"use client";

import { Crown, Search, Users, UsersRound, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { agentSharingAction, removeAgentShareAction, setAgentShareAction } from "@/app/actions/agents";
import type { ActionResult } from "@/app/actions/workspaces";
import { cn } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { AGENT_SHARE_LEVELS, type AgentShareLevel, type AgentShareTarget, type AgentSharingView } from "@/lib/agent-sharing";
import type { AgentView } from "@/lib/agents";

/**
 * Who the agent is shared with (lib/agent-sharing.ts): everyone in the workspace, people and
 * groups, each at a level. Those with full access change the list; anyone else it is shared with
 * sees it. Workspace owners always have full access, so they aren't offered.
 */
export function AgentShareTab({ workspaceId, agent }: { workspaceId: string; agent: AgentView }) {
  const t = useTranslations("settings.agents.share");
  const tc = useTranslations("common");
  const [sharing, setSharing] = useState<AgentSharingView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    agentSharingAction(workspaceId, agent.id)
      .then((res) => {
        if (!live) return;
        if (res.ok) setSharing(res.data);
        else setLoadError(res.error);
      })
      .catch(() => live && setLoadError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id, tc]);

  const change = async (action: () => Promise<ActionResult<AgentSharingView>>) => {
    setPending(true);
    setError(null);
    try {
      const res = await action();
      if (res.ok) setSharing(res.data);
      else setError(res.error);
    } catch {
      setError(tc("genericError"));
    } finally {
      setPending(false);
    }
  };
  const set = (target: AgentShareTarget, level: AgentShareLevel) => change(() => setAgentShareAction(workspaceId, agent.id, target, level));
  const remove = (target: AgentShareTarget) => change(() => removeAgentShareAction(workspaceId, agent.id, target));

  if (!sharing) {
    return (
      <p className="px-5 py-4 text-sm text-fg-muted" role={loadError ? "alert" : undefined}>
        {loadError ?? tc("loading")}
      </p>
    );
  }

  const manages = sharing.level === "full" && !agent.archived;
  const everyone = sharing.entries.find((e) => e.kind === "everyone")?.level ?? null;
  const listed = new Set(sharing.entries.map((e) => (e.kind === "person" ? e.userId : e.kind === "group" ? e.groupId : "")));
  const q = query.trim().toLowerCase();
  const people = q
    ? sharing.members.filter((m) => !m.owner && !listed.has(m.userId) && (m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))).slice(0, 8)
    : [];
  const groups = q ? sharing.groups.filter((g) => !listed.has(g.groupId) && g.name.toLowerCase().includes(q)).slice(0, 5) : [];
  const pick = (target: AgentShareTarget) => {
    setQuery("");
    // Named on its own, someone gets more than everyone: they are added able to change it.
    void set(target, "edit");
  };
  const control = (level: AgentShareLevel, target: AgentShareTarget, label: string) =>
    manages ? (
      <LevelSelect value={level} name={label} disabled={pending} onChange={(next) => void set(target, next)} onRemove={() => void remove(target)} />
    ) : (
      <span className="px-2 text-sm text-fg-muted">{t(`levels.${level}`)}</span>
    );

  return (
    <div className={cn("max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4", pending && "opacity-70")}>
      <p className="text-sm text-fg-muted">{t("description")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-bg-subtle px-3 py-2 text-xs">
        {AGENT_SHARE_LEVELS.map((level) => (
          <div key={level} className="contents">
            <dt className="font-medium">{t(`levels.${level}`)}</dt>
            <dd className="text-fg-muted">{t(`levelHelp.${level}`)}</dd>
          </div>
        ))}
      </dl>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      {manages ? (
        <div>
          <label className="flex h-9 items-center gap-2 rounded-md border border-border px-2 focus-within:border-accent">
            <Search className="h-4 w-4 shrink-0 text-fg-faint" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("add")}
              aria-label={t("add")}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
            />
          </label>
          {q && (
            // In the flow rather than floating: the tab scrolls, and would cut a floating list off.
            <div className="mt-1 rounded-lg border border-border p-1">
              {people.map((m) => (
                <button
                  key={m.userId}
                  type="button"
                  onClick={() => pick({ kind: "person", userId: m.userId })}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start hover:bg-bg-hover"
                >
                  <UserAvatar name={m.name} image={m.image} size="md" colors="bg-accent/15 text-accent" />
                  <Label name={m.name} detail={m.email} />
                </button>
              ))}
              {groups.map((g) => (
                <button
                  key={g.groupId}
                  type="button"
                  onClick={() => pick({ kind: "group", groupId: g.groupId })}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start hover:bg-bg-hover"
                >
                  <GroupAvatar />
                  <Label name={g.name} detail={t("groupMembers", { count: g.memberCount })} />
                </button>
              ))}
              {!people.length && !groups.length && <p className="px-2 py-1.5 text-sm text-fg-muted">{t("noMatches")}</p>}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-fg-muted">{agent.archived ? t("archived") : t("readOnly")}</p>
      )}

      <ul aria-label={t("list")} className="space-y-0.5">
        <Row
          avatar={
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-hover text-fg-muted">
              <Crown className="h-3.5 w-3.5" aria-hidden />
            </span>
          }
          label={<Label name={t("owners")} detail={t("ownersHint")} />}
          control={<span className="px-2 text-sm text-fg-muted">{t("levels.full")}</span>}
        />
        {sharing.entries.map((entry) =>
          entry.kind === "person" ? (
            <Row
              key={entry.userId}
              avatar={<UserAvatar name={entry.name} image={entry.image} size="md" colors="bg-accent/15 text-accent" />}
              label={<Label name={entry.name} detail={entry.email} />}
              control={control(entry.level, { kind: "person", userId: entry.userId }, entry.name)}
            />
          ) : entry.kind === "group" ? (
            <Row
              key={entry.groupId}
              avatar={<GroupAvatar />}
              label={<Label name={entry.name} detail={t("groupMembers", { count: entry.memberCount })} />}
              control={control(entry.level, { kind: "group", groupId: entry.groupId }, entry.name)}
            />
          ) : null,
        )}
      </ul>

      <div className="border-t border-border pt-3">
        <Row
          avatar={
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-hover text-fg-muted">
              <Users className="h-4 w-4" aria-hidden />
            </span>
          }
          label={<Label name={t("everyone")} detail={t("everyoneHint")} />}
          control={
            manages ? (
              <select
                value={everyone ?? "none"}
                aria-label={t("levelFor", { name: t("everyone") })}
                disabled={pending}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next === "none") void remove({ kind: "everyone" });
                  else void set({ kind: "everyone" }, next as AgentShareLevel);
                }}
                className={selectClassName}
              >
                {AGENT_SHARE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(`levels.${level}`)}
                  </option>
                ))}
                <option value="none">{t("levels.none")}</option>
              </select>
            ) : (
              <span className="px-2 text-sm text-fg-muted">{t(`levels.${everyone ?? "none"}`)}</span>
            )
          }
        />
      </div>
      <p className="text-xs text-fg-faint">{t("ownersKeep")}</p>
    </div>
  );
}

const selectClassName = "h-7 max-w-64 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none disabled:opacity-60";

function Row({ avatar, label, control }: { avatar: ReactNode; label: ReactNode; control: ReactNode }) {
  return (
    <li className="flex list-none items-center gap-2 py-1">
      {avatar}
      <div className="min-w-0 flex-1">{label}</div>
      <div className="shrink-0">{control}</div>
    </li>
  );
}

function Label({ name, detail }: { name: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm">{name}</div>
      {detail && (
        <div className="truncate text-xs text-fg-muted" title={detail}>
          {detail}
        </div>
      )}
    </div>
  );
}

function GroupAvatar() {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
      <UsersRound className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

function LevelSelect({
  value,
  name,
  disabled,
  onChange,
  onRemove,
}: {
  value: AgentShareLevel;
  /** Whose entry it is. */
  name: string;
  disabled: boolean;
  onChange: (level: AgentShareLevel) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("settings.agents.share");
  return (
    <div className="flex items-center gap-0.5">
      <select value={value} aria-label={t("levelFor", { name })} disabled={disabled} onChange={(e) => onChange(e.target.value as AgentShareLevel)} className={selectClassName}>
        {AGENT_SHARE_LEVELS.map((level) => (
          <option key={level} value={level}>
            {t(`levels.${level}`)}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label={t("remove", { name })}
        title={t("remove", { name })}
        disabled={disabled}
        onClick={onRemove}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-danger"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
