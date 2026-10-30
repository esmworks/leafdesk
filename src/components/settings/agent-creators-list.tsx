"use client";

import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { addAgentCreatorAction, agentCreatorsAction, removeAgentCreatorAction } from "@/app/actions/agents";
import type { ActionResult } from "@/app/actions/workspaces";
import { cn } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import type { AgentCreatorTarget, AgentCreatorsView } from "@/lib/agent-sharing";
import { GroupAvatar, Label, Row } from "./agent-share-tab";

/**
 * The members and groups who may create agents while the workspace's setting is "chosen" (owners
 * always may). Owners add and remove them; the list loads when the setting shows it.
 */
export function AgentCreatorsList({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("settings.agents.creation");
  const tc = useTranslations("common");
  const [view, setView] = useState<AgentCreatorsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    agentCreatorsAction(workspaceId)
      .then((res) => {
        if (!live) return;
        if (res.ok) setView(res.data);
        else setError(res.error);
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, tc]);

  const change = async (action: () => Promise<ActionResult<AgentCreatorsView>>) => {
    setPending(true);
    setError(null);
    try {
      const res = await action();
      if (res.ok) setView(res.data);
      else setError(res.error);
    } catch {
      setError(tc("genericError"));
    } finally {
      setPending(false);
    }
  };
  const add = (target: AgentCreatorTarget) => {
    setQuery("");
    void change(() => addAgentCreatorAction(workspaceId, target));
  };
  const remove = (target: AgentCreatorTarget) => void change(() => removeAgentCreatorAction(workspaceId, target));

  if (!view) {
    return (
      <p className="text-sm text-fg-muted" role={error ? "alert" : undefined}>
        {error ?? tc("loading")}
      </p>
    );
  }

  const listed = new Set(view.entries.map((e) => (e.kind === "person" ? e.userId : e.groupId)));
  const q = query.trim().toLowerCase();
  const people = q ? view.members.filter((m) => !listed.has(m.userId) && (m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))).slice(0, 8) : [];
  const groups = q ? view.groups.filter((g) => !listed.has(g.groupId) && g.name.toLowerCase().includes(q)).slice(0, 5) : [];
  const removeButton = (target: AgentCreatorTarget, name: string) => (
    <button
      type="button"
      aria-label={t("remove", { name })}
      title={t("remove", { name })}
      disabled={pending}
      onClick={() => remove(target)}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-danger"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <div className={cn("space-y-2", pending && "opacity-70")}>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
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
          <div className="mt-1 rounded-lg border border-border p-1">
            {people.map((m) => (
              <button
                key={m.userId}
                type="button"
                onClick={() => add({ kind: "person", userId: m.userId })}
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
                onClick={() => add({ kind: "group", groupId: g.groupId })}
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
      {view.entries.length ? (
        <ul aria-label={t("list")} className="space-y-0.5">
          {view.entries.map((entry) =>
            entry.kind === "person" ? (
              <Row
                key={entry.userId}
                avatar={<UserAvatar name={entry.name} image={entry.image} size="md" colors="bg-accent/15 text-accent" />}
                label={<Label name={entry.name} detail={entry.email} />}
                control={removeButton({ kind: "person", userId: entry.userId }, entry.name)}
              />
            ) : (
              <Row
                key={entry.groupId}
                avatar={<GroupAvatar />}
                label={<Label name={entry.name} detail={t("groupMembers", { count: entry.memberCount })} />}
                control={removeButton({ kind: "group", groupId: entry.groupId }, entry.name)}
              />
            ),
          )}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">{t("noneChosen")}</p>
      )}
    </div>
  );
}
